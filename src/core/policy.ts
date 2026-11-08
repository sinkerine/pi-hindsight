import type { RecallPolicy } from "./config.js";
export type RecallReason =
  | "first-prompt"
  | "post-compaction"
  | "cue"
  | "topic-shift"
  | "always"
  | "manual"
  | "tool";
export type SkipReason =
  | "disabled"
  | "paused"
  | "policy-off"
  | "breaker-open"
  | "custom-run"
  | "trivial"
  | "budget-exhausted"
  | "first-only"
  | "same-topic";
export interface RecallDecisionInput {
  policy: RecallPolicy;
  enabled: boolean;
  paused: boolean;
  breakerOpen: boolean;
  messageType: "user" | "custom";
  prompt: string;
  priorAutoRecalls: number;
  maxAutoRecalls: number;
  lastRecallQuery?: string;
  compactedSinceLastRecall: boolean;
  minPromptChars: number;
  topicShiftThreshold: number;
}
export type RecallDecision =
  | { recall: true; reason: RecallReason; query: string }
  | { recall: false; reason: SkipReason };
export function boundQuery(text: string, maxTokens = 500): string {
  let cost = 0;
  let result = "";
  for (const char of text) {
    const bytes = Buffer.byteLength(char);
    const next = bytes === 1 ? 0.5 : bytes;
    if (cost + next > maxTokens) break;
    cost += next;
    result += char;
  }
  return result;
}
const STOPWORDS = new Set(
  "the and for that this with from have what how are was were will would could should can our your you about into then them they their please want need does did has had not but also when where which these those its it's".split(
    " ",
  ),
);
export function contentWords(text: string): Set<string> {
  return new Set(
    (text.toLowerCase().match(/[\p{L}\p{N}_]{3,}/gu) ?? []).filter(
      (word) => !STOPWORDS.has(word),
    ),
  );
}
export function jaccard(
  a: ReadonlySet<string>,
  b: ReadonlySet<string>,
): number {
  const union = new Set([...a, ...b]);
  return union.size ? [...a].filter((x) => b.has(x)).length / union.size : 1;
}
export function decideRecall(i: RecallDecisionInput): RecallDecision {
  const skip = (reason: SkipReason): RecallDecision => ({
    recall: false,
    reason,
  });
  const yes = (reason: RecallReason): RecallDecision => ({
    recall: true,
    reason,
    query: boundQuery(i.prompt.trim().replace(/\s+/g, " ")),
  });
  if (!i.enabled) return skip("disabled");
  if (i.paused) return skip("paused");
  if (i.policy === "off") return skip("policy-off");
  if (i.breakerOpen) return skip("breaker-open");
  if (i.messageType === "custom") return skip("custom-run");
  const prompt = i.prompt.trim().replace(/\s+/g, " ");
  if (
    prompt.length < i.minPromptChars ||
    /^(y|yes|no|ok(ay)?|sure|thanks?( you)?|continue|go( on| ahead)?|proceed|do it|lgtm|done|next|retry|again)[.! ]*$/i.test(
      prompt,
    )
  )
    return skip("trivial");
  if (i.priorAutoRecalls >= i.maxAutoRecalls) return skip("budget-exhausted");
  if (i.policy === "always") return yes("always");
  if (!i.lastRecallQuery) return yes("first-prompt");
  if (i.compactedSinceLastRecall) return yes("post-compaction");
  if (
    /\b(remember|recall|last time|previous(ly)?|earlier|before|we (decided|agreed|chose)|why did (we|i)|convention|preference|usual(ly)?|history|again|as discussed)\b/i.test(
      prompt,
    )
  )
    return yes("cue");
  if (i.policy === "first") return skip("first-only");
  if (
    prompt.length >= 40 &&
    jaccard(contentWords(prompt), contentWords(i.lastRecallQuery)) <
      i.topicShiftThreshold
  )
    return yes("topic-shift");
  return skip("same-topic");
}
