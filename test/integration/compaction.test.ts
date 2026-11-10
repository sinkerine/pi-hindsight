import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { digestIdFor } from "../../src/core/digest.js";
import { RECALL_CUSTOM_TYPE, STATE_ENTRY_TYPE } from "../../src/core/format.js";
import hindsightMemory from "../../src/index.js";
import { fakePi } from "../helpers/fake-pi.js";
import { mockHindsight } from "../helpers/mock-hindsight.js";

describe("automatic forget and compaction", () => {
  let server: Awaited<ReturnType<typeof mockHindsight>>;
  let root: string;
  const instances: ReturnType<typeof fakePi>[] = [];
  const digestId = digestIdFor("demo");
  function configure(override: object = {}) {
    writeFileSync(
      join(root, "hindsight-memory.json"),
      JSON.stringify({
        apiUrl: server.url,
        bankId: "test",
        project: "demo",
        recall: { timeoutMs: 200 },
        retain: { timeoutMs: 200, shutdownFlushMs: 40 },
        digest: { timeoutMs: 200 },
        ...override,
      }),
    );
  }
  async function start(branch?: ReturnType<typeof fakePi>["branch"]) {
    const pi = fakePi(root, branch);
    instances.push(pi);
    hindsightMemory(pi.api);
    await pi.emit("session_start", { reason: "startup" });
    return pi;
  }
  const injected = (pi: ReturnType<typeof fakePi>) =>
    pi.branch.filter(
      (e) => e.type === "custom_message" && e.customType === RECALL_CUSTOM_TYPE,
    ) as Array<{ content: string; details: Record<string, unknown> }>;
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "hindsight-compaction-"));
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

  it("creates a scheduled, project-scoped digest when the server has none", async () => {
    const pi = await start();
    await pi.prompt("How do we deploy this project?");
    const create = server
      .modelRequests()
      .find((request) => request.method === "POST");
    expect(create?.body).toMatchObject({
      id: digestId,
      tags: ["project:demo"],
      max_tokens: 800,
      trigger: {
        mode: "delta",
        refresh_cron: "0 3 * * *",
        full_refresh_cron: "0 3 * * 0",
        tags_match: "all_strict",
      },
    });
    expect(injected(pi)).toHaveLength(1);
    expect(injected(pi)[0]?.details.digest).toBeUndefined();
    expect(injected(pi)[0]?.content).not.toContain("hindsight_project_digest");
  });

  it("injects an existing digest once per branch with the first recall and again after compaction", async () => {
    server.model(digestId, "Deploys use make ship. <b>Never</b> force-push.");
    const pi = await start();
    await pi.prompt("How do we deploy this project?");
    const [first] = injected(pi);
    expect(first?.content).toContain("<hindsight_project_digest>");
    expect(first?.content).toContain("&lt;b&gt;Never&lt;/b&gt;");
    expect(first?.content).toContain("<hindsight_memory>");
    expect(first?.details).toMatchObject({
      reason: "first-prompt",
      digest: { id: digestId, refreshedAt: "2026-11-08T03:00:00Z" },
    });
    expect(server.modelRequests().map((r) => r.method)).toEqual(["GET"]);
    expect(server.modelRequests()[0]?.path).toContain("tags=project%3Ademo");
    server.hits([]);
    await pi.prompt("Remember our deployment conventions from last time");
    expect(injected(pi)).toHaveLength(1);
    const resumed = await start(pi.branch);
    await resumed.prompt("ok");
    expect(injected(resumed)).toHaveLength(1);
    await resumed.emit("session_compact");
    await resumed.prompt("ok");
    const latest = injected(resumed);
    expect(latest).toHaveLength(2);
    expect(latest[1]?.details).toMatchObject({ reason: "digest", ids: [] });
    expect(latest[1]?.content).not.toContain("<hindsight_memory>");
  });

  it("updates only the project digest and requests a full regeneration explicitly", async () => {
    server.model(digestId, "Old oversized digest");
    const pi = await start();
    await pi.command("digest refresh");
    const requests = server.modelRequests();
    expect(requests.find((r) => r.method === "PATCH")).toMatchObject({
      path: `/v1/default/banks/test/mental-models/${digestId}`,
      body: {
        max_tokens: 800,
        source_query: expect.stringContaining("compact checklist"),
        trigger: { mode: "delta" },
      },
    });
    expect(requests.find((r) => r.path.endsWith("/refresh"))).toMatchObject({
      body: { mode: "full" },
    });
    expect(server.requests.some((r) => r.path.endsWith("/config"))).toBe(false);
  });

  it("requests one bootstrap refresh for an empty digest with newer memories", async () => {
    server.model(digestId, "", "2026-11-08T03:00:00Z", true);
    const stale = await start();
    await stale.prompt("How do we deploy this project?");
    expect(
      server
        .modelRequests()
        .filter((r) => r.method === "POST")
        .map((r) => r.path),
    ).toEqual([`/v1/default/banks/test/mental-models/${digestId}/refresh`]);
    server.model(digestId, "", "2026-11-08T03:00:00Z", false);
    await (await start()).prompt("How do we deploy this project?");
    expect(
      server.modelRequests().filter((r) => r.method === "GET"),
    ).toHaveLength(2);
    expect(
      server.modelRequests().filter((r) => r.method === "POST"),
    ).toHaveLength(1);
  });

  it("respects a project restriction and pause for the digest", async () => {
    server.model(digestId, "Digest text");
    mkdirSync(join(root, ".pi"), { recursive: true });
    writeFileSync(
      join(root, ".pi", "hindsight-memory.json"),
      JSON.stringify({ digest: { enabled: false } }),
    );
    const restricted = await start();
    await restricted.prompt("How do we deploy this project?");
    expect(server.modelRequests()).toEqual([]);
    rmSync(join(root, ".pi"), { recursive: true });
    const paused = await start();
    await paused.command("pause");
    await paused.prompt("How do we deploy this project?");
    expect(injected(paused)).toHaveLength(0);
  });

  it("requests observation preference and collapses near-duplicate hits", async () => {
    server.hits([
      {
        id: "raw-1",
        type: "world",
        text: "Smart recall triggers on the first prompt, after compaction, on history cues, or on a topic shift.",
      },
      {
        id: "raw-2",
        type: "experience",
        text: "The assistant found that smart recall triggers on the first prompt, after compaction, on history cues, or on a topic shift.",
      },
      {
        id: "obs-1",
        type: "observation",
        text: "Deploys always use make ship.",
        source_fact_ids: ["raw-3"],
      },
      { id: "raw-3", type: "world", text: "We deploy using make ship." },
    ]);
    const pi = await start();
    await pi.prompt("How does smart recall decide when to run?");
    expect(server.recalls()[0]?.body.prefer_observations).toBe(true);
    expect(injected(pi)[0]?.details.ids).toEqual(["raw-2", "obs-1"]);
  });

  it("invalidates restated explicit facts after retaining and records them on the branch", async () => {
    server.hits([
      {
        id: "old-fact",
        type: "world",
        text: "Releases are tagged with semantic versions by the release script.",
        document_id: "pi:fact:0000000000000000",
        scores: { final: 0.8, reranker: 0.93 },
      },
      {
        id: "related",
        type: "world",
        text: "The release script runs in CI only.",
        document_id: "pi:fact:1111111111111111",
        scores: { final: 0.5, reranker: 0.7 },
      },
      {
        id: "transcript",
        type: "experience",
        text: "Releases are tagged with semantic versions by the release script.",
        document_id: "pi:session:0",
      },
    ]);
    const pi = await start();
    const result = await pi.tool("hindsight_retain", {
      content:
        "Releases are tagged with semantic versions by the release script",
    });
    expect(result.content[0]).toMatchObject({
      text: "Memory retained; invalidated 1 restated older fact(s).",
    });
    const lookup = server.recalls().at(-1)?.body;
    expect(lookup).toMatchObject({
      tags: ["project:demo", "kind:explicit"],
      tags_match: "all_strict",
      types: ["world", "experience"],
    });
    expect(server.patches()).toHaveLength(1);
    expect(server.patches()[0]).toMatchObject({
      path: "/v1/default/banks/test/memories/old-fact",
      body: {
        state: "invalidated",
        reason: expect.stringMatching(/^superseded-by:pi:fact:[a-f0-9]{16}$/),
      },
    });
    expect(
      pi.branch.find(
        (e) =>
          e.type === "custom" &&
          e.customType === STATE_ENTRY_TYPE &&
          "superseded" in (e.data as object),
      ),
    ).toMatchObject({ data: { superseded: { ids: ["old-fact"] } } });
  });

  it("keeps facts when supersession is restricted or the lookup fails", async () => {
    server.hits([
      {
        id: "old-fact",
        type: "world",
        text: "Releases are tagged with semantic versions.",
        document_id: "pi:fact:0000000000000000",
      },
    ]);
    mkdirSync(join(root, ".pi"), { recursive: true });
    writeFileSync(
      join(root, ".pi", "hindsight-memory.json"),
      JSON.stringify({ retain: { supersede: false } }),
    );
    const restricted = await start();
    await restricted.tool("hindsight_retain", {
      content: "Releases are tagged with semantic versions.",
    });
    expect(server.recalls()).toHaveLength(0);
    rmSync(join(root, ".pi"), { recursive: true });
    server.recallStatus(500);
    const failing = await start();
    const result = await failing.tool("hindsight_retain", {
      content: "Releases are tagged with semantic versions.",
    });
    expect(result.isError).not.toBe(true);
    expect(result.content[0]).toMatchObject({ text: "Memory retained." });
    expect(server.patches()).toHaveLength(0);
  });
});
