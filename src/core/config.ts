import { join } from "node:path";
export type RecallPolicy = "smart" | "always" | "first" | "off";
export type RecallBudget = "low" | "mid" | "high";
export interface RecallConfig {
  policy: RecallPolicy;
  budget: RecallBudget;
  maxTokens: number;
  timeoutMs: number;
  minPromptChars: number;
  maxAutoRecallsPerSession: number;
  topicShiftThreshold: number;
  display: boolean;
  types?: Array<"world" | "experience" | "observation">;
}
export interface RetainConfig {
  auto: boolean;
  ephemeral: boolean;
  includeToolCalls: boolean;
  timeoutMs: number;
  shutdownFlushMs: number;
  segmentChars: number;
  extraTags: string[];
}
export interface HindsightMemoryConfig {
  enabled: boolean;
  apiUrl: string;
  apiToken?: string;
  bankId: string;
  project?: string;
  tools: boolean;
  recall: RecallConfig;
  retain: RetainConfig;
}
export const DEFAULT_CONFIG: HindsightMemoryConfig = {
  enabled: true,
  apiUrl: "http://localhost:8888",
  bankId: "pi",
  tools: true,
  recall: {
    policy: "smart",
    budget: "low",
    maxTokens: 1024,
    timeoutMs: 2500,
    minPromptChars: 12,
    maxAutoRecallsPerSession: 20,
    topicShiftThreshold: 0.15,
    display: true,
  },
  retain: {
    auto: true,
    ephemeral: true,
    includeToolCalls: true,
    timeoutMs: 5000,
    shutdownFlushMs: 3000,
    segmentChars: 60000,
    extraTags: [],
  },
};
export interface LoadConfigInput {
  env: Record<string, string | undefined>;
  agentDir: string;
  cwd: string;
  readFile: (path: string) => string | undefined;
}
export interface LoadedConfig {
  config: HindsightMemoryConfig;
  sources: string[];
  warnings: string[];
}
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function loadConfig(input: LoadConfigInput): LoadedConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  const sources: string[] = [];
  const warnings: string[] = [];
  const read = (path: string): Record<string, unknown> => {
    try {
      const text = input.readFile(path);
      if (text === undefined) return {};
      sources.push(path);
      const value: unknown = JSON.parse(text);
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw Error();
      return object(value);
    } catch {
      warnings.push(`Unable to read valid configuration: ${path}`);
      return {};
    }
  };
  const global = read(
    join(
      input.env.PI_CODING_AGENT_DIR || input.agentDir,
      "hindsight-memory.json",
    ),
  );
  function merge(
    target: Record<string, unknown>,
    value: Record<string, unknown>,
  ): void {
    for (const [key, item] of Object.entries(value)) {
      const optionalKey =
        (target === (config as unknown) &&
          ["apiToken", "project"].includes(key)) ||
        (target === (config.recall as unknown) && key === "types");
      if (!Object.hasOwn(target, key) && !optionalKey) {
        warnings.push(`Ignored unknown configuration field: ${key}`);
        continue;
      }
      const old = target[key];
      if (old !== null && typeof old === "object" && !Array.isArray(old)) {
        if (item !== null && typeof item === "object" && !Array.isArray(item))
          merge(object(old), object(item));
        else warnings.push(`Ignored invalid configuration field: ${key}`);
        continue;
      }
      const optional = ["apiToken", "project"].includes(key);
      const validArray =
        key === "extraTags" &&
        Array.isArray(item) &&
        item.every((x) => typeof x === "string");
      const validTypes =
        key === "types" &&
        Array.isArray(item) &&
        item.every((x) => ["world", "experience", "observation"].includes(x));
      let valid = optional
        ? typeof item === "string"
        : typeof item === typeof old && old !== undefined;
      if (typeof item === "number")
        valid =
          valid &&
          Number.isFinite(item) &&
          (key === "topicShiftThreshold"
            ? item >= 0 && item <= 1
            : Number.isSafeInteger(item) &&
              item >=
                (key === "minPromptChars" || key === "maxAutoRecallsPerSession"
                  ? 0
                  : 1));
      if (key === "policy")
        valid = ["smart", "always", "first", "off"].includes(String(item));
      if (key === "budget")
        valid = ["low", "mid", "high"].includes(String(item));
      if (key === "apiUrl") {
        try {
          valid =
            typeof item === "string" &&
            ["http:", "https:"].includes(new URL(item).protocol);
        } catch {
          valid = false;
        }
      }
      if (key === "bankId")
        valid = typeof item === "string" && item.trim().length > 0;
      if (Array.isArray(old) || key === "types")
        valid = validArray || validTypes;
      if (valid) target[key] = item;
      else warnings.push(`Ignored invalid configuration field: ${key}`);
    }
  }
  merge(config as unknown as Record<string, unknown>, global);
  const env: Record<string, unknown> = {};
  for (const [key, name] of [
    ["apiUrl", "HINDSIGHT_API_URL"],
    ["apiToken", "HINDSIGHT_API_TOKEN"],
    ["bankId", "HINDSIGHT_BANK_ID"],
  ]) {
    if (key && name && input.env[name] !== undefined)
      env[key] = input.env[name];
  }
  if (input.env.HINDSIGHT_MEMORY_ENABLED === "0") env.enabled = false;
  if (Object.keys(env).length) {
    merge(config as unknown as Record<string, unknown>, env);
    sources.push("environment");
  }
  const project = read(join(input.cwd, ".pi", "hindsight-memory.json"));
  if (project.enabled === false) config.enabled = false;
  if (object(project.retain).auto === false) config.retain.auto = false;
  const policy = object(project.recall).policy;
  if (
    policy === "off" ||
    (policy === "first" && config.recall.policy !== "off")
  )
    config.recall.policy = policy;
  return { config, sources, warnings };
}
