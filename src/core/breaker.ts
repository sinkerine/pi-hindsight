export class CircuitBreaker {
  private failures = 0;
  private openedAt: number | undefined;
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  constructor(opts?: {
    threshold?: number;
    cooldownMs?: number;
    now?: () => number;
  }) {
    this.threshold = opts?.threshold ?? 3;
    this.cooldownMs = opts?.cooldownMs ?? 60000;
    this.now = opts?.now ?? Date.now;
  }
  get consecutiveFailures(): number {
    return this.failures;
  }
  isOpen(): boolean {
    return (
      this.openedAt !== undefined &&
      this.now() - this.openedAt < this.cooldownMs
    );
  }
  recordSuccess(): void {
    this.failures = 0;
    this.openedAt = undefined;
  }
  recordFailure(): void {
    this.failures++;
    if (this.failures >= this.threshold) this.openedAt = this.now();
  }
}
