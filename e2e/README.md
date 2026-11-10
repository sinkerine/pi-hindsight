# Disposable Hindsight E2E sandbox

Run `npm run e2e:check` to check JavaScript and shell syntax, validate Compose, and exercise assertion helpers and the local streaming stub. This gate does not load `src/index.ts` or start containers. Run `npm run e2e` for the complete journey once the extension is ready.

Prerequisites: Node >= 22.19, installed npm dependencies (including Pi 1.4.0), Docker with Compose v2, Bash, `flock`, and free ports 18890/18891. The script uses `node_modules/.bin/pi`; `E2E_PI_BIN` may name another installed Pi 1.4.0 executable. It never installs or updates Pi. During parallel implementation, wrap build/test commands with the repository's shared build lock described in `AGENTS.md`.

```bash
E2E_EVIDENCE_DIR=/absolute/path/to/evidence npm run e2e
```

Each invocation creates a fresh `run-XXXXXXXX` evidence directory, random bank, temporary home/agent directory, and sessions. Repeating the command preserves all earlier evidence. If `E2E_EVIDENCE_DIR` is unset, evidence lives under `${TMPDIR:-/tmp}/pi-hindsight-e2e-evidence`. A separate sandbox lock prevents concurrent journeys. The script refuses an existing `pi-hindsight-e2e` container or occupied port instead of taking over its resources.

The sandbox uses `ghcr.io/vectorize-io/hindsight:1.1.0@sha256:50311d02b4d5d2b7c5242bd336edf8735df8374eaad496a92f49c83b37d2aa06`. On 2026-11-08, a GHCR manifest request for tag `1.1.0` returned that digest; local image `068222bc11d85cb3cd519c82f6df94d9efe782670ff7e936a558dc5084264fe9` had the same repository digest and OCI version label `1.1.0` (revision `a5a619b5ca59c5c39e0f96be6f7a31fabd136bd5`). The journey also checks `/v1/version` at runtime for API >= 1.1.0. The standalone image runs embedded PostgreSQL with a disposable anonymous volume at `/home/hindsight/.pg0`; the control plane is disabled.

Hindsight always uses `HINDSIGHT_API_RETAIN_EXTRACTION_MODE=chunks` and local embedding/reranker models. Its LLM defaults to `HINDSIGHT_API_LLM_PROVIDER=none` from the checked-in `e2e/sandbox-defaults.env`. An optional, gitignored `e2e/llm.env` is loaded after it and may set `HINDSIGHT_API_LLM_PROVIDER`, `HINDSIGHT_API_LLM_BASE_URL`, `HINDSIGHT_API_LLM_API_KEY`, `HINDSIGHT_API_LLM_MODEL` and `HINDSIGHT_API_LLM_REASONING_EFFORT` for a cheap model; keep every value only in that file. Create it with mode `0600`. The resolved Compose evidence masks credential values. Pi itself never calls an external model. Docker may pull the pinned image and Hindsight may download model weights on a cold cache; these are setup downloads, not LLM requests. Pi receives an allowlisted environment, temporary home, isolated `models.json`, offline mode, and the explicit local stub model. Discovered extensions, skills, templates, themes, context files, and tools are disabled. The extension itself is loaded explicitly from `src/index.ts`.

The journey checks these steps:

1. Start only the `pi-hindsight-e2e` Compose service and the loopback stub; wait up to 180 seconds for Hindsight `/health` to report `healthy`.
2. Session A records deploy codename `ZEBRA-42` and `make ship`. Its new bank returns no recall injection.
3. Poll documents and retain operations for up to 60 seconds. Verify `pi:<sessionA>:0`, completed operations, project/harness/session tags, and retained text.
4. New session B asks how to deploy. Check stdout contains `ZEBRA-42`, and exactly one persisted recall with `first-prompt` reason immediately follows the user message on the branch.
5. Resume session B with `ok`. Check there is no new recall and the stub returns `NO_MEMORY`. The stub considers messages since the last assistant response so a persisted injection from an earlier turn cannot satisfy this check.
6. Session C submits a synthetic API key. Inspect retained text for `[REDACTED:` and absence of the key.
6a. After session B, check that the extension created the project digest mental model with its tags and delta/cron trigger. With `e2e/llm.env`, wait up to 180 seconds for generated content mentioning the deploy convention, start new session D and check that exactly one injection carries the digest, then resume D with `ok` and check that the digest is not injected again. Without `e2e/llm.env`, `result.json` records the generation step as skipped.
6b. Launch a child with `PI_SUBAGENT_CHILD=1` and default settings; require no memory reply, no persisted recall and no retained child document. Launch a parent with a large expanded skill and Paseo envelope; require the persisted search query to contain only the actual deployment question. Check that new digests use the 800-token budget.
7. Stop only the sandbox Hindsight service. Resume B with a memory cue. Require a successful normal reply, no stack trace, and elapsed overhead <= 2500 ms + 1 second over the healthy resumed `ok` request.
8. Always capture logs, copy session/config artifacts, stop the stub, run `docker compose down -v`, and remove temporary runtime files.

Evidence includes per-request stdout/stderr/timings, session JSONL before and after resume, document and operation snapshots, health/version responses, stub requests, resolved Compose configuration, startup/container/teardown logs, and `exit-code`. `result.json` is written only after all journey assertions pass. Evidence deliberately includes synthetic input secrets in the original session and stub request logs so redaction can be audited; permissions are restricted by `umask 077`. Retained document evidence must not contain those secrets. Assertion failures and process failures preserve evidence too.

The harness never addresses port 18889 or stops/reconfigures `bd-hs-compare-hindsight-books-1`. Compose commands always use this file and its fixed project name. For an interrupted run that could not execute cleanup, inspect only the sandbox with `docker compose -f e2e/docker-compose.yml ps -a`, then remove it with `docker compose -f e2e/docker-compose.yml down -v` before replaying. Never use a broad Docker cleanup command.
