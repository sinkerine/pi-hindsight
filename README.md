# pi-hindsight-memory

Connect Pi to an already running [Hindsight](https://github.com/vectorize-io/hindsight) server for long-term project memory. The package uses local rules to decide when retrieval may help, persists recalled memory in the conversation, and checkpoints redacted conversation documents for server-side fact extraction.

Core memory, Pi integration, tools, scheduled project digests and the disposable E2E sandbox are implemented.

## Install

Requires Node.js **22.19 or newer**, Pi (types tested against **1.4.0**), and a running Hindsight HTTP API compatible with **1.1.0**. This package does not start or manage Hindsight, download models, or configure server extraction.

From a checkout:

```sh
npm ci
pi install /absolute/path/to/pi-hindsight-memory
```

For a single invocation during development:

```sh
pi -e ./src/index.ts
```

When published, install with `pi install npm:pi-hindsight-memory`. Pi loads TypeScript through jiti, so no compilation step is required. Pi supplies `@earendil-works/pi-coding-agent` and `typebox`; they are peer dependencies rather than bundled runtime copies.

## Configure

Put your global configuration in `<agentDir>/hindsight-memory.json`. Pi's default agent directory is `~/.pi/agent`; `PI_CODING_AGENT_DIR` overrides it. Configuration precedence is defaults, global file, environment, then project restrictions. Partial nested objects merge with defaults. Invalid JSON, invalid fields and unreadable files yield warnings and leave defaults or earlier valid values in place; warning strings never include configuration values.

A minimal global file:

```json
{
  "apiUrl": "http://localhost:8888",
  "bankId": "pi",
  "recall": { "policy": "smart" },
  "retain": { "auto": true }
}
```

Environment overrides:

| Variable                     | Effect                                                                 |
| ---------------------------- | ---------------------------------------------------------------------- |
| `HINDSIGHT_API_URL`          | Server base URL, default `http://localhost:8888`                       |
| `HINDSIGHT_API_TOKEN`        | Optional Bearer token; alternatively set `apiToken` in the global file |
| `HINDSIGHT_BANK_ID`          | Bank, default `pi`                                                     |
| `HINDSIGHT_MEMORY_ENABLED=0` | Disable memory behavior                                                |
| `PI_CODING_AGENT_DIR`        | Location of the global configuration                                   |

Tokens are read from the environment or global file, never from project configuration. Keep the global file private when it contains credentials. Use HTTPS for a remote server.

The complete defaults are:

```json
{
  "enabled": true,
  "apiUrl": "http://localhost:8888",
  "bankId": "pi",
  "tools": true,
  "subagents": "off",
  "recall": {
    "policy": "smart",
    "budget": "low",
    "maxTokens": 1024,
    "timeoutMs": 2500,
    "minPromptChars": 12,
    "maxAutoRecallsPerSession": 20,
    "topicShiftThreshold": 0.15,
    "display": true,
    "preferObservations": true,
    "dedupThreshold": 0.8
  },
  "retain": {
    "auto": true,
    "minUserTurns": 1,
    "ephemeral": true,
    "includeToolCalls": true,
    "timeoutMs": 5000,
    "shutdownFlushMs": 3000,
    "segmentChars": 60000,
    "extraTags": [],
    "supersede": true,
    "supersedeThreshold": 0.6,
    "supersedeMinRelevance": 0.5
  },
  "digest": {
    "enabled": true,
    "maxTokens": 800,
    "timeoutMs": 2500,
    "refreshCron": "0 3 * * *",
    "fullRefreshCron": "0 3 * * 0"
  }
}
```

Optional global fields are `apiToken`, `project` (override project naming), and `recall.types` (an array containing `world`, `experience`, and/or `observation`). `budget` accepts `low`, `mid`, or `high`. Durations and size limits must be positive safe integers; `minPromptChars` and `maxAutoRecallsPerSession` also accept zero. `topicShiftThreshold` and `supersedeMinRelevance` must be between zero and one; `dedupThreshold` and `supersedeThreshold` must be greater than zero and at most one. `digest.maxTokens` must be between 256 and 8,192, and cron fields must be five-field UTC expressions.

The project file `<cwd>/.pi/hindsight-memory.json` may only restrict behavior:

```json
{
  "enabled": false,
  "recall": { "policy": "off" },
  "retain": { "auto": false, "supersede": false },
  "digest": { "enabled": false }
}
```

Allowed restrictions are `enabled:false`, `retain.auto:false`, `retain.supersede:false`, `digest.enabled:false`, and `recall.policy:"off"` or `"first"`. Project files cannot enable globally disabled behavior, change credentials, redirect traffic, select a bank, alter tags, or change any other option. A project `first` never overrides a global `off`. Other project fields are ignored. This restriction applies independently of Pi's own project trust mechanism.

Projects share the default bank `pi`. Retrieval uses `project:<name>` with `tags_match:"any"`, so it includes matching project memories and untagged global memories. Retention tags are `harness:pi`, `project:<name>`, `session:<id>`, plus `retain.extraTags`; observation scopes contain only `project:<name>` so observations consolidate across sessions. Project names derive from the repository's Git common directory, making worktrees share a name, and fall back to the working directory basename. Tags provide retrieval scope; use separate banks and server access controls when a hard privacy boundary is required.

## Child sessions and retention volume

When `PI_SUBAGENT_CHILD=1`, `subagents` controls memory: `"off"` (default) disables all memory traffic, `"recall"` permits automatic/manual recall but blocks automatic and explicit retention, and `"full"` permits both. Children never load or inject the project digest; the parent's brief provides context. Global disabled settings and project restrictions still apply. The child environment marker, not prompt wording, identifies children.

`retain.minUserTurns` is a positive integer (default 1). Automatic settled/shutdown checkpoints wait for that many user messages on the current branch, excluding inherited fork entries. Set it to 2 to omit single-prompt sessions; this also omits potentially useful single-prompt decisions. Explicit checkpoints and durable-fact tools bypass the turn threshold, but never bypass child restrictions, disabled memory or pause.

## Recall behavior

`smart` skips disabled or paused memory, an open circuit breaker, custom-triggered runs, short prompts and acknowledgements such as `ok`, `continue`, and `thanks`. It also respects the per-session automatic recall budget. Expanded `<skill>…</skill>` instructions, Paseo transport wrappers and known recovery preambles are removed before gating, topic comparison and query bounding; the request body is preserved. Eligible prompts recall on the first query, after compaction, on explicit memory cues (`remember`, `recall`, `last time`, `we decided`, `convention`, `preference`, `as discussed`), or on a topic shift. Standalone `again`, `before`, `earlier`, `previously`, `usually` and `history` are not memory cues; a substantive request can still trigger a topic shift. Topic shifts require at least 40 characters and Jaccard similarity of content words below `topicShiftThreshold` relative to the last recall query.

`always` recalls every eligible nontrivial prompt within the budget. `first` skips later topic shifts; the specified rule ordering still allows explicit cues and post-compaction recall. `off` disables automatic recall. Manual recall and the model tool complement these automatic policies.

Queries are bounded to approximately 500 tokens using a Unicode byte-cost estimate. Recall is retrieval only: no extra model calls for gating, relevance judging or query rewriting. Hits already injected on the active branch are removed; an empty or duplicate-only response adds no message. Recalled content is enclosed in an escaped `<hindsight_memory>` block labeled as untrusted reference data. When provided by the server, each hit also shows its type, mentioned-at timestamp, source document, up to three source-fact IDs, and a short context. Optional metadata is redacted, escaped and bounded; it adds some input tokens beyond the server's memory-text budget. Mentioned-at timestamps describe source history, not current verification.

The tool guidance encourages narrow follow-up recall when available memory does not answer a relevant historical question, even if other memories or a project digest are present. It asks the model to stop once that history is sufficient, verify consequential or changeable claims against the current owning source when needed, and preserve uncertainty and project/task scope.

Recall sends `prefer_observations` (`recall.preferObservations`), so consolidated observations replace the raw facts they were built from and the server backfills the freed slots. The extension then collapses remaining near-duplicates: two hits whose content-word Jaccard similarity reaches `dedupThreshold`, or whose shorter text (at least six content words) is 90% contained in the other, count as one. The kept hit is the observation, then the more complete text, then the newer mention, in the earlier rank position.

Pi wiring stores one `hindsight-memory.recall` custom message immediately after the user prompt. Persisting the message preserves an auditable, cache-friendly prefix instead of rewriting the system prompt. The model still pays for retrieved input tokens, typically once at full price and then through cache reads. Heuristics can miss relevant history or retrieve irrelevant hits; tools remain useful for explicit historical questions.

## Forgetting and compaction

Compaction runs on the Hindsight server. Consolidation merges related facts into observations, reconciles near-duplicates and rewrites a belief when newer facts contradict it, keeping the earlier wording in its history. Bank-wide `observations_mission` and `retain_mission` settings belong to the server operator; this extension never changes bank configuration. For a dedicated coding-memory bank, an operator can PATCH `/v1/default/banks/<bank>/config` with:

```json
{
  "updates": {
    "retain_mission": "Extract durable coding knowledge: current user preferences, explicit decisions and their reasons, repository conventions, architecture constraints, and reusable pitfalls with verified causes and fixes. Exclude routine task narration, worktree paths, temporary agent/run IDs, individual test pass counts, one-off command output, and unconfirmed diagnoses. Preserve uncertainty and distinguish a proposal or intermediate hypothesis from a verified final outcome. Prefer the latest explicit correction over an earlier claim. Retain exact paths or commands only when they define a recurring convention."
  }
}
```

Read and back up existing overrides first; adapt this guidance to the bank's purpose. This affects future extraction, not existing facts, and does not require reindexing or deleting history.

**Project digest.** Each project gets one server-side mental model, `pi-digest-<project>-<hash>`, tagged `project:<name>` with `tags_match:"all_strict"`. It answers a question about durable decisions, conventions, preferences, constraints and pitfalls, within the configured `digest.maxTokens` budget. The digest also provides a few useful topic routes: what prior decision or debugging lesson to recall, when its detail matters, and specific search terms. It preserves project/task scope, separates single-task requests and tentative claims from durable preferences and verified outcomes, and includes exact source pointers only when supplied by evidence. The server refreshes it in `delta` mode on `refreshCron` (default daily at 03:00 UTC), skips the refresh when nothing in scope changed, and regenerates it fully on `fullRefreshCron` (default Sundays). Each refresh that does work is one server-side LLM reflect run. At session start the extension reads the digest; if it does not exist the extension creates it. A digest that is still empty while the server reports newer in-scope memories gets one refresh request per session; otherwise it would wait for the next cron. Changing settings does not silently rewrite an existing digest. Run `/hindsight digest refresh` to apply the configured query, token budget and schedules to this project digest and queue a full regeneration; reload after it completes. The compact default is 800 tokens. Refresh is explicit so ordinary session starts do not each spend an LLM call.

The digest is injected in an escaped `<hindsight_project_digest>` block, as untrusted reference data, at the first prompt of a branch and again after compaction. Its model-visible metadata includes the last refresh timestamp and a marker when the server reports newer source memories. Refresh time describes the summary, not verification of its claims. Existing digests adopt new query wording only after `/hindsight digest refresh`; reload once regeneration finishes. It shares the custom message with any recall from the same prompt; a digest-only message uses reason `digest` and does not count against the automatic recall budget. Before the first prompt, the extension waits at most `digest.timeoutMs` for the read. A paused branch receives no digest. The digest summarizes current memories only: if source memories are deleted, the next refresh drops their content.

**Restated explicit facts.** After `hindsight_retain` stores a fact, it recalls existing raw facts from other `pi:fact:` documents of the project (`tags_match:"all_strict"` with `kind:explicit`). Facts whose content-word similarity to the new text reaches `supersedeThreshold`, and whose cross-encoder relevance is at least `supersedeMinRelevance` when the server reports one, are invalidated with reason `superseded-by:<new document>`. Invalidation is reversible on the server, excluded from recall and consolidation, and kept for audit; it also prunes observations built from that fact so consolidation rebuilds them. Invalidated ids are recorded in a branch state entry. Failures leave the older facts in place. Contradictions without restated wording are left to consolidation.

Hindsight 1.1.0 has no memory expiry. Nothing is deleted automatically; storage grows with retained sessions. `/hindsight forget` remains the only deletion and removes this session's conversation documents.

## Retention behavior and privacy

After a settled prompt, the extension renders the active branch as timestamped user and assistant text. It includes compact tool-call arguments when `includeToolCalls:true`; failed tools contribute only a bounded one-line error marker. It excludes thinking, images, successful tool-result bodies, recall injections, hidden custom messages, compaction and branch summaries, system messages, and `!!` shell commands. Ordinary `!` shell commands retain their command text, without raw command output. Redaction happens before message and argument caps. Messages are capped at 4,000 characters; tool arguments at 200 characters and error text at 300.

Redaction recognizes PEM private keys, AWS access IDs, GitHub tokens, OpenAI/Anthropic-style `sk-` keys, Slack tokens, Google API keys, JWTs, Bearer credentials, URL user/password credentials and secret-like values assigned to common key names. Replacements use `[REDACTED:<kind>]`. Ordinary expressions such as `token = getToken()` are preserved. Pattern-based redaction cannot recognize every credential or private fact; review what you send, disable automatic retention for sensitive projects, or set `includeToolCalls:false` to reduce exposure through arguments.

Messages are packed into segments of at most `segmentChars` characters. Oversized individual messages are split deterministically. Appending messages preserves all earlier frozen segments. Each changed segment is retained asynchronously as `pi:<sessionId>:<segment>` with a SHA-256 content hash; unchanged acknowledged segments are skipped. Hindsight upserts the document and reuses unchanged chunks, avoiding repeated extraction of a stable prefix. Branch rewrites update affected segments and delete acknowledged higher segments that no longer exist.

The writer allows one request in flight, coalesces pending snapshots to the latest, and retries transient network/timeouts, HTTP 429, and HTTP 5xx errors at most twice after 500 ms and 1,500 ms. Each segment submission uses one generated operation ID across its retries. Only successful responses acknowledge hashes. A successful HTTP submission means the server accepted asynchronous work; it does not mean extraction has completed. `/hindsight status` fetches the bank-wide `failed_operations` count on demand; diagnostic failures do not affect the recall circuit breaker. To recover, inspect `GET /v1/default/banks/<bank>/operations?status=failed&limit=100`, fix the provider/configuration cause, and run `/hindsight retry-failed <operation-id>` for the selected job. This uses the native retry endpoint, reports only that work was queued, and never automatically retries failures or replays documents. For retain jobs with both a batch parent and child, retry the batch parent rather than both; check its resulting status before retrying any remaining child. The count covers all producers in the bank, not just this session.

Graceful shutdown checkpoints and waits at most `shutdownFlushMs` (default 3 seconds). Work still pending at that bound may be lost on exit; crashes or SIGKILL can lose the current prompt. Forks exclude inherited branch entry IDs to avoid re-retaining the parent transcript. Resumed sessions use their existing session ID. Ephemeral `--no-session` sessions still have an ID and are retained by default; set `retain.ephemeral:false` globally to exclude them.

Recall times out after 2.5 seconds by default; retain requests after 5 seconds. Three consecutive failures open a circuit breaker for 60 seconds. A later checkpoint after cooldown can submit the current transcript again. A missing bank returns empty recall until the first retain creates it. Pi event handlers fail open, report status, and limit UI warnings to once per session per kind.

## Tools and commands

The Pi wiring supplies these controls:

| Control                     | Behavior                                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------------------ |
| `/hindsight status`         | Show server URL, bank, project, policy, recent results, digest and breaker state                       |
| `/hindsight pause`          | Persist a branch-local pause for automatic recall and retention                                        |
| `/hindsight resume`         | Persist a branch-local resume                                                                          |
| `/hindsight recall <query>` | Display a manual preview without injecting it into model context                                       |
| `/hindsight digest`         | Display the project digest, or its status when it has no content                                       |
| `/hindsight checkpoint`     | Request a checkpoint                                                                                   |
| `/hindsight forget`         | Confirm deletion of this session's conversation documents                                              |
| `hindsight_recall` tool     | Model-directed retrieval with `query` and optional `max_tokens`                                        |
| `hindsight_retain` tool     | Retain a redacted durable fact with `content` and optional `context`; invalidates restated older facts |

Explicit facts use separate deterministic `pi:fact:<hash>` documents tagged `kind:explicit`. Forgetting a session's conversation documents does not delete these separate facts or other sessions' memories. Pause follows the active branch; navigating the tree reconstructs state from entries on that branch. Set `tools:false` globally to disable model-directed tools. Use explicit retention for decisions, conventions and preferences, rather than transient task state.

## Development and validation

Core modules live in `src/core/` and accept injected I/O, clock, UUID or sleep dependencies where needed. Constructors start no network work. Unit tests cover configuration precedence and restrictions, policy rules, Unicode query bounds, secret redaction, transcript exclusions and prefix stability, branch state, formatting, HTTP shapes and failures, breaker transitions, and serialized checkpoint delivery.

```sh
npm ci
npm run typecheck
npm run lint
npm run test:unit
npm run check
npm pack --dry-run
```

`check` runs typechecking, Biome and all unit/integration tests. Runtime TypeScript is shipped directly; tests and the sandbox are excluded from the package. The future extension load smoke is `pi --offline --no-session -ne -e ./src/index.ts --help`.

`npm run e2e:check` checks each sandbox JavaScript file independently, shell syntax, Compose configuration and assertion helper tests. `npm run e2e` runs the full disposable sandbox journey after T3 supplies `e2e/`: Hindsight on `127.0.0.1:18890` with chunk extraction and a local model stub on `127.0.0.1:18891` for Pi. It must never touch an existing Hindsight service on `:18889`. Without `e2e/llm.env` the sandbox Hindsight has no LLM and the journey checks only digest creation; with that gitignored file it generates and checks the project digest. See [e2e/README.md](e2e/README.md).
