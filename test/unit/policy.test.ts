import { describe, expect, it } from "vitest";
import {
  boundQuery,
  cleanRecallPrompt,
  contentWords,
  decideRecall,
  jaccard,
  type RecallDecisionInput,
} from "../../src/core/policy.js";

const base: RecallDecisionInput = {
  policy: "smart",
  enabled: true,
  paused: false,
  breakerOpen: false,
  messageType: "user",
  prompt: "Implement database migration support",
  priorAutoRecalls: 0,
  maxAutoRecalls: 20,
  compactedSinceLastRecall: false,
  minPromptChars: 12,
  topicShiftThreshold: 0.15,
};
describe("decideRecall ordered rules", () => {
  it.each([
    [{ enabled: false }, "disabled"],
    [{ paused: true }, "paused"],
    [{ policy: "off" }, "policy-off"],
    [{ breakerOpen: true }, "breaker-open"],
    [{ messageType: "custom" }, "custom-run"],
    [{ prompt: "tiny" }, "trivial"],
    [{ priorAutoRecalls: 20 }, "budget-exhausted"],
    [{}, "first-prompt"],
    [{ policy: "always", lastRecallQuery: "same" }, "always"],
    [
      { lastRecallQuery: "same", compactedSinceLastRecall: true },
      "post-compaction",
    ],
    [
      { lastRecallQuery: "same", prompt: "Remember our deployment convention" },
      "cue",
    ],
    [{ lastRecallQuery: "same", policy: "first" }, "first-only"],
    [
      {
        lastRecallQuery: "same",
        prompt: "Implement database migration support for PostgreSQL schemas",
      },
      "topic-shift",
    ],
    [{ lastRecallQuery: base.prompt }, "same-topic"],
  ] as [Partial<RecallDecisionInput>, string][])(
    "%o → %s",
    (overrides, reason) =>
      expect(decideRecall({ ...base, ...overrides }).reason).toBe(reason),
  );
  it.each([
    "ok",
    "YES!",
    "thanks you",
    "continue",
    "go ahead",
    "do it",
    "lgtm",
    "retry",
    "again",
    "no",
    "okay.",
    "proceed",
    "done",
    "next",
  ])("skips acknowledgement %s", (prompt) =>
    expect(decideRecall({ ...base, prompt, minPromptChars: 0 }).reason).toBe(
      "trivial",
    ),
  );
  it.each([
    "remember",
    "recall",
    "last time",
    "we decided",
    "we agreed",
    "we chose",
    "why did we",
    "convention",
    "preference",
    "as discussed",
  ])("recognizes cue %s", (cue) =>
    expect(
      decideRecall({
        ...base,
        lastRecallQuery: "other",
        prompt: `Please explain ${cue} in this project`,
      }).reason,
    ).toBe("cue"),
  );
  it("first policy still honors cues and compaction as ordered in the contract", () =>
    expect(
      decideRecall({
        ...base,
        policy: "first",
        lastRecallQuery: "old",
        prompt: "Recall our naming convention",
      }).reason,
    ).toBe("cue"));
});
it("cleans envelopes before gating and bounding, preserving the request body", () => {
  const request = "How do we deploy this project?";
  const prompt = `<skill name="x">${"Remember history before again ".repeat(100)}</skill>\n<paseo-system source-agent-id="previous"> ${request}</paseo-system>`;
  expect(cleanRecallPrompt(prompt)).toBe(request);
  expect(decideRecall({ ...base, prompt })).toMatchObject({ query: request });
  expect(
    decideRecall({
      ...base,
      prompt: '<skill name="x">Remember our conventions</skill>',
    }).reason,
  ).toBe("trivial");
  expect(
    cleanRecallPrompt(
      "Task: You are reviving a previous subagent conversation. Original run: abc Original session file: /tmp/log Follow-up: Fix the deployment.",
    ),
  ).toBe("Follow-up: Fix the deployment.");
  expect(
    cleanRecallPrompt(
      "The session was interrupted. Review current state.\n\nDeploy the service.",
    ),
  ).toBe("Deploy the service.");
});
it.each(["previously", "earlier", "before", "usually", "history", "again"])(
  "does not treat %s as an explicit cue",
  (word) => {
    expect(
      decideRecall({
        ...base,
        policy: "first",
        lastRecallQuery: "old",
        prompt: `Please explain ${word} in this project`,
      }).reason,
    ).toBe("first-only");
  },
);
it("bounds query by Unicode byte costs without splitting characters", () => {
  expect(boundQuery("abcdef", 2)).toBe("abcd");
  expect(boundQuery("é中😀x", 9)).toBe("é中😀");
  expect(boundQuery("x".repeat(2000)).length).toBe(1000);
});
it("content words and Jaccard handle empty sets and stopwords", () => {
  expect(contentWords("The MIGRATION and database ééé 123")).toEqual(
    new Set(["migration", "database", "ééé", "123"]),
  );
  expect(jaccard(new Set(), new Set())).toBe(1);
  expect(jaccard(new Set(["a", "b"]), new Set(["b", "c"]))).toBeCloseTo(1 / 3);
});
