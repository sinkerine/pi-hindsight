import { expect, it } from "vitest";
import type { RecallHit } from "../../src/core/client.js";
import {
  collapseDuplicates,
  restatedFacts,
  similarity,
} from "../../src/core/dedup.js";

const hit = (id: string, text: string, extra: Partial<RecallHit> = {}) => ({
  id,
  text,
  ...extra,
});
it("scores restatements high and unrelated facts low", () => {
  expect(similarity("Deploy with make ship", "deploy WITH make ship!")).toBe(1);
  expect(
    similarity(
      "Recall uses a 1,024-token budget per retrieval by default",
      "The assistant found that recall uses a 1,024-token budget per retrieval by default, not a fixed entry count",
    ),
  ).toBeGreaterThanOrEqual(0.9);
  expect(similarity("Deploy with make ship", "Tests run with vitest")).toBe(0);
});
it("does not treat short texts as contained in longer ones", () => {
  expect(
    similarity("make ship", "make ship builds images and pushes tags"),
  ).toBeLessThan(0.8);
});
it("keeps rank order, prefers observations and complete text, drops covered facts", () => {
  const hits = [
    hit("short", "Smart recall triggers on the first prompt or a topic shift", {
      type: "world",
    }),
    hit("other", "Tests run with vitest"),
    hit(
      "long",
      "Smart recall triggers on the first prompt or a topic shift, per the assistant",
      { type: "experience" },
    ),
    hit("covered", "Deploys use make ship", { type: "world" }),
    hit("obs", "The team always deploys with make ship", {
      type: "observation",
      sourceFactIds: ["covered"],
    }),
  ];
  expect(collapseDuplicates(hits, 0.8).map((h) => h.id)).toEqual([
    "long",
    "other",
    "obs",
  ]);
  expect(collapseDuplicates(hits, 1.1).map((h) => h.id)).toEqual([
    "short",
    "other",
    "long",
    "obs",
  ]);
  const raw = hit("raw", "Deploys use make ship daily", { type: "world" });
  const observation = hit("obs2", "Deploys use make ship daily", {
    type: "observation",
  });
  expect(collapseDuplicates([raw, observation], 0.8)).toEqual([observation]);
  const older = hit("old", "Deploys use make ship daily", {
    mentionedAt: "2026-01-01",
  });
  const newer = hit("new", "Deploys use make ship daily", {
    mentionedAt: "2026-02-01",
  });
  expect(collapseDuplicates([older, newer], 0.8)).toEqual([newer]);
});
it("selects only restated raw facts from other explicit documents", () => {
  const content = "Releases are tagged with semantic versions";
  const hits = [
    hit("same-doc", content, { documentId: "pi:fact:new" }),
    hit("restated", content, { documentId: "pi:fact:old", type: "world" }),
    hit("irrelevant", content, {
      documentId: "pi:fact:old2",
      scores: { reranker: 0.2 },
    }),
    hit("observation", content, {
      documentId: "pi:fact:old3",
      type: "observation",
    }),
    hit("transcript", content, { documentId: "pi:session:0" }),
    hit("different", "Releases run in CI", { documentId: "pi:fact:old4" }),
  ];
  expect(
    restatedFacts(content, hits, "pi:fact:new", 0.6, 0.5).map((h) => h.id),
  ).toEqual(["restated"]);
});
