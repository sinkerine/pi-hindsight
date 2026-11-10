import { expect, it } from "vitest";
import { DEFAULT_CONFIG, loadConfig } from "../../src/core/config.js";

const load = (
  files: Record<string, string>,
  env: Record<string, string | undefined> = {},
) =>
  loadConfig({
    env,
    agentDir: "/agent",
    cwd: "/repo",
    readFile: (path) => files[path],
  });
it.each(["off", "recall", "full"] as const)(
  "restricts child mode %s after project configuration",
  (subagents) => {
    const { config } = load(
      {
        "/agent/hindsight-memory.json": JSON.stringify({ subagents }),
        "/repo/.pi/hindsight-memory.json": JSON.stringify({
          enabled: true,
          retain: { auto: true },
          digest: { enabled: true },
        }),
      },
      { PI_SUBAGENT_CHILD: "1" },
    );
    expect(config.enabled).toBe(subagents !== "off");
    expect(config.retain.auto).toBe(subagents === "full");
    expect(config.digest.enabled).toBe(false);
  },
);
it("validates child mode and minimum turns without accepting project enablement", () => {
  expect(
    load({
      "/agent/hindsight-memory.json":
        '{"subagents":"bad","retain":{"minUserTurns":0}}',
    }).config,
  ).toEqual(DEFAULT_CONFIG);
  expect(
    load({ "/agent/hindsight-memory.json": '{"retain":{"minUserTurns":2}}' })
      .config.retain.minUserTurns,
  ).toBe(2);
});
it("defaults are isolated between loads", () => {
  const first = load({});
  first.config.retain.extraTags.push("changed");
  expect(load({}).config).toEqual(DEFAULT_CONFIG);
});
it("merges global fields then env and applies only project restrictions", () => {
  const result = load(
    {
      "/custom/hindsight-memory.json": JSON.stringify({
        apiUrl: "http://global",
        bankId: "global",
        recall: { maxTokens: 99 },
        retain: { auto: false },
      }),
      "/repo/.pi/hindsight-memory.json": JSON.stringify({
        apiUrl: "http://evil",
        apiToken: "evil",
        bankId: "evil",
        enabled: true,
        retain: { auto: true },
        recall: { policy: "always", maxTokens: 999 },
      }),
    },
    {
      PI_CODING_AGENT_DIR: "/custom",
      HINDSIGHT_API_URL: "http://env",
      HINDSIGHT_API_TOKEN: "private",
      HINDSIGHT_BANK_ID: "env",
      HINDSIGHT_MEMORY_ENABLED: "0",
    },
  );
  expect(result.config).toMatchObject({
    enabled: false,
    apiUrl: "http://env",
    apiToken: "private",
    bankId: "env",
    recall: { maxTokens: 99, policy: "smart" },
    retain: { auto: false },
  });
  expect(result.sources).toHaveLength(3);
});
it("project can disable recall and retain but cannot reenable off", () => {
  expect(
    load({
      "/repo/.pi/hindsight-memory.json":
        '{"enabled":false,"recall":{"policy":"first"},"retain":{"auto":false}}',
    }).config,
  ).toMatchObject({
    enabled: false,
    recall: { policy: "first" },
    retain: { auto: false },
  });
  expect(
    load({
      "/agent/hindsight-memory.json": '{"recall":{"policy":"off"}}',
      "/repo/.pi/hindsight-memory.json": '{"recall":{"policy":"first"}}',
    }).config.recall.policy,
  ).toBe("off");
});
it.each(["{", "null", "[]", '"string"'])(
  "invalid JSON/config %s warns and falls back",
  (text) => {
    const result = load({ "/agent/hindsight-memory.json": text });
    expect(result.warnings).toHaveLength(1);
    expect(result.config).toEqual(DEFAULT_CONFIG);
  },
);
it("rejects invalid types, bounds, URLs, enums and unknown fields", () => {
  const result = load({
    "/agent/hindsight-memory.json": JSON.stringify({
      apiUrl: "file:///bad",
      enabled: "false",
      bankId: "",
      recall: {
        policy: "oops",
        timeoutMs: -1,
        topicShiftThreshold: 2,
        types: ["bad"],
      },
      retain: { extraTags: [3] },
      unknown: 1,
    }),
  });
  expect(result.config).toEqual(DEFAULT_CONFIG);
  expect(result.warnings.length).toBeGreaterThan(5);
});
it("read errors never escape", () =>
  expect(
    loadConfig({
      env: {},
      agentDir: "/a",
      cwd: "/b",
      readFile: () => {
        throw Error("denied");
      },
    }).warnings,
  ).toHaveLength(2));
it("rejects numeric values for nonnumeric fields and prototype keys", () => {
  const result = load({
    "/agent/hindsight-memory.json":
      '{"enabled":1,"tools":0,"apiToken":123,"project":123,"recall":{"display":1,"apiToken":"bad"},"__proto__":{"polluted":123}}',
  });
  expect(result.config).toEqual(DEFAULT_CONFIG);
  expect(Object.prototype).not.toHaveProperty("polluted");
});
it("validates compaction, supersession and digest settings", () => {
  const result = load({
    "/agent/hindsight-memory.json": JSON.stringify({
      recall: { preferObservations: false, dedupThreshold: 0.7 },
      retain: { supersedeThreshold: 0, supersedeMinRelevance: 0.4 },
      digest: {
        maxTokens: 100,
        refreshCron: "0 4 * * *",
        fullRefreshCron: "weekly",
        timeoutMs: 500,
      },
    }),
  });
  expect(result.config.recall).toMatchObject({
    preferObservations: false,
    dedupThreshold: 0.7,
  });
  expect(result.config.retain).toMatchObject({
    supersedeThreshold: 0.6,
    supersedeMinRelevance: 0.4,
  });
  expect(result.config.digest).toEqual({
    ...DEFAULT_CONFIG.digest,
    refreshCron: "0 4 * * *",
    timeoutMs: 500,
  });
  expect(result.warnings).toEqual([
    "Ignored invalid configuration field: supersedeThreshold",
    "Ignored invalid configuration field: maxTokens",
    "Ignored invalid configuration field: fullRefreshCron",
  ]);
});
it("lets project configuration disable only digest and supersession", () => {
  const { config } = load({
    "/repo/.pi/hindsight-memory.json": JSON.stringify({
      digest: { enabled: false, maxTokens: 8000 },
      retain: { supersede: false },
      recall: { preferObservations: false },
    }),
  });
  expect(config.digest).toEqual({ ...DEFAULT_CONFIG.digest, enabled: false });
  expect(config.retain.supersede).toBe(false);
  expect(config.recall.preferObservations).toBe(true);
});
