import { createHash } from "node:crypto";
import type { MentalModelSpec } from "./client.js";
import type { DigestConfig } from "./config.js";

export const DIGEST_SOURCE_QUERY =
  "What durable decisions, conventions, user preferences, architecture constraints, and known pitfalls apply to this project? Exclude transient task progress, one-off command output, and anything superseded by later decisions.";

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
    sourceQuery: DIGEST_SOURCE_QUERY,
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
