import { createHash } from "node:crypto";
import type { MentalModelSpec } from "./client.js";
import type { DigestConfig } from "./config.js";

function digestSourceQuery(maxTokens: number): string {
  return `What durable decisions, conventions, user preferences, architecture constraints, and known pitfalls apply to this project? Write a compact checklist and topic guide within ${maxTokens} tokens. Prioritize the most useful supported conventions and decisions. Preserve their project/task scope; distinguish explicit user preferences from single-task requests, proposals, hypotheses, and verified outcomes. Later corrections supersede earlier claims. Include a few topic routes only when useful: what prior decision or debugging lesson to recall, when its detail matters, and specific search terms. Preserve exact safe source identifiers or paths only when supplied by evidence; never invent pointers. Prefer stable rules and recurring pitfalls over package versions, commit hashes, historical incidents, and long examples. Exclude transient task progress, one-off command output, unsupported generalizations, and superseded claims. Omit empty sections and do not fill the budget with low-value recap.`;
}

/** Mental model ids allow lowercase alphanumerics and hyphens only. */
export function digestIdFor(project: string): string {
  const slug = project
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const hash = createHash("sha256").update(project).digest("hex").slice(0, 8);
  return `pi-digest-${slug ? `${slug}-` : ""}${hash}`;
}

export function digestSpec(
  project: string,
  config: DigestConfig,
): MentalModelSpec {
  return {
    id: digestIdFor(project),
    name: `Pi project digest: ${project}`,
    sourceQuery: digestSourceQuery(config.maxTokens),
    tags: [`project:${project}`],
    maxTokens: config.maxTokens,
    trigger: {
      mode: "delta",
      refreshCron: config.refreshCron,
      fullRefreshCron: config.fullRefreshCron,
      tagsMatch: "all_strict",
    },
  };
}

/** Five-field cron with the characters standard cron syntax allows. */
export function isCron(value: string): boolean {
  const fields = value.trim().split(/\s+/);
  return fields.length === 5 && fields.every((f) => /^[0-9*,/-]+$/.test(f));
}
