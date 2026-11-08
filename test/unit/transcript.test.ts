import { createHash } from "node:crypto";
import type {
  SessionEntry,
  SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { RECALL_CUSTOM_TYPE } from "../../src/core/format.js";
import { renderMessages, segmentMessages } from "../../src/core/transcript.js";

const timestamp = "2026-11-08T10:00:00.000Z";
const base = (id: string) => ({ id, parentId: null, timestamp });
const user = (id: string, text: string): SessionEntry => ({
  ...base(id),
  type: "message",
  message: { role: "user", content: text, timestamp: 0 },
});
function message(
  id: string,
  value: SessionMessageEntry["message"],
): SessionEntry {
  return { ...base(id), type: "message", message: value };
}
const assistant: SessionMessageEntry["message"] = {
  role: "assistant",
  content: [
    { type: "thinking", thinking: "hidden reasoning" },
    { type: "text", text: "Use the existing tests." },
    {
      type: "toolCall",
      id: "call",
      name: "bash",
      arguments: { command: "pwd", token: "abcdefgh12345" },
    },
  ],
  api: "openai-completions",
  provider: "test",
  model: "test",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "toolUse",
  timestamp: 0,
};
it("renders only selected conversation text, compact calls and one-line errors", () => {
  const entries: SessionEntry[] = [
    user("u", "Hello"),
    message("a", assistant),
    message("image", {
      role: "user",
      content: [{ type: "image", data: "raw image", mimeType: "image/png" }],
      timestamp: 0,
    }),
    message("ok", {
      role: "toolResult",
      toolName: "bash",
      toolCallId: "call",
      content: [{ type: "text", text: "successful secret body" }],
      isError: false,
      timestamp: 0,
    }),
    message("error", {
      role: "toolResult",
      toolName: "bash",
      toolCallId: "call",
      content: [{ type: "text", text: "failed\nsecret=abcdefgh12345" }],
      isError: true,
      timestamp: 0,
    }),
    {
      ...base("recall"),
      type: "custom_message",
      customType: RECALL_CUSTOM_TYPE,
      content: "feedback memory",
      display: true,
    },
    {
      ...base("hidden"),
      type: "custom_message",
      customType: "other",
      content: "hidden custom",
      display: false,
    },
    {
      ...base("visible"),
      type: "custom_message",
      customType: "other",
      content: "visible custom",
      display: true,
    },
    {
      ...base("compact"),
      type: "compaction",
      summary: "compaction summary",
      firstKeptEntryId: "u",
      tokensBefore: 100,
    },
    {
      ...base("branch"),
      type: "branch_summary",
      summary: "branch summary",
      fromId: "other",
    },
    message("privatebash", {
      role: "bashExecution",
      command: "private command",
      output: "private output",
      excludeFromContext: true,
      exitCode: 0,
      cancelled: false,
      truncated: false,
      timestamp: 0,
    }),
    message("bash", {
      role: "bashExecution",
      command: "ls",
      output: "raw output",
      exitCode: 0,
      cancelled: false,
      truncated: false,
      timestamp: 0,
    }),
  ];
  const result = renderMessages(entries, { includeToolCalls: true });
  const text = result.messages.map((m) => m.text).join("\n");
  expect(result.redactions).toBe(2);
  expect(text).toContain(`[${timestamp}] user: Hello`);
  expect(text).toContain("assistant → bash(");
  expect(text).toContain("tool bash error: failed secret=[REDACTED:generic]");
  expect(text).toContain("visible custom");
  expect(text).toContain("user: !ls");
  for (const omitted of [
    "hidden reasoning",
    "raw image",
    "successful secret body",
    "feedback memory",
    "hidden custom",
    "compaction summary",
    "branch summary",
    "private command",
    "private output",
    "raw output",
    "abcdefgh12345",
  ])
    expect(text).not.toContain(omitted);
  expect(renderMessages(entries, { includeToolCalls: true })).toEqual(result);
  expect(
    renderMessages([message("a", assistant)], { includeToolCalls: false })
      .messages[0]?.text,
  ).not.toContain("bash(");
});
it("excludes fork baseline and redacts before applying message cap", () => {
  const result = renderMessages(
    [
      user("inherited", "parent text"),
      user("new", `api_key=${"a".repeat(100)} tail`),
    ],
    {
      includeToolCalls: true,
      excludeEntryIds: new Set(["inherited"]),
      maxMessageChars: 80,
    },
  );
  expect(result.messages).toHaveLength(1);
  expect(result.redactions).toBe(1);
  expect(result.messages[0]?.text).toContain("[REDACTED:generic]");
  expect(result.messages[0]?.text.length).toBeLessThanOrEqual(80);
  const capped = renderMessages([user("long", "a".repeat(5000))], {
    includeToolCalls: true,
  });
  expect(capped.messages[0]?.text.length).toBe(4000);
  expect(capped.messages[0]?.text).toMatch(/…\[truncated\]$/);
});
it("caps compact arguments and redacts secrets beyond the cap", () => {
  const content = structuredClone(assistant);
  content.content = [
    {
      type: "toolCall",
      id: "call",
      name: "bash",
      arguments: { prefix: "a".repeat(300), token: "abcdefgh12345" },
    },
  ];
  const result = renderMessages([message("a", content)], {
    includeToolCalls: true,
  });
  expect(result.redactions).toBe(1);
  expect(result.messages[0]?.text).toMatch(/…\[truncated\]\)$/);
});
it("segments at inclusive boundaries and hashes exact bytes", () => {
  const messages = [
    { entryId: "1", timestamp, text: "abcd" },
    { entryId: "2", timestamp, text: "efghi" },
    { entryId: "3", timestamp, text: "j" },
  ];
  const segments = segmentMessages(messages, 10);
  expect(segments.map((s) => s.content)).toEqual(["abcd\nefghi", "j"]);
  expect(segments[0]).toMatchObject({
    index: 0,
    messageCount: 2,
    firstTimestamp: timestamp,
    hash: createHash("sha256").update("abcd\nefghi").digest("hex"),
  });
  expect(segmentMessages([], 10)).toEqual([]);
  expect(() => segmentMessages(messages, 0)).toThrow(RangeError);
  expect(
    segmentMessages([{ entryId: "a", timestamp, text: "abcdefghijk" }], 4).map(
      (s) => s.content,
    ),
  ).toEqual(["abcd", "efgh", "ijk"]);
});
it("appending any suffix preserves all frozen segment bytes and metadata", () => {
  for (let seed = 1; seed <= 25; seed++) {
    const entries = Array.from({ length: 50 }, (_, index) =>
      user(String(index), "x".repeat(1 + ((index * seed * 17) % 130))),
    );
    for (let prefix = 2; prefix < entries.length; prefix += 3) {
      const before = segmentMessages(
        renderMessages(entries.slice(0, prefix), { includeToolCalls: true })
          .messages,
        200,
      );
      const after = segmentMessages(
        renderMessages(entries, { includeToolCalls: true }).messages,
        200,
      );
      expect(after.slice(0, before.length - 1)).toEqual(before.slice(0, -1));
    }
  }
});
