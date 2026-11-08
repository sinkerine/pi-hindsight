import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { assertCompletedOperations, assertDocument, assertFirstRecall, parseSession, poll, recalls } from "./lib/assertions.mjs";

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baseUrl = "http://127.0.0.1:18890";

async function json(path, remainingMs = 2000) {
  const response = await fetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(Math.min(2000, remainingMs)) });
  assert.equal(response.status, 200, `${path}: HTTP ${response.status}`);
  return response.json();
}

export async function runJourney({ tempDir, evidenceDir }) {
  assert.ok(tempDir && evidenceDir, "Expected temp and evidence directories");
  const bank = `e2e-${crypto.randomUUID()}`;
  const project = "e2e-sandbox";
  const agentDir = join(tempDir, "agent");
  const cwd = join(tempDir, "project");
  const sessions = join(agentDir, "sessions");
  await Promise.all([mkdir(agentDir, { recursive: true }), mkdir(cwd, { recursive: true }), mkdir(sessions, { recursive: true })]);
  const model = { id: "stub", name: "E2E stub", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 };
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { e2e: { api: "openai-completions", baseUrl: "http://127.0.0.1:18891/v1", apiKey: "e2e-dummy", models: [model] } } }, null, 2));
  await writeFile(join(agentDir, "hindsight-memory.json"), JSON.stringify({ project }));
  await writeFile(join(evidenceDir, "run.json"), JSON.stringify({ bank, project, image: "ghcr.io/vectorize-io/hindsight:1.1.0@sha256:50311d02b4d5d2b7c5242bd336edf8735df8374eaad496a92f49c83b37d2aa06" }, null, 2));
  // Deliberate allowlist: host credentials, API URLs, and agent configuration cannot escape into Pi.
  const env = { PATH: process.env.PATH, HOME: tempDir, LANG: "C.UTF-8", PI_OFFLINE: "1", PI_CODING_AGENT_DIR: agentDir, HINDSIGHT_API_URL: baseUrl, HINDSIGHT_BANK_ID: bank };
  const piBin = process.env.E2E_PI_BIN || join(root, "node_modules/.bin/pi");
  const version = await exec(piBin, ["--version"], { cwd, env, timeout: 10000 });
  assert.match(version.stdout.trim(), /^(?:pi\s+)?1\.4\.0$/, "E2E requires Pi 1.4.0");
  const common = ["--offline", "-p", "-ne", "-ns", "-np", "-nc", "--no-themes", "--no-tools", "-e", join(root, "src/index.ts"), "--model", "e2e/stub", "--session-dir", sessions];
  async function pi(label, sessionArgs, prompt) {
    const started = performance.now();
    try {
      const execution = exec(piBin, [...common, ...sessionArgs, prompt], { cwd, env, timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
      // Pi waits for piped stdin to end before processing the prompt argument.
      execution.child.stdin.end();
      const { stdout, stderr } = await execution;
      const ms = performance.now() - started;
      await Promise.all([writeFile(join(evidenceDir, `${label}.stdout`), stdout), writeFile(join(evidenceDir, `${label}.stderr`), stderr), writeFile(join(evidenceDir, `${label}.timing.json`), JSON.stringify({ ms }))]);
      assert.doesNotMatch(stderr, /(?:failed to load extension|extension error|\n\s+at .*:\d+:\d+)/i);
      return { stdout, stderr, ms };
    } catch (error) {
      await writeFile(join(evidenceDir, `${label}.failure.json`), JSON.stringify({ message: error.message, stdout: error.stdout, stderr: error.stderr }, null, 2));
      throw error;
    }
  }
  async function session(id, label) {
    const files = await readdir(sessions);
    const file = files.find((name) => name.endsWith(`_${id}.jsonl`));
    assert.ok(file, `Session ${id} was not saved`);
    const path = join(sessions, file);
    const source = await readFile(path, "utf8");
    await writeFile(join(evidenceDir, `${label}.jsonl`), source);
    const entries = parseSession(source);
    assert.equal(entries[0].id, id);
    return { entries, path };
  }
  const bankPath = `/v1/default/banks/${bank}`;
  async function retained(id, label, secret = false) {
    const documentId = `pi:${id}:0`;
    return poll(`${label} retained document and operation`, async (remaining) => {
      const documents = await json(`${bankPath}/documents?limit=100`, remaining);
      const operations = await json(`${bankPath}/operations?type=retain&limit=100`, remaining);
      await Promise.all([writeFile(join(evidenceDir, `${label}.documents.json`), JSON.stringify(documents, null, 2)), writeFile(join(evidenceDir, `${label}.operations.json`), JSON.stringify(operations, null, 2))]);
      const failed = operations.operations.find((operation) => ["failed", "cancelled"].includes(operation.status));
      assert.ok(!failed, `Retain failed: ${JSON.stringify(failed)}`);
      if (!documents.items.some((item) => item.id === documentId)) return false;
      if (!operations.operations.length || operations.operations.some((operation) => operation.status !== "completed")) return false;
      assertCompletedOperations(operations.operations);
      const document = await json(`${bankPath}/documents/${encodeURIComponent(documentId)}`, remaining);
      await writeFile(join(evidenceDir, `${label}.document.json`), JSON.stringify(document, null, 2));
      assertDocument(document, { sessionId: id, project, secret });
      return document;
    }, { timeoutMs: 60000 });
  }

  const health = await poll("Hindsight health", async (remaining) => {
    const body = await json("/health", remaining);
    return body.status === "healthy" && body;
  }, { timeoutMs: 180000 });
  await writeFile(join(evidenceDir, "health.json"), JSON.stringify(health));
  const apiVersion = await json("/v1/version");
  await writeFile(join(evidenceDir, "version.json"), JSON.stringify(apiVersion));
  const [major, minor] = String(apiVersion.api_version).split(".").map(Number);
  assert.ok(major > 1 || (major === 1 && minor >= 1), "Hindsight API must be >= 1.1.0");

  const a = crypto.randomUUID();
  await pi("session-a", ["--session-id", a], "Our deploy codename is ZEBRA-42 and we always deploy with make ship.");
  const sessionA = await session(a, "session-a");
  assert.equal(recalls(sessionA.entries).length, 0, "Missing bank must not inject memory");
  await retained(a, "session-a");

  const b = crypto.randomUUID();
  const replyB = await pi("session-b", ["--session-id", b], "How do we deploy this project?");
  assert.match(replyB.stdout, /ZEBRA-42/);
  const sessionB = await session(b, "session-b");
  assertFirstRecall(sessionB.entries);

  const ok = await pi("session-b-ok", ["--session", sessionB.path], "ok");
  assert.equal(ok.stdout.trim(), "NO_MEMORY");
  assert.equal(recalls((await session(b, "session-b-ok")).entries).length, 1, "Trivial prompt must not inject another recall");

  const c = crypto.randomUUID();
  await pi("session-c", ["--session-id", c], "remember the api key is sk-test-ABCDEFGHIJKLMNOPQRSTUV");
  await session(c, "session-c");
  await retained(c, "session-c", true);

  await exec("docker", ["compose", "-f", join(root, "e2e/docker-compose.yml"), "stop", "hindsight"], { timeout: 30000 });
  const failure = await pi("session-b-unavailable", ["--session", sessionB.path], "Why did we choose make ship?");
  assert.equal(failure.stdout.trim(), "NO_MEMORY");
  assert.ok(failure.ms <= ok.ms + 3500, `Failure overhead ${Math.round(failure.ms - ok.ms)}ms exceeds recall timeout + 1s`);
  assert.doesNotMatch(failure.stderr, /(?:stack trace|HindsightError|\n\s+at )/i);
  await session(b, "session-b-unavailable");
  await writeFile(join(evidenceDir, "result.json"), JSON.stringify({ status: "passed", bank, sessionA: a, sessionB: b, sessionC: c, failureOverheadMs: failure.ms - ok.ms }, null, 2));
  console.log(`E2E journey passed; evidence: ${evidenceDir}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runJourney({ tempDir: process.env.E2E_TEMP_DIR, evidenceDir: process.env.E2E_RUN_EVIDENCE_DIR }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
