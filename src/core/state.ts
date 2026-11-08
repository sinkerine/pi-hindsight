import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { RECALL_CUSTOM_TYPE, STATE_ENTRY_TYPE } from "./format.js";
export interface BranchMemoryState {
  injectedIds: Set<string>;
  autoRecalls: number;
  lastRecallQuery?: string;
  compactedSinceLastRecall: boolean;
  paused: boolean;
}
export function reconstructState(
  branch: readonly SessionEntry[],
): BranchMemoryState {
  const state: BranchMemoryState = {
    injectedIds: new Set(),
    autoRecalls: 0,
    compactedSinceLastRecall: false,
    paused: false,
  };
  for (const entry of branch) {
    if (entry.type === "compaction") state.compactedSinceLastRecall = true;
    if (
      entry.type === "custom" &&
      entry.customType === STATE_ENTRY_TYPE &&
      entry.data &&
      typeof entry.data === "object" &&
      "paused" in entry.data &&
      typeof entry.data.paused === "boolean"
    )
      state.paused = entry.data.paused;
    if (
      entry.type === "custom_message" &&
      entry.customType === RECALL_CUSTOM_TYPE &&
      entry.details &&
      typeof entry.details === "object"
    ) {
      const details = entry.details as Record<string, unknown>;
      if (Array.isArray(details.ids))
        for (const id of details.ids)
          if (typeof id === "string") state.injectedIds.add(id);
      if (details.reason !== "tool" && details.reason !== "manual") {
        state.autoRecalls++;
        if (typeof details.query === "string")
          state.lastRecallQuery = details.query;
        state.compactedSinceLastRecall = false;
      }
    }
  }
  return state;
}
