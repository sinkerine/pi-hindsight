import { afterEach, expect, it, vi } from "vitest";
import { CircuitBreaker } from "../../src/core/breaker.js";
import { HindsightError, type RetainParams } from "../../src/core/client.js";
import { segmentMessages } from "../../src/core/transcript.js";
import {
  type CheckpointRequest,
  CheckpointWriter,
  documentIdFor,
} from "../../src/core/writer.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const timestamp = "2026-11-08T00:00:00Z";
function request(text: string, sessionId = "session"): CheckpointRequest {
  return {
    sessionId,
    segments: segmentMessages([{ entryId: "a", timestamp, text }], 10),
    tags: ["harness:pi", "project:p", "session:session"],
    context: "Pi session",
    metadata: { harness: "pi", cwd: "/repo" },
    observationScopes: [["project:p"]],
  };
}
function setup() {
  const client = {
    retain: vi.fn(
      async (_p: RetainParams): Promise<{ operationId?: string }> => ({
        operationId: "op",
      }),
    ),
    deleteDocument: vi.fn(async (_id: string, _ms: number) => true),
  };
  const breaker = new CircuitBreaker();
  const sleep = vi.fn(async (_ms: number) => {});
  const onResult = vi.fn();
  let next = 0;
  const writer = new CheckpointWriter({
    client,
    breaker,
    sleep,
    timeoutMs: 5000,
    onResult,
    uuid: () => `op-${++next}`,
  });
  return { client, breaker, sleep, onResult, writer };
}
afterEach(() => vi.useRealTimers());
it("submits exact item fields and acknowledges only successful changed segments", async () => {
  const { writer, client, onResult } = setup();
  writer.submit(request("first"));
  await writer.flush(100);
  expect(writer.busy).toBe(false);
  expect(client.retain).toHaveBeenCalledWith({
    operationId: "op-1",
    timeoutMs: 5000,
    items: [
      {
        content: "first",
        documentId: "pi:session:0",
        context: "Pi session",
        tags: ["harness:pi", "project:p", "session:session"],
        metadata: { harness: "pi", cwd: "/repo", segment: "0" },
        timestamp,
        observationScopes: [["project:p"]],
      },
    ],
  });
  expect(writer.ackedHashes("session").get(0)).toBe(
    request("first").segments[0]?.hash,
  );
  writer.submit(request("first"));
  await writer.flush(100);
  expect(client.retain).toHaveBeenCalledTimes(1);
  expect(onResult).toHaveBeenLastCalledWith({ ok: true, sent: 0 });
  writer.submit(request("second"));
  await writer.flush(100);
  expect(client.retain).toHaveBeenCalledTimes(2);
  expect(documentIdFor("session", 2)).toBe("pi:session:2");
});
it("serializes in-flight writes and coalesces pending snapshots to the latest", async () => {
  const { writer, client } = setup();
  let release: () => void = () => {};
  const started = deferred<void>();
  client.retain.mockImplementationOnce(async () => {
    started.resolve();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return {};
  });
  writer.submit(request("first"));
  await started.promise;
  writer.submit(request("intermediate"));
  writer.submit(request("latest"));
  expect(client.retain).toHaveBeenCalledTimes(1);
  release();
  await writer.flush(100);
  expect(
    client.retain.mock.calls.map((call) => call[0].items[0]?.content),
  ).toEqual(["first", "latest"]);
});
it.each([
  new HindsightError("network", "network"),
  new HindsightError("timeout", "timeout"),
  new HindsightError("busy", "http", 429),
  new HindsightError("server", "http", 503),
])("retries transient %s with a stable operation id", async (error) => {
  const { writer, client, sleep } = setup();
  client.retain
    .mockRejectedValueOnce(error)
    .mockRejectedValueOnce(error)
    .mockResolvedValueOnce({});
  writer.submit(request("retry"));
  await writer.flush(100);
  expect(client.retain).toHaveBeenCalledTimes(3);
  expect(client.retain.mock.calls.map((call) => call[0].operationId)).toEqual([
    "op-1",
    "op-1",
    "op-1",
  ]);
  expect(sleep.mock.calls).toEqual([[500], [1500]]);
  expect(writer.ackedHashes("session").size).toBe(1);
});
it.each([
  new HindsightError("bad", "http", 400),
  new HindsightError("conflict", "http", 409),
  new HindsightError("invalid", "parse"),
])("does not retry permanent %s or acknowledge it", async (error) => {
  const { writer, client, sleep, onResult } = setup();
  client.retain.mockRejectedValue(error);
  writer.submit(request("failure"));
  await writer.flush(100);
  expect(client.retain).toHaveBeenCalledTimes(1);
  expect(sleep).not.toHaveBeenCalled();
  expect(writer.ackedHashes("session").size).toBe(0);
  expect(onResult).toHaveBeenCalledWith({ ok: false, sent: 0, error });
});
it("stops after two retries and can retry unchanged content at next checkpoint", async () => {
  const { writer, client, breaker } = setup();
  client.retain.mockRejectedValue(new HindsightError("server", "http", 500));
  writer.submit(request("failure"));
  await writer.flush(100);
  expect(client.retain).toHaveBeenCalledTimes(3);
  expect(breaker.consecutiveFailures).toBe(1);
  expect(writer.ackedHashes("session").size).toBe(0);
  client.retain.mockResolvedValue({});
  writer.submit(request("failure"));
  await writer.flush(100);
  expect(writer.ackedHashes("session").size).toBe(1);
  expect(breaker.consecutiveFailures).toBe(0);
});
it("deletes orphaned higher segments after branch rewrite, keeping failed deletes acknowledged for retry", async () => {
  const { writer, client } = setup();
  writer.submit(request("abcdefghijklmnop"));
  await writer.flush(100);
  expect(writer.ackedHashes("session").size).toBe(2);
  client.deleteDocument.mockRejectedValueOnce(
    new HindsightError("bad", "http", 400),
  );
  writer.submit(request("short"));
  await writer.flush(100);
  expect(writer.ackedHashes("session").size).toBe(2);
  writer.submit(request("short"));
  await writer.flush(100);
  expect(client.deleteDocument).toHaveBeenLastCalledWith("pi:session:1", 5000);
  expect(writer.ackedHashes("session").size).toBe(1);
  writer.submit({ ...request(""), segments: [] });
  await writer.flush(100);
  expect(writer.ackedHashes("session").size).toBe(0);
});
it("retains per-session acknowledgements and returns a defensive map", async () => {
  const { writer, client } = setup();
  writer.submit(request("same", "one"));
  await writer.flush(100);
  writer.submit(request("same", "two"));
  await writer.flush(100);
  expect(client.retain).toHaveBeenCalledTimes(2);
  const copy = writer.ackedHashes("one") as Map<number, string>;
  copy.clear();
  expect(writer.ackedHashes("one").size).toBe(1);
});
it("skips writes while breaker is open and permits a later snapshot after cooldown", async () => {
  let now = 0;
  const { client } = setup();
  const breaker = new CircuitBreaker({
    threshold: 1,
    cooldownMs: 10,
    now: () => now,
  });
  breaker.recordFailure();
  const writer = new CheckpointWriter({ client, breaker, timeoutMs: 10 });
  writer.submit(request("pending"));
  await writer.flush(100);
  expect(client.retain).not.toHaveBeenCalled();
  now = 10;
  writer.submit(request("pending"));
  await writer.flush(100);
  expect(client.retain).toHaveBeenCalledTimes(1);
});
it("flush returns at its bound while delivery remains in flight", async () => {
  vi.useFakeTimers();
  const { writer, client } = setup();
  const pending = deferred<{ operationId: string }>();
  client.retain.mockReturnValueOnce(pending.promise);
  writer.submit(request("slow"));
  await Promise.resolve();
  let completed = false;
  const flush = writer.flush(30).then(() => {
    completed = true;
  });
  await vi.advanceTimersByTimeAsync(29);
  expect(completed).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await flush;
  expect(writer.busy).toBe(true);
  expect(writer.ackedHashes("session").size).toBe(0);
  pending.resolve({ operationId: "done" });
  await writer.flush(100);
  expect(writer.busy).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});
it("handles consecutive synchronous no-op submissions and ignores notification exceptions", async () => {
  const { client, breaker } = setup();
  const writer = new CheckpointWriter({
    client,
    breaker,
    timeoutMs: 10,
    onResult: () => {
      throw Error("UI");
    },
  });
  writer.submit({ ...request(""), segments: [] });
  writer.submit(request("new"));
  await writer.flush(100);
  expect(client.retain).toHaveBeenCalledTimes(1);
  writer.submit(request("new"));
  await writer.flush(100);
  writer.submit(request("later"));
  await writer.flush(100);
  expect(client.retain).toHaveBeenCalledTimes(2);
});
