import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RECALL_CUSTOM_TYPE, STATE_ENTRY_TYPE } from "../../src/core/format.js";
import hindsightMemory from "../../src/index.js";
import { fakePi } from "../helpers/fake-pi.js";
import { mockHindsight } from "../helpers/mock-hindsight.js";

describe("hindsightMemory extension with real HTTP", () => {
  let server: Awaited<ReturnType<typeof mockHindsight>>;
  let root: string;
  const instances: ReturnType<typeof fakePi>[] = [];
  function configure(override: object = {}) {
    writeFileSync(
      join(root, "hindsight-memory.json"),
      JSON.stringify({
        apiUrl: server.url,
        bankId: "test",
        project: "demo",
        recall: { timeoutMs: 60 },
        retain: { timeoutMs: 120, shutdownFlushMs: 40 },
        ...override,
      }),
    );
  }
  async function start(
    branch?: ReturnType<typeof fakePi>["branch"],
    reason = "startup",
    sessionId?: string,
  ) {
    const pi = fakePi(root, branch, sessionId);
    instances.push(pi);
    hindsightMemory(pi.api);
    await pi.emit("session_start", { reason });
    return pi;
  }
  async function settle(pi: ReturnType<typeof fakePi>) {
    await pi.emit("agent_settled");
    await pi.command("checkpoint");
  }
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "hindsight-integration-"));
    server = await mockHindsight();
    vi.stubEnv("PI_CODING_AGENT_DIR", root);
    vi.stubEnv("HINDSIGHT_API_URL", server.url);
    vi.stubEnv("HINDSIGHT_BANK_ID", "test");
    vi.stubEnv("HINDSIGHT_MEMORY_ENABLED", "1");
    configure();
  });
  afterEach(async () => {
    for (const pi of instances.splice(0)) await pi.emit("session_shutdown");
    await server.close();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it("registers tools without network work in the factory", () => {
    const pi = fakePi(root);
    hindsightMemory(pi.api);
    expect([...pi.tools.keys()]).toEqual([
      "hindsight_recall",
      "hindsight_retain",
    ]);
    expect(server.requests).toEqual([]);
  });

  it("injects exactly one auditable custom message after the user and deduplicates later hits", async () => {
    const pi = await start();
    await pi.prompt("How do we deploy this project?");
    const custom = pi.branch.filter((e) => e.type === "custom_message");
    expect(custom).toHaveLength(1);
    expect(custom[0]).toMatchObject({
      customType: RECALL_CUSTOM_TYPE,
      details: { reason: "first-prompt", ids: ["memory-1"] },
    });
    expect(pi.branch.at(-2)).toMatchObject({
      type: "message",
      message: { role: "user" },
    });
    expect(server.recalls()[0]?.body).toMatchObject({
      tags: ["project:demo"],
      tags_match: "any",
      budget: "low",
      max_tokens: 1024,
    });
    await pi.prompt("Remember our deployment conventions from last time");
    expect(server.recalls()).toHaveLength(2);
    expect(pi.branch.filter((e) => e.type === "custom_message")).toHaveLength(
      1,
    );
  });

  it("skips acknowledgements, short prompts, and custom-triggered runs", async () => {
    const pi = await start();
    for (const prompt of ["ok", "yes", "continue", "thanks", "small"])
      await pi.prompt(prompt);
    await pi.emit("before_agent_start", {
      messageType: "custom",
      message: { content: "Recall our previous deployment conventions" },
    });
    expect(server.recalls()).toHaveLength(0);
  });

  it("persists successful empty recalls without model messages and respects first policy on resume", async () => {
    configure({ recall: { policy: "first" } });
    server.hits([]);
    const pi = await start();
    await pi.prompt("How do we deploy this project?");
    expect(pi.branch.filter((e) => e.type === "custom_message")).toHaveLength(
      0,
    );
    expect(
      pi.branch.some(
        (e) => e.type === "custom" && e.customType === STATE_ENTRY_TYPE,
      ),
    ).toBe(true);
    await pi.emit("session_shutdown");
    const resumed = await start(pi.branch, "resume");
    await resumed.prompt("Explain the deployment steps in detail");
    expect(server.recalls()).toHaveLength(1);
  });

  it("recalls after compaction and reconstructs the branch after tree navigation", async () => {
    const pi = await start();
    await pi.prompt("How do we deploy this project?");
    await pi.prompt("How do we deploy this project?");
    expect(server.recalls()).toHaveLength(1);
    await pi.emit("session_compact");
    await pi.prompt("How do we deploy this project?");
    expect(server.recalls()).toHaveLength(2);
    pi.branch.splice(0);
    await pi.emit("session_tree");
    await pi.prompt("How do we deploy this project?");
    expect(pi.branch.at(-1)).toMatchObject({
      type: "custom_message",
      details: { reason: "first-prompt" },
    });
  });

  it("fails open within the recall timeout and warns only once", async () => {
    server.hangRecall();
    const pi = await start();
    const started = Date.now();
    await expect(
      pi.prompt("How do we deploy this project?"),
    ).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(350);
    await pi.prompt("How do we deploy this project?");
    expect(
      pi.notices.filter((n) => n.includes("recall unavailable")),
    ).toHaveLength(1);
    expect(pi.branch.filter((e) => e.type === "custom_message")).toHaveLength(
      0,
    );
  });

  it("keeps recall failures across empty and unchanged settled checkpoints", async () => {
    const pi = await start();
    server.recallStatus(500);
    await pi.tool("hindsight_recall", { query: "deployment history" });
    await settle(pi);
    await pi.command("status");
    expect(pi.notices.at(-1)).toContain("retain: none");
    expect(server.retains()).toHaveLength(0);

    pi.user("A durable deployment fact to checkpoint once.");
    await settle(pi);
    expect(server.retains()).toHaveLength(1);
    for (let i = 0; i < 3; i++) {
      await pi.tool("hindsight_recall", { query: "deployment history" });
      await settle(pi);
    }
    await pi.tool("hindsight_recall", { query: "deployment history" });
    expect(server.recalls()).toHaveLength(4);
    expect(server.retains()).toHaveLength(1);
    await pi.command("status");
    expect(pi.notices.at(-1)).toContain("breaker: open");
    expect(pi.notices.at(-1)).toContain("retain: saved 1 segment(s)");
  });

  it("opens the breaker after three HTTP failures", async () => {
    server.recallStatus(500);
    const pi = await start();
    for (let i = 0; i < 4; i++)
      await pi.prompt("How do we deploy this project?");
    expect(server.recalls()).toHaveLength(3);
    await pi.command("status");
    expect(pi.notices.at(-1)).toContain("breaker: open");
    await pi.emit("agent_settled");
    expect(server.retains()).toHaveLength(0);
  });

  it("retains only changed segments with redaction, stable ids, async UUIDs, and project scope", async () => {
    configure({
      retain: { segmentChars: 150, timeoutMs: 120, shutdownFlushMs: 80 },
    });
    const pi = await start();
    pi.user(
      "Our api key is sk-test-ABCDEFGHIJKLMNOPQRSTUV and deploy with make ship.",
    );
    await settle(pi);
    expect(server.retains()).toHaveLength(1);
    const request = server.retains()[0]?.body;
    expect(request).toMatchObject({
      async: true,
      operation_id: expect.stringMatching(/^[a-f0-9-]{36}$/),
      items: [
        {
          document_id: "pi:session-test:0",
          tags: ["harness:pi", "project:demo", "session:session-test"],
          observation_scopes: [["project:demo"]],
        },
      ],
    });
    expect(JSON.stringify(request)).toContain("[REDACTED:");
    expect(JSON.stringify(request)).not.toContain("sk-test-");
    await settle(pi);
    expect(server.retains()).toHaveLength(1);
    pi.user(
      "We always deploy only after the tests have passed and the release has been approved.",
    );
    await settle(pi);
    expect(server.retains()).toHaveLength(2);
    expect(server.retains()[1]?.body).toMatchObject({
      items: [{ document_id: "pi:session-test:1" }],
    });
  });

  it("bounds shutdown, aborts pending work and is idempotent", async () => {
    configure({
      retain: { segmentChars: 50, timeoutMs: 1000, shutdownFlushMs: 35 },
    });
    server.hangRetain();
    const pi = await start();
    pi.user(
      "A deployment fact sufficiently long to span more than one small segment in the checkpoint.",
    );
    await pi.emit("agent_settled");
    await vi.waitFor(() => expect(server.retains()).toHaveLength(1));
    const started = Date.now();
    await pi.emit("session_shutdown");
    expect(Date.now() - started).toBeLessThan(200);
    await pi.emit("session_shutdown");
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(server.retains()).toHaveLength(1);
    expect(pi.statuses.at(-1)).toBeUndefined();
  });

  it("checkpoints at shutdown even without a settled event", async () => {
    const pi = await start();
    pi.user("Retain the final prompt at shutdown.");
    await pi.emit("session_shutdown");
    expect(server.retains()).toHaveLength(1);
    await pi.emit("session_shutdown");
    expect(server.retains()).toHaveLength(1);
  });

  it("excludes inherited fork entries on both fork and subsequent resume", async () => {
    const parent = fakePi(root);
    parent.user("PARENT_PREFIX must not be retained in the fork.");
    const fork = await start(parent.branch, "fork", "fork-id");
    fork.user("CHILD_ONLY is a new fact.");
    await settle(fork);
    await fork.emit("session_shutdown");
    const resumed = await start(fork.branch, "resume", "fork-id");
    resumed.user("RESUMED_CHILD has another fact.");
    await settle(resumed);
    expect(server.retains()).toHaveLength(2);
    for (const request of server.retains()) {
      expect(JSON.stringify(request.body)).not.toContain("PARENT_PREFIX");
      expect(JSON.stringify(request.body)).toContain("CHILD_ONLY");
    }
  });

  it("preserves the fork baseline when navigating before its state entry", async () => {
    const parent = fakePi(root);
    parent.user("PARENT_PREFIX must never be retained by this fork.");
    const fork = await start(parent.branch, "fork", "fork-id");
    fork.user("Abandoned child branch fact.");
    fork.branch.splice(1);
    await fork.emit("session_tree");
    await settle(fork);
    expect(server.retains()).toHaveLength(0);
    fork.user("NEW_CHILD fact on the branch before the baseline state entry.");
    await settle(fork);
    expect(server.retains()).toHaveLength(1);
    expect(JSON.stringify(server.retains()[0]?.body)).toContain("NEW_CHILD");
    expect(JSON.stringify(server.retains()[0]?.body)).not.toContain(
      "PARENT_PREFIX",
    );
  });

  it("persists pause and resume and keeps manual recall display-only", async () => {
    const pi = await start();
    await pi.command("pause");
    await pi.prompt("Remember our deployment conventions from last time");
    await settle(pi);
    expect(server.requests).toHaveLength(0);
    await pi.emit("session_tree");
    await pi.prompt("Remember our deployment conventions from last time");
    expect(server.requests).toHaveLength(0);
    await pi.command("recall deployment history");
    expect(server.recalls()).toHaveLength(1);
    expect(pi.notices.some((n) => n.includes("ZEBRA-42"))).toBe(true);
    expect(pi.branch.filter((e) => e.type === "custom_message")).toHaveLength(
      0,
    );
    await pi.command("resume");
    await pi.prompt("Remember our deployment conventions from last time");
    expect(server.recalls()).toHaveLength(2);
    await settle(pi);
    expect(server.retains()).toHaveLength(1);
  });

  it("tools return scoped hits, persist dedupe ids, redact facts and report failure", async () => {
    const pi = await start();
    const result = await pi.tool("hindsight_recall", {
      query: "deployment history",
      max_tokens: 42,
    });
    expect(result.content).toMatchObject([
      { text: expect.stringContaining("ZEBRA-42") },
    ]);
    expect(server.recalls()[0]?.body.max_tokens).toBe(42);
    await pi.emit("session_tree");
    await pi.prompt("Remember our deployment conventions from last time");
    expect(pi.branch.filter((e) => e.type === "custom_message")).toHaveLength(
      0,
    );
    const retained = await pi.tool("hindsight_retain", {
      content: "Our api key is sk-test-ABCDEFGHIJKLMNOPQRSTUV",
    });
    expect(retained.isError).not.toBe(true);
    const body = server.retains()[0]?.body;
    expect(body).toMatchObject({
      items: [
        {
          document_id: expect.stringMatching(/^pi:fact:[a-f0-9]{16}$/),
          tags: expect.arrayContaining(["kind:explicit"]),
          content: expect.stringContaining("[REDACTED:"),
        },
      ],
    });
    server.recallStatus(500);
    expect(
      (await pi.tool("hindsight_recall", { query: "bad request" })).isError,
    ).toBe(true);
  });

  it("forget confirms, cancels in-flight and queued checkpoints, deletes all known segments, and pauses", async () => {
    configure({
      retain: { segmentChars: 60, timeoutMs: 1000, shutdownFlushMs: 40 },
    });
    const pi = await start();
    pi.user(
      "First deployment fact with enough content to span several of our tiny segments here.",
    );
    await settle(pi);
    const before = server.retains().length;
    expect(before).toBeGreaterThan(1);
    pi.confirm(false);
    await pi.command("forget");
    expect(server.deletes()).toHaveLength(0);
    server.hangRetain();
    pi.user(
      "Second deployment fact to be canceled while it is in flight and queued.",
    );
    await pi.emit("agent_settled");
    await vi.waitFor(() =>
      expect(server.retains().length).toBeGreaterThan(before),
    );
    pi.user(
      "Third deployment fact queued after the pending in-flight checkpoint.",
    );
    await pi.emit("agent_settled");
    pi.confirm(true);
    await pi.command("forget");
    expect(server.deletes().length).toBeGreaterThanOrEqual(before);
    const count = server.retains().length;
    await pi.emit("agent_settled");
    await pi.emit("session_shutdown");
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(server.retains()).toHaveLength(count);
    expect(pi.branch.at(-1)).toMatchObject({
      type: "custom",
      data: { paused: true },
    });
  });

  it("cancels a retry backoff during shutdown without another request", async () => {
    server.retainStatus(500);
    const pi = await start();
    pi.user("A durable deployment fact for the retrying checkpoint.");
    await pi.emit("agent_settled");
    await vi.waitFor(() => expect(server.retains()).toHaveLength(1));
    await pi.emit("session_shutdown");
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(server.retains()).toHaveLength(1);
  });

  it("resume after forget explicitly re-enables fresh checkpoint delivery", async () => {
    const pi = await start();
    pi.user("A durable deployment fact.");
    await settle(pi);
    await pi.command("forget");
    expect(server.deletes()).toHaveLength(1);
    expect(pi.notices.at(-1)).toContain("paused");
    expect(pi.notices.at(-1)).toContain("retain: none");
    const count = server.retains().length;
    await pi.command("resume");
    pi.user("A second durable deployment fact.");
    await settle(pi);
    expect(server.retains()).toHaveLength(count + 1);
  });

  it("does not retain recall injections and honors ephemeral retention opt-out", async () => {
    const pi = await start();
    await pi.prompt("How do we deploy this project?");
    await settle(pi);
    const stored = JSON.stringify(server.retains()[0]?.body);
    expect(stored).not.toContain("ZEBRA-42");
    expect(stored).not.toContain("hindsight_memory");
    await pi.emit("session_shutdown");
    configure({ retain: { ephemeral: false } });
    const ephemeral = await start();
    ephemeral.ephemeral(true);
    ephemeral.user("This ephemeral fact must not be retained.");
    const count = server.retains().length;
    await settle(ephemeral);
    await ephemeral.emit("session_shutdown");
    expect(server.retains()).toHaveLength(count);
  });

  it("disabled configuration blocks tools and automatic work", async () => {
    configure({ enabled: false });
    const pi = await start();
    await pi.prompt("Remember our deployment conventions from last time");
    await settle(pi);
    expect(
      (await pi.tool("hindsight_recall", { query: "deployment" })).isError,
    ).toBe(true);
    expect(
      (await pi.tool("hindsight_retain", { content: "deployment" })).isError,
    ).toBe(true);
    expect(server.requests).toHaveLength(0);
  });
});
