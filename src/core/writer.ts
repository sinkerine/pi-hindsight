import { randomUUID } from "node:crypto";
import type { CircuitBreaker } from "./breaker.js";
import { type HindsightClient, HindsightError } from "./client.js";
import type { TranscriptSegment } from "./transcript.js";
export interface CheckpointRequest {
  sessionId: string;
  segments: readonly TranscriptSegment[];
  tags: string[];
  context: string;
  metadata: Record<string, string>;
  observationScopes: string[][];
}
export interface CheckpointWriterOptions {
  client: Pick<HindsightClient, "retain" | "deleteDocument">;
  timeoutMs: number;
  breaker: CircuitBreaker;
  onResult?: (r: { ok: boolean; sent: number; error?: HindsightError }) => void;
  uuid?: () => string;
  sleep?: (ms: number) => Promise<void>;
}
export function documentIdFor(sessionId: string, segment: number): string {
  return `pi:${sessionId}:${segment}`;
}
export class CheckpointWriter {
  private readonly hashes = new Map<string, Map<number, string>>();
  private pending: CheckpointRequest | undefined;
  private running: Promise<void> | undefined;
  constructor(private readonly opts: CheckpointWriterOptions) {}
  get busy(): boolean {
    return this.running !== undefined;
  }
  ackedHashes(sessionId: string): ReadonlyMap<number, string> {
    return new Map(this.hashes.get(sessionId));
  }
  submit(req: CheckpointRequest): void {
    try {
      this.pending = structuredClone(req);
      if (!this.running) this.start();
    } catch {}
  }
  private start(): void {
    this.running = Promise.resolve()
      .then(() => this.drain())
      .finally(() => {
        this.running = undefined;
        if (this.pending) this.start();
      });
  }
  private notify(result: {
    ok: boolean;
    sent: number;
    error?: HindsightError;
  }): void {
    try {
      this.opts.onResult?.(result);
    } catch {}
  }
  private async retry(action: () => Promise<unknown>): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await action();
        return;
      } catch (error) {
        const failure =
          error instanceof HindsightError
            ? error
            : new HindsightError(
                "Checkpoint network request failed",
                "network",
              );
        if (!failure.retryable || attempt >= 2) throw failure;
        await (
          this.opts.sleep ??
          ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
        )(attempt === 0 ? 500 : 1500);
      }
    }
  }
  private async drain(): Promise<void> {
    while (this.pending) {
      const req = this.pending;
      this.pending = undefined;
      if (this.opts.breaker.isOpen()) continue;
      let sent = 0;
      const ack = this.hashes.get(req.sessionId) ?? new Map<number, string>();
      this.hashes.set(req.sessionId, ack);
      try {
        for (const segment of req.segments) {
          if (ack.get(segment.index) === segment.hash) continue;
          const operationId = (this.opts.uuid ?? randomUUID)();
          await this.retry(() =>
            this.opts.client.retain({
              operationId,
              timeoutMs: this.opts.timeoutMs,
              items: [
                {
                  content: segment.content,
                  documentId: documentIdFor(req.sessionId, segment.index),
                  context: req.context,
                  tags: req.tags,
                  metadata: { ...req.metadata, segment: String(segment.index) },
                  timestamp: segment.firstTimestamp,
                  observationScopes: req.observationScopes,
                },
              ],
            }),
          );
          ack.set(segment.index, segment.hash);
          sent++;
        }
        const indices = new Set(req.segments.map((s) => s.index));
        for (const index of ack.keys()) {
          if (indices.has(index)) continue;
          await this.retry(() =>
            this.opts.client.deleteDocument(
              documentIdFor(req.sessionId, index),
              this.opts.timeoutMs,
            ),
          );
          ack.delete(index);
        }
        this.opts.breaker.recordSuccess();
        this.notify({ ok: true, sent });
      } catch (error) {
        this.opts.breaker.recordFailure();
        this.notify({
          ok: false,
          sent,
          error:
            error instanceof HindsightError
              ? error
              : new HindsightError("Checkpoint failed", "network"),
        });
      }
    }
  }
  async flush(timeoutMs: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (async () => {
          while (this.running) await this.running;
        })(),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, Math.max(0, timeoutMs));
        }),
      ]);
    } catch {
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
