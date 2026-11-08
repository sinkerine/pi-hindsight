import type { RecallHit } from "./client.js";
import { contentWords, jaccard } from "./policy.js";

/** Smallest word set for which containment alone marks a duplicate. */
const MIN_CONTAINED_WORDS = 6;
const CONTAINMENT = 0.9;

function containment(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  if (small.size < MIN_CONTAINED_WORDS) return 0;
  return [...small].filter((word) => large.has(word)).length / small.size;
}

/**
 * Text similarity in [0, 1]: word-set Jaccard, or containment when one text's
 * words are almost entirely inside a longer restatement.
 */
export function similarity(a: string, b: string): number {
  const wa = contentWords(a);
  const wb = contentWords(b);
  const contained = containment(wa, wb);
  return Math.max(jaccard(wa, wb), contained >= CONTAINMENT ? contained : 0);
}

function preferred(a: RecallHit, b: RecallHit): RecallHit {
  const aObservation = a.type === "observation";
  if (aObservation !== (b.type === "observation")) return aObservation ? a : b;
  const aWords = contentWords(a.text).size;
  const bWords = contentWords(b.text).size;
  if (aWords !== bWords) return aWords > bWords ? a : b;
  if (a.mentionedAt && b.mentionedAt && a.mentionedAt !== b.mentionedAt)
    return a.mentionedAt > b.mentionedAt ? a : b;
  return a;
}

/**
 * Collapses near-duplicate recall hits while keeping server rank order. A raw
 * fact covered by an observation in the same result is always dropped. A
 * duplicate pair keeps the observation, then the more complete text, then the
 * newer mention, in the earlier position. A threshold above 1 disables text
 * matching.
 */
export function collapseDuplicates(
  hits: readonly RecallHit[],
  threshold: number,
): RecallHit[] {
  const covered = new Set(
    hits
      .filter((hit) => hit.type === "observation")
      .flatMap((hit) => hit.sourceFactIds ?? []),
  );
  const kept: RecallHit[] = [];
  for (const hit of hits) {
    if (covered.has(hit.id)) continue;
    const index =
      threshold > 1
        ? -1
        : kept.findIndex(
            (other) => similarity(other.text, hit.text) >= threshold,
          );
    if (index < 0) kept.push(hit);
    else kept[index] = preferred(kept[index] as RecallHit, hit);
  }
  return kept;
}

/**
 * Older explicit facts that the new fact restates. Only raw facts from other
 * explicit documents qualify; contradictions are left to server consolidation.
 */
export function restatedFacts(
  content: string,
  hits: readonly RecallHit[],
  documentId: string,
  threshold: number,
  minRelevance: number,
): RecallHit[] {
  return hits.filter(
    (hit) =>
      hit.type !== "observation" &&
      typeof hit.documentId === "string" &&
      hit.documentId.startsWith("pi:fact:") &&
      hit.documentId !== documentId &&
      (hit.scores?.reranker ?? 1) >= minRelevance &&
      similarity(content, hit.text) >= threshold,
  );
}
