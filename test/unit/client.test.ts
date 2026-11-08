import { expect, it, vi } from "vitest";
import {
  HindsightClient,
  HindsightError,
  type RecallParams,
} from "../../src/core/client.js";

const params: RecallParams = {
  query: "deploy",
  budget: "low",
  maxTokens: 1024,
  tags: ["project:example"],
  tagsMatch: "any",
  types: ["world"],
  timeoutMs: 100,
};
function setup(response: () => Promise<Response>) {
  const fetcher = vi.fn<typeof fetch>(response);
  return {
    fetcher,
    client: new HindsightClient({
      apiUrl: "http://localhost:8888/",
      bankId: "bank/one",
      apiToken: "private-token",
      fetch: fetcher,
    }),
  };
}
it("serializes recall fields, scopes, auth and path; maps hits", async () => {
  const { client, fetcher } = setup(async () =>
    Response.json({
      results: [
        {
          id: "a",
          text: "Deploy with make ship",
          type: "world",
          context: null,
          document_id: "doc",
          mentioned_at: "2026-01-01",
          tags: ["one"],
        },
      ],
    }),
  );
  expect(await client.recall(params)).toEqual([
    {
      id: "a",
      text: "Deploy with make ship",
      type: "world",
      context: null,
      documentId: "doc",
      mentionedAt: "2026-01-01",
      tags: ["one"],
    },
  ]);
  const [url, init] = fetcher.mock.calls[0] ?? [];
  expect(url).toBe(
    "http://localhost:8888/v1/default/banks/bank%2Fone/memories/recall",
  );
  expect(init?.method).toBe("POST");
  expect(init?.headers).toEqual({
    "Content-Type": "application/json",
    Authorization: "Bearer private-token",
  });
  expect(init?.signal).toBeInstanceOf(AbortSignal);
  expect(JSON.parse(String(init?.body))).toEqual({
    query: "deploy",
    budget: "low",
    max_tokens: 1024,
    tags: ["project:example"],
    tags_match: "any",
    types: ["world"],
  });
});
it("sends async retain with caller operation id and snake-case item fields", async () => {
  const { client, fetcher } = setup(async () =>
    Response.json({ operation_id: "op" }),
  );
  expect(
    await client.retain({
      operationId: "op",
      timeoutMs: 100,
      items: [
        {
          content: "text",
          documentId: "pi:s:0",
          context: "context",
          tags: ["tag"],
          metadata: { segment: "0" },
          timestamp: "2026-01-01",
          observationScopes: [["project:p"]],
        },
      ],
    }),
  ).toEqual({ operationId: "op" });
  expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
    async: true,
    operation_id: "op",
    items: [
      {
        content: "text",
        document_id: "pi:s:0",
        context: "context",
        tags: ["tag"],
        metadata: { segment: "0" },
        timestamp: "2026-01-01",
        observation_scopes: [["project:p"]],
      },
    ],
  });
});
it("404 is empty recall or absent document; deletion accepts 204", async () => {
  const { client, fetcher } = setup(
    async () => new Response(null, { status: 404 }),
  );
  expect(await client.recall(params)).toEqual([]);
  expect(await client.deleteDocument("pi:s/0", 100)).toBe(false);
  expect(fetcher.mock.calls[1]?.[0]).toContain("/documents/pi%3As%2F0");
  fetcher.mockResolvedValue(new Response(null, { status: 204 }));
  expect(await client.deleteDocument("pi:s:0", 100)).toBe(true);
});
it.each([
  [400, false],
  [401, false],
  [409, false],
  [429, true],
  [500, true],
  [503, true],
])("HTTP %s retryability is %s", async (status, retryable) => {
  const { client } = setup(
    async () => new Response("token must never appear in error", { status }),
  );
  try {
    await client.recall(params);
    throw Error("expected failure");
  } catch (error) {
    expect(error).toBeInstanceOf(HindsightError);
    expect(error).toMatchObject({ kind: "http", status, retryable });
    expect(String(error)).not.toContain("token must");
  }
});
it.each(["not-json", "null", "{}", '{"results":[{}]}'])(
  "rejects malformed recall response %s as parse error",
  async (text) => {
    const { client } = setup(async () => new Response(text));
    await expect(client.recall(params)).rejects.toMatchObject({
      kind: "parse",
      retryable: false,
    });
  },
);
it("classifies network failures without leaking exception contents", async () => {
  const { client } = setup(async () => {
    throw Error("private-token");
  });
  await expect(client.recall(params)).rejects.toMatchObject({
    kind: "network",
    retryable: true,
    message: "Hindsight network request failed",
  });
  expect(await client.health(10)).toEqual({ ok: false });
});
it("aborts stalled fetch at deadline and supports external cancellation", async () => {
  const fetcher = vi.fn<typeof fetch>(
    async (_url, init) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) reject(signal.reason);
        else
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
      }),
  );
  const client = new HindsightClient({
    apiUrl: "http://example",
    bankId: "pi",
    fetch: fetcher,
  });
  await expect(
    client.recall({ ...params, timeoutMs: 10 }),
  ).rejects.toMatchObject({ kind: "timeout" });
  const controller = new AbortController();
  controller.abort();
  await expect(
    client.recall({ ...params, signal: controller.signal }),
  ).rejects.toMatchObject({ kind: "network" });
});
it("health includes optional version and tolerates unavailable version endpoint", async () => {
  const { client, fetcher } = setup(async () =>
    Response.json({ status: "healthy" }),
  );
  fetcher
    .mockResolvedValueOnce(Response.json({ status: "healthy" }))
    .mockResolvedValueOnce(Response.json({ api_version: "1.1.0" }));
  expect(await client.health(100)).toEqual({ ok: true, apiVersion: "1.1.0" });
  fetcher
    .mockResolvedValueOnce(Response.json({ status: "healthy" }))
    .mockResolvedValueOnce(new Response(null, { status: 404 }));
  expect(await client.health(100)).toEqual({ ok: true });
});
it("omits auth when not configured and makes no fetch in constructor", async () => {
  const fetcher = vi.fn<typeof fetch>(async () =>
    Response.json({ results: [] }),
  );
  const client = new HindsightClient({
    apiUrl: "http://example",
    bankId: "pi",
    fetch: fetcher,
  });
  expect(fetcher).not.toHaveBeenCalled();
  await client.recall(params);
  expect(fetcher.mock.calls[0]?.[1]?.headers).not.toHaveProperty(
    "Authorization",
  );
});
