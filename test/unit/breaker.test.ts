import { expect, it } from "vitest";
import { CircuitBreaker } from "../../src/core/breaker.js";

it("opens at threshold, admits a probe after cooldown, reopens on failure and resets on success", () => {
  let now = 0;
  const breaker = new CircuitBreaker({ now: () => now });
  expect(breaker.isOpen()).toBe(false);
  breaker.recordFailure();
  breaker.recordFailure();
  expect(breaker.consecutiveFailures).toBe(2);
  expect(breaker.isOpen()).toBe(false);
  breaker.recordFailure();
  expect(breaker.isOpen()).toBe(true);
  now = 59999;
  expect(breaker.isOpen()).toBe(true);
  now = 60000;
  expect(breaker.isOpen()).toBe(false);
  breaker.recordFailure();
  expect(breaker.isOpen()).toBe(true);
  breaker.recordSuccess();
  expect(breaker.isOpen()).toBe(false);
  expect(breaker.consecutiveFailures).toBe(0);
});
it("allows configurable threshold and cooldown", () => {
  let now = 100;
  const breaker = new CircuitBreaker({
    threshold: 1,
    cooldownMs: 5,
    now: () => now,
  });
  breaker.recordFailure();
  expect(breaker.isOpen()).toBe(true);
  now = 105;
  expect(breaker.isOpen()).toBe(false);
});
