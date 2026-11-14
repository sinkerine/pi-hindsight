import { expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../src/core/config.js";
import { digestIdFor, digestSpec, isCron } from "../../src/core/digest.js";

it("derives stable, valid mental model ids per project", () => {
  const id = digestIdFor("Pi Hindsight/Worktree");
  expect(id).toMatch(/^pi-digest-pi-hindsight-worktree-[a-f0-9]{8}$/);
  expect(digestIdFor("Pi Hindsight/Worktree")).toBe(id);
  expect(digestIdFor("pi-hindsight-worktree")).not.toBe(id);
  expect(digestIdFor("日本語")).toMatch(/^pi-digest-[a-f0-9]{8}$/);
  expect(digestIdFor("x".repeat(100)).length).toBeLessThanOrEqual(59);
});
it("builds a project-scoped delta digest with server-side schedules", () => {
  expect(digestSpec("demo", DEFAULT_CONFIG.digest)).toMatchObject({
    name: "Pi project digest: demo",
    tags: ["project:demo"],
    maxTokens: 800,
    trigger: {
      mode: "delta",
      refreshCron: "0 3 * * *",
      fullRefreshCron: "0 3 * * 0",
      tagsMatch: "all_strict",
    },
  });
});
it.each([256, 800, 2048])(
  "uses the configured %i-token budget in both the query and request",
  (maxTokens) => {
    const spec = digestSpec("demo", { ...DEFAULT_CONFIG.digest, maxTokens });
    expect(spec.maxTokens).toBe(maxTokens);
    expect(spec.sourceQuery).toContain(`within ${maxTokens} tokens`);
    if (maxTokens !== 800) expect(spec.sourceQuery).not.toContain("800 tokens");
  },
);
it("accepts only five-field cron expressions", () => {
  expect(isCron("*/15 3 * * 1-5")).toBe(true);
  expect(isCron("0 3 * *")).toBe(false);
  expect(isCron("0 3 * * * *")).toBe(false);
  expect(isCron("0 3 * * MON")).toBe(false);
  expect(isCron("0 3 * * 0; rm")).toBe(false);
});
