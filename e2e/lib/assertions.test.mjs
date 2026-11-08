import assert from "node:assert/strict";
import { test } from "node:test";
import { assertCompletedOperations, assertDocument, assertFirstRecall, parseSession, poll, recalls } from "./assertions.mjs";
import { createStubServer, replyFor } from "../stub-llm-server.mjs";

const block = "<hindsight_memory>Deploy ZEBRA-42 with make ship</hindsight_memory>";

test("stub echoes only memory supplied after the last assistant response", () => {
  assert.equal(replyFor([{ role: "user", content: "How do we deploy?" }, { role: "user", content: [{ type: "text", text: block }] }]), block);
  assert.equal(replyFor([{ role: "user", content: block }, { role: "assistant", content: block }, { role: "user", content: "ok" }]), "NO_MEMORY");
  assert.equal(replyFor([{ role: "system", content: block }, { role: "user", content: "ok" }]), "NO_MEMORY");
});

test("stub serves OpenAI SSE with terminal choice and DONE through real HTTP", async (t) => {
  const server = createStubServer();
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise((done) => server.close(done)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "stub", stream: true, messages: [{ role: "user", content: block }] }) });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  const frames = (await response.text()).trim().split("\n\n").map((line) => line.replace(/^data: /, ""));
  assert.equal(JSON.parse(frames[0]).choices[0].delta.content, block);
  assert.equal(JSON.parse(frames[1]).choices[0].finish_reason, "stop");
  assert.equal(frames[2], "[DONE]");
  assert.equal((await fetch(`${base}/not-an-endpoint`)).status, 404);
  const malformed = await fetch(`${base}/v1/chat/completions`, { method: "POST", body: "{" });
  assert.equal(malformed.status, 400);
});

test("session assertion rejects misplaced or duplicate injections", () => {
  const entries = parseSession([
    { type: "session", id: "a" },
    { type: "message", id: "u", message: { role: "user", content: "deploy?" } },
    { type: "custom_message", id: "m", parentId: "u", customType: "hindsight-memory.recall", content: block, details: { reason: "first-prompt" } },
  ].map((entry) => JSON.stringify(entry)).join("\n"));
  assertFirstRecall(entries);
  assert.equal(recalls(entries).length, 1);
  assert.throws(() => assertFirstRecall([...entries, entries[2]]), /exactly one/);
  assert.throws(() => assertFirstRecall([entries[0], entries[2], entries[1]]), /immediately follow/);
  assert.throws(() => parseSession('{"type":"message"}'), /session header/);
});

test("retained document assertions reject wrong identity, missing tags, and leaked secrets", () => {
  const document = { id: "pi:s:0", tags: ["harness:pi", "project:p", "session:s"], original_text: "Deploy ZEBRA-42 with make ship" };
  assertDocument(document, { sessionId: "s", project: "p" });
  assert.throws(() => assertDocument({ ...document, tags: [] }, { sessionId: "s", project: "p" }), /Missing tag/);
  assert.throws(() => assertDocument({ ...document, id: "wrong" }, { sessionId: "s", project: "p" }));
  assertDocument({ ...document, original_text: "api key [REDACTED:openai]" }, { sessionId: "s", project: "p", secret: true });
  assert.throws(() => assertDocument({ ...document, original_text: "[REDACTED:openai] sk-test-ABCDEFGHIJKLMNOPQRSTUV" }, { sessionId: "s", project: "p", secret: true }), /Secret leaked/);
  assertCompletedOperations([{ id: "o", status: "completed" }]);
  assert.throws(() => assertCompletedOperations([]), /at least one/);
  assert.throws(() => assertCompletedOperations([{ id: "o", status: "processing" }]), /processing/);
});

test("bounded polling retries transient errors and preserves the final failure", async () => {
  let clock = 0;
  let attempts = 0;
  const options = { timeoutMs: 100, intervalMs: 10, now: () => clock, sleep: async (ms) => { clock += ms; } };
  assert.equal(await poll("ready", async () => { if (++attempts < 3) throw new Error("warming up"); return "ready"; }, options), "ready");
  assert.equal(attempts, 3);
  await assert.rejects(poll("never ready", async () => { throw new Error("offline"); }, options), (error) => {
    assert.match(error.message, /within 100ms/);
    assert.equal(error.cause.message, "offline");
    return true;
  });
});
