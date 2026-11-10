import type { RecallBudget } from "./config.js";
export type HindsightErrorKind = "timeout" | "network" | "http" | "parse";
export class HindsightError extends Error {
  readonly retryable: boolean;
  constructor(
    message: string,
    readonly kind: HindsightErrorKind,
    readonly status?: number,
  ) {
    super(message);
    this.name = "HindsightError";
    this.retryable =
      kind === "timeout" ||
      kind === "network" ||
      (kind === "http" && (status === 429 || (status ?? 0) >= 500));
  }
}
export interface RecallHit {
  id: string;
  text: string;
  type?: string;
  context?: string | null;
  documentId?: string | null;
  mentionedAt?: string | null;
  tags?: string[];
  /** Server ranking scores; `reranker` is cross-encoder relevance in [0, 1]. */
  scores?: { final?: number; reranker?: number | null };
  /** Raw facts an observation was consolidated from. */
  sourceFactIds?: string[];
}
export interface MentalModel {
  id: string;
  content: string;
  lastRefreshedAt?: string;
  /** In-scope memories were written since the last refresh. */
  isStale?: boolean;
}
export interface MentalModelSpec {
  id: string;
  name: string;
  sourceQuery: string;
  tags: string[];
  maxTokens: number;
  trigger: {
    mode: "full" | "delta";
    refreshCron: string;
    fullRefreshCron: string;
    tagsMatch: "all_strict";
  };
}
export interface RecallParams {
  query: string;
  budget: RecallBudget;
  maxTokens: number;
  tags?: string[];
  tagsMatch?: "any" | "any_strict" | "all" | "all_strict";
  types?: string[];
  preferObservations?: boolean;
  timeoutMs: number;
  signal?: AbortSignal;
}
export interface RetainItem {
  content: string;
  documentId: string;
  context: string;
  tags: string[];
  metadata?: Record<string, string>;
  timestamp?: string;
  observationScopes?: string[][];
}
export interface RetainParams {
  items: RetainItem[];
  operationId: string;
  timeoutMs: number;
  signal?: AbortSignal;
}
export interface HindsightClientOptions {
  apiUrl: string;
  apiToken?: string;
  bankId: string;
  fetch?: typeof fetch;
}
export class HindsightClient {
  readonly bankId: string;
  private readonly fetcher: typeof fetch;
  private readonly base: string;
  constructor(private readonly opts: HindsightClientOptions) {
    this.bankId = opts.bankId;
    this.fetcher = opts.fetch ?? fetch;
    this.base = opts.apiUrl.replace(/\/+$/, "");
  }
  private get bankPath(): string {
    return `/v1/default/banks/${encodeURIComponent(this.bankId)}`;
  }
  private async request(
    path: string,
    method: string,
    timeoutMs: number,
    body?: unknown,
    external?: AbortSignal,
    missingOk = false,
  ): Promise<unknown> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = external ? AbortSignal.any([timeout, external]) : timeout;
    try {
      const response = await this.fetcher(`${this.base}${path}`, {
        method,
        signal,
        headers: {
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(this.opts.apiToken
            ? { Authorization: `Bearer ${this.opts.apiToken}` }
            : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (response.status === 404 && missingOk) return undefined;
      if (!response.ok)
        throw new HindsightError(
          `Hindsight HTTP ${response.status}`,
          "http",
          response.status,
        );
      if (method === "DELETE" || response.status === 204) return true;
      try {
        return await response.json();
      } catch (error) {
        if (signal.aborted) throw error;
        throw new HindsightError("Invalid Hindsight JSON response", "parse");
      }
    } catch (error) {
      if (error instanceof HindsightError) throw error;
      throw new HindsightError(
        timeout.aborted
          ? "Hindsight request timed out"
          : external?.aborted
            ? "Hindsight request aborted"
            : "Hindsight network request failed",
        timeout.aborted ? "timeout" : "network",
      );
    }
  }
  async health(
    timeoutMs: number,
  ): Promise<{ ok: boolean; apiVersion?: string }> {
    try {
      await this.request("/health", "GET", timeoutMs);
      let apiVersion: string | undefined;
      try {
        const version = (await this.request(
          "/v1/version",
          "GET",
          timeoutMs,
        )) as { api_version?: string };
        apiVersion = version.api_version;
      } catch {}
      return { ok: true, ...(apiVersion ? { apiVersion } : {}) };
    } catch {
      return { ok: false };
    }
  }
  async recall(p: RecallParams): Promise<RecallHit[]> {
    const data = await this.request(
      `${this.bankPath}/memories/recall`,
      "POST",
      p.timeoutMs,
      {
        query: p.query,
        budget: p.budget,
        max_tokens: p.maxTokens,
        tags: p.tags,
        tags_match: p.tagsMatch,
        types: p.types,
        ...(p.preferObservations === undefined
          ? {}
          : { prefer_observations: p.preferObservations }),
      },
      p.signal,
      true,
    );
    if (data === undefined) return [];
    const results =
      data && typeof data === "object"
        ? (data as { results?: unknown }).results
        : undefined;
    if (
      !Array.isArray(results) ||
      results.some(
        (hit) =>
          !hit ||
          typeof hit !== "object" ||
          typeof hit.id !== "string" ||
          typeof hit.text !== "string",
      )
    )
      throw new HindsightError("Invalid Hindsight recall results", "parse");
    return results.map((hit) => {
      const mapped: RecallHit = {
        id: hit.id,
        text: hit.text,
        type: hit.type,
        context: hit.context,
        documentId: hit.document_id,
        mentionedAt: hit.mentioned_at,
        tags: hit.tags,
      };
      const scores = hit.scores as Record<string, unknown> | null | undefined;
      if (scores && typeof scores === "object") {
        mapped.scores = {};
        if (typeof scores.final === "number")
          mapped.scores.final = scores.final;
        if (typeof scores.reranker === "number")
          mapped.scores.reranker = scores.reranker;
      }
      if (
        Array.isArray(hit.source_fact_ids) &&
        hit.source_fact_ids.every((id: unknown) => typeof id === "string")
      )
        mapped.sourceFactIds = hit.source_fact_ids;
      return mapped;
    });
  }
  /** Soft, reversible forget: excluded from recall and consolidation, kept for audit. */
  async invalidateMemory(
    memoryId: string,
    reason: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    return (
      (await this.request(
        `${this.bankPath}/memories/${encodeURIComponent(memoryId)}`,
        "PATCH",
        timeoutMs,
        { state: "invalidated", reason },
        signal,
        true,
      )) !== undefined
    );
  }
  /**
   * Reads a mental model through the tag-filtered list: in 1.1.0 only the list
   * reports `is_stale`, and `content` detail omits the reflect trace.
   */
  async findMentalModel(
    id: string,
    tags: readonly string[],
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<MentalModel | undefined> {
    const query = new URLSearchParams({
      detail: "content",
      tags_match: "exact",
      limit: "100",
    });
    for (const tag of tags) query.append("tags", tag);
    const data = (await this.request(
      `${this.bankPath}/mental-models?${query}`,
      "GET",
      timeoutMs,
      undefined,
      signal,
      true,
    )) as { items?: unknown } | null | undefined;
    if (data === undefined) return undefined;
    if (!data || typeof data !== "object" || !Array.isArray(data.items))
      throw new HindsightError("Invalid Hindsight mental model list", "parse");
    const model = data.items.find(
      (item): item is Record<string, unknown> =>
        !!item && typeof item === "object" && item.id === id,
    );
    if (!model) return undefined;
    return {
      id,
      content: typeof model.content === "string" ? model.content : "",
      ...(typeof model.last_refreshed_at === "string"
        ? { lastRefreshedAt: model.last_refreshed_at }
        : {}),
      ...(typeof model.is_stale === "boolean"
        ? { isStale: model.is_stale }
        : {}),
    };
  }
  /** Explicit migration of an existing project digest; never touches bank settings. */
  async updateMentalModel(
    spec: MentalModelSpec,
    timeoutMs: number,
  ): Promise<void> {
    await this.request(
      `${this.bankPath}/mental-models/${encodeURIComponent(spec.id)}`,
      "PATCH",
      timeoutMs,
      {
        source_query: spec.sourceQuery,
        max_tokens: spec.maxTokens,
        trigger: {
          mode: spec.trigger.mode,
          refresh_cron: spec.trigger.refreshCron,
          full_refresh_cron: spec.trigger.fullRefreshCron,
          tags_match: spec.trigger.tagsMatch,
        },
      },
    );
  }
  /** Queues a refresh in the model's own trigger mode, or an explicit full regeneration. */
  async refreshMentalModel(
    id: string,
    timeoutMs: number,
    signal?: AbortSignal,
    full = false,
  ): Promise<void> {
    await this.request(
      `${this.bankPath}/mental-models/${encodeURIComponent(id)}/refresh`,
      "POST",
      timeoutMs,
      full ? { mode: "full" } : undefined,
      signal,
    );
  }
  /** Creates the model and queues its first refresh; 409 means it already exists. */
  async createMentalModel(
    spec: MentalModelSpec,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      await this.request(
        `${this.bankPath}/mental-models`,
        "POST",
        timeoutMs,
        {
          id: spec.id,
          name: spec.name,
          source_query: spec.sourceQuery,
          tags: spec.tags,
          max_tokens: spec.maxTokens,
          trigger: {
            mode: spec.trigger.mode,
            refresh_cron: spec.trigger.refreshCron,
            full_refresh_cron: spec.trigger.fullRefreshCron,
            tags_match: spec.trigger.tagsMatch,
          },
        },
        signal,
      );
    } catch (error) {
      if (error instanceof HindsightError && error.status === 409) return;
      throw error;
    }
  }
  async retain(p: RetainParams): Promise<{ operationId?: string }> {
    const data = (await this.request(
      `${this.bankPath}/memories`,
      "POST",
      p.timeoutMs,
      {
        items: p.items.map((i) => ({
          content: i.content,
          document_id: i.documentId,
          context: i.context,
          tags: i.tags,
          metadata: i.metadata,
          timestamp: i.timestamp,
          observation_scopes: i.observationScopes,
        })),
        async: true,
        operation_id: p.operationId,
      },
      p.signal,
    )) as { operation_id?: string } | null;
    if (
      !data ||
      typeof data !== "object" ||
      (data.operation_id !== undefined && typeof data.operation_id !== "string")
    )
      throw new HindsightError("Invalid Hindsight retain response", "parse");
    return { operationId: data.operation_id };
  }
  /** Bank-wide diagnostic, fetched only by an explicit status command. */
  async failedOperations(timeoutMs: number): Promise<number> {
    const data = (await this.request(
      `${this.bankPath}/stats`,
      "GET",
      timeoutMs,
    )) as { failed_operations?: unknown } | null;
    if (
      !data ||
      !Number.isSafeInteger(data.failed_operations) ||
      (data.failed_operations as number) < 0
    )
      throw new HindsightError("Invalid Hindsight stats", "parse");
    return data.failed_operations as number;
  }
  /** Explicit operator recovery; never retry failures automatically or replay documents. */
  async retryOperation(id: string, timeoutMs: number): Promise<void> {
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
        id,
      )
    )
      throw new HindsightError("Invalid operation id", "parse");
    const data = (await this.request(
      `${this.bankPath}/operations/${encodeURIComponent(id)}/retry`,
      "POST",
      timeoutMs,
    )) as { success?: unknown } | null;
    if (data?.success !== true)
      throw new HindsightError("Hindsight retry rejected", "parse");
  }
  async deleteDocument(
    documentId: string,
    timeoutMs: number,
  ): Promise<boolean> {
    return (
      (await this.request(
        `${this.bankPath}/documents/${encodeURIComponent(documentId)}`,
        "DELETE",
        timeoutMs,
        undefined,
        undefined,
        true,
      )) !== undefined
    );
  }
}
