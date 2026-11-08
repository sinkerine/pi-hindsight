import assert from "node:assert/strict";

export function parseSession(source) {
  const entries = source.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(entries[0]?.type, "session", "Expected a Pi session header");
  return entries;
}

export function recalls(entries) {
  return entries.filter((entry) => entry.type === "custom_message" && entry.customType === "hindsight-memory.recall");
}

export function assertFirstRecall(entries) {
  const hits = recalls(entries);
  assert.equal(hits.length, 1, "Expected exactly one recall injection");
  assert.equal(hits[0].details?.reason, "first-prompt");
  const index = entries.indexOf(hits[0]);
  assert.equal(entries[index - 1]?.message?.role, "user", "Recall must immediately follow user entry");
  assert.equal(hits[0].parentId, entries[index - 1].id, "Recall must follow user on the active branch");
  assert.match(hits[0].content, /ZEBRA-42/);
}

export function assertDocument(document, { sessionId, project, secret = false }) {
  assert.equal(document.id, `pi:${sessionId}:0`);
  for (const tag of ["harness:pi", `project:${project}`, `session:${sessionId}`]) {
    assert.ok(document.tags?.includes(tag), `Missing tag ${tag}`);
  }
  assert.equal(typeof document.original_text, "string");
  assert.doesNotMatch(document.original_text, /\[thinking\]|tool-result-body-sentinel/);
  if (secret) {
    assert.match(document.original_text, /\[REDACTED:/);
    assert.ok(!document.original_text.includes("sk-test-ABCDEFGHIJKLMNOPQRSTUV"), "Secret leaked to retained text");
  } else {
    assert.match(document.original_text, /ZEBRA-42/);
    assert.match(document.original_text, /make ship/);
  }
}

export function assertCompletedOperations(operations) {
  assert.ok(operations.length > 0, "Expected at least one retain operation");
  for (const operation of operations) {
    assert.equal(operation.status, "completed", `Operation ${operation.id} is ${operation.status}: ${operation.error_message ?? ""}`);
  }
}

export async function poll(label, probe, { timeoutMs, intervalMs = 500, now = Date.now, sleep = (ms) => new Promise((done) => setTimeout(done, ms)) }) {
  const deadline = now() + timeoutMs;
  let lastError;
  while (now() < deadline) {
    try {
      const value = await probe(Math.max(1, deadline - now()));
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(Math.min(intervalMs, Math.max(0, deadline - now())));
  }
  throw new Error(`${label} did not complete within ${timeoutMs}ms`, { cause: lastError });
}
