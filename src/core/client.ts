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
}
export interface RecallParams {
  query: string;
  budget: RecallBudget;
  maxTokens: number;
  tags?: string[];
  tagsMatch?: "any" | "any_strict" | "all" | "all_strict";
  types?: string[];
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
    return results.map((hit) => ({
      id: hit.id,
      text: hit.text,
      type: hit.type,
      context: hit.context,
      documentId: hit.document_id,
      mentionedAt: hit.mentioned_at,
      tags: hit.tags,
    }));
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
