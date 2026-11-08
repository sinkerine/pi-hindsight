import { createHash } from "node:crypto";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { RECALL_CUSTOM_TYPE } from "./format.js";
import { redactSecrets } from "./redact.js";
export interface RenderOptions {
  includeToolCalls: boolean;
  excludeEntryIds?: ReadonlySet<string>;
  maxMessageChars?: number;
}
export interface RenderedMessage {
  entryId: string;
  timestamp: string;
  text: string;
}
export interface TranscriptSegment {
  index: number;
  content: string;
  hash: string;
  firstTimestamp: string;
  messageCount: number;
}
function cap(text: string, limit: number): string {
  const marker = "…[truncated]";
  return text.length <= limit
    ? text
    : text.slice(0, Math.max(0, limit - marker.length)) +
        marker.slice(0, limit);
}
export function renderMessages(
  entries: readonly SessionEntry[],
  opts: RenderOptions,
): { messages: RenderedMessage[]; redactions: number } {
  const messages: RenderedMessage[] = [];
  let redactions = 0;
  for (const entry of entries) {
    if (opts.excludeEntryIds?.has(entry.id)) continue;
    let text = "";
    const prefix = `[${entry.timestamp}] `;
    if (entry.type === "custom_message") {
      if (entry.customType === RECALL_CUSTOM_TYPE || !entry.display) continue;
      text = `${prefix}user: ${
        typeof entry.content === "string"
          ? entry.content
          : entry.content
              .filter((x) => x.type === "text")
              .map((x) => x.text)
              .join("\n")
      }`;
    } else if (entry.type === "message") {
      const msg = entry.message;
      if (msg.role === "user" || msg.role === "assistant") {
        const lines: string[] = [];
        const content =
          typeof msg.content === "string"
            ? [{ type: "text" as const, text: msg.content }]
            : msg.content;
        for (const block of content) {
          if (block.type === "text" && block.text)
            lines.push(`${prefix}${msg.role}: ${block.text}`);
          if (block.type === "toolCall" && opts.includeToolCalls) {
            const args = redactSecrets(JSON.stringify(block.arguments));
            redactions += args.count;
            lines.push(
              `${prefix}assistant → ${block.name}(${cap(args.text, 200)})`,
            );
          }
        }
        text = lines.join("\n");
      } else if (msg.role === "toolResult" && msg.isError) {
        const body = msg.content
          .filter((x) => x.type === "text")
          .map((x) => x.text)
          .join(" ");
        const redacted = redactSecrets(body);
        redactions += redacted.count;
        text = `${prefix}tool ${msg.toolName} error: ${redacted.text.replace(/\s+/g, " ").slice(0, 300)}`;
      } else if (msg.role === "bashExecution" && !msg.excludeFromContext) {
        text = `${prefix}user: !${msg.command}`;
      } else if (
        msg.role === "custom" &&
        msg.display &&
        msg.customType !== RECALL_CUSTOM_TYPE
      ) {
        text = `${prefix}user: ${
          typeof msg.content === "string"
            ? msg.content
            : msg.content
                .filter((x) => x.type === "text")
                .map((x) => x.text)
                .join("\n")
        }`;
      }
    }
    if (!text) continue;
    const result = redactSecrets(text);
    redactions += result.count;
    messages.push({
      entryId: entry.id,
      timestamp: entry.timestamp,
      text: cap(result.text, opts.maxMessageChars ?? 4000),
    });
  }
  return { messages, redactions };
}
export function segmentMessages(
  messages: readonly RenderedMessage[],
  segmentChars: number,
): TranscriptSegment[] {
  if (!Number.isSafeInteger(segmentChars) || segmentChars < 1)
    throw new RangeError("segmentChars must be a positive integer");
  const segments: TranscriptSegment[] = [];
  let parts: string[] = [];
  let length = 0;
  let firstTimestamp = "";
  let messageCount = 0;
  const finish = (): void => {
    if (!parts.length) return;
    const content = parts.join("\n");
    segments.push({
      index: segments.length,
      content,
      hash: createHash("sha256").update(content).digest("hex"),
      firstTimestamp,
      messageCount,
    });
    parts = [];
    length = 0;
    messageCount = 0;
  };
  for (const message of messages) {
    // Oversized messages are split deterministically, so even tiny configured segments stay bounded.
    for (let offset = 0; offset < message.text.length; offset += segmentChars) {
      const part = message.text.slice(offset, offset + segmentChars);
      if (parts.length && length + 1 + part.length > segmentChars) finish();
      if (!parts.length) firstTimestamp = message.timestamp;
      length += (parts.length ? 1 : 0) + part.length;
      parts.push(part);
      messageCount++;
    }
  }
  finish();
  return segments;
}
