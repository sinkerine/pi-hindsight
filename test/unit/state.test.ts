import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { RECALL_CUSTOM_TYPE, STATE_ENTRY_TYPE } from "../../src/core/format.js";
import { reconstructState } from "../../src/core/state.js";

const base = { id: "entry", parentId: null, timestamp: "2026-11-08T00:00:00Z" };
const recall = (details: unknown): SessionEntry => ({
  ...base,
  type: "custom_message",
  customType: RECALL_CUSTOM_TYPE,
  content: "memory",
  display: true,
  details,
});
const compact: SessionEntry = {
  ...base,
  type: "compaction",
  summary: "summary",
  tokensBefore: 100,
  firstKeptEntryId: "old",
};
it("reconstructs branch ids, pause state, query and compaction state in order", () => {
  const branch: SessionEntry[] = [
    recall({ ids: ["a", "b"], query: "first", reason: "first-prompt" }),
    {
      ...base,
      type: "custom",
      customType: STATE_ENTRY_TYPE,
      data: { paused: true },
    },
    compact,
    recall({ ids: ["b", "c"], query: "next", reason: "post-compaction" }),
  ];
  expect(reconstructState(branch)).toEqual({
    injectedIds: new Set(["a", "b", "c"]),
    autoRecalls: 2,
    lastRecallQuery: "next",
    paused: true,
    compactedSinceLastRecall: false,
  });
  expect(
    reconstructState([
      ...branch,
      compact,
      {
        ...base,
        type: "custom",
        customType: STATE_ENTRY_TYPE,
        data: { paused: false },
      },
    ]),
  ).toMatchObject({ paused: false, compactedSinceLastRecall: true });
  expect(reconstructState(branch.slice(0, 1))).toMatchObject({
    autoRecalls: 1,
    lastRecallQuery: "first",
    paused: false,
  });
});
it("manual/tool ids dedupe without using the automatic recall budget or compaction reset", () => {
  expect(
    reconstructState([
      compact,
      recall({ ids: ["tool"], query: "manual", reason: "tool" }),
      recall({ ids: ["preview"], reason: "manual" }),
    ]),
  ).toEqual({
    injectedIds: new Set(["tool", "preview"]),
    autoRecalls: 0,
    paused: false,
    compactedSinceLastRecall: true,
  });
});
it("ignores malformed and unrelated stored details", () => {
  expect(
    reconstructState([
      recall(null),
      {
        ...base,
        type: "custom",
        customType: STATE_ENTRY_TYPE,
        data: { paused: "true" },
      },
      {
        ...base,
        type: "custom_message",
        customType: "other",
        content: "other",
        display: true,
        details: { ids: ["ignored"] },
      },
    ]),
  ).toEqual({
    injectedIds: new Set(),
    autoRecalls: 0,
    paused: false,
    compactedSinceLastRecall: false,
  });
  expect(
    reconstructState([recall({ ids: ["valid", 123], query: 3 })]).injectedIds,
  ).toEqual(new Set(["valid"]));
});
