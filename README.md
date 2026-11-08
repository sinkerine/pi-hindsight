# pi-hindsight-memory

Connect Pi to an already running [Hindsight](https://github.com/vectorize-io/hindsight) server for long-term project memory. The package uses local rules to decide when retrieval may help, persists recalled memory in the conversation, and checkpoints redacted conversation documents for server-side fact extraction.

**Development status:** the core library and unit tests are implemented in T1. Pi event wiring, the tools and command described below arrive in T2; the disposable sandbox arrives in T3. The package manifest already declares their entry points and scripts. Installation and runtime examples require those tasks to be complete.

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
  "recall": {
    "policy": "smart",
    "budget": "low",
    "maxTokens": 1024,
    "timeoutMs": 2500,
    "minPromptChars": 12,
    "maxAutoRecallsPerSession": 20,
    "topicShiftThreshold": 0.15,
    "display": true
  },
  "retain": {
    "auto": true,
    "ephemeral": true,
    "includeToolCalls": true,
    "timeoutMs": 5000,
    "shutdownFlushMs": 3000,
    "segmentChars": 60000,
    "extraTags": []
  }
}
```

Optional global fields are `apiToken`, `project` (override project naming), and `recall.types` (an array containing `world`, `experience`, and/or `observation`). `budget` accepts `low`, `mid`, or `high`. Durations and size limits must be positive safe integers; `minPromptChars` and `maxAutoRecallsPerSession` also accept zero. `topicShiftThreshold` must be between zero and one.

The project file `<cwd>/.pi/hindsight-memory.json` may only restrict behavior:

```json
{
  "enabled": false,
  "recall": { "policy": "off" },
  "retain": { "auto": false }
}
```

Allowed restrictions are `enabled:false`, `retain.auto:false`, and `recall.policy:"off"` or `"first"`. Project files cannot enable globally disabled behavior, change credentials, redirect traffic, select a bank, alter tags, or change any other option. A project `first` never overrides a global `off`. Other project fields are ignored. This restriction applies independently of Pi's own project trust mechanism.

Projects share the default bank `pi`. Retrieval uses `project:<name>` with `tags_match:"any"`, so it includes matching project memories and untagged global memories. Retention tags are `harness:pi`, `project:<name>`, `session:<id>`, plus `retain.extraTags`; observation scopes contain only `project:<name>` so observations consolidate across sessions. Project names derive from the repository's Git common directory, making worktrees share a name, and fall back to the working directory basename. Tags provide retrieval scope; use separate banks and server access controls when a hard privacy boundary is required.

## Recall behavior

`smart` skips disabled or paused memory, an open circuit breaker, custom-triggered runs, short prompts and acknowledgements such as `ok`, `continue`, and `thanks`. It also respects the per-session automatic recall budget. Eligible prompts recall on the first query, after compaction, on explicit memory cues (`remember`, `last time`, `we decided`, `convention`, etc.), or on a topic shift. Topic shifts require at least 40 characters and Jaccard similarity of content words below `topicShiftThreshold` relative to the last recall query.

`always` recalls every eligible nontrivial prompt within the budget. `first` skips later topic shifts; the specified rule ordering still allows explicit cues and post-compaction recall. `off` disables automatic recall. Manual recall and the model tool complement these automatic policies.

Queries are bounded to approximately 500 tokens using a Unicode byte-cost estimate. Recall is retrieval only: no extra model calls for gating, relevance judging or query rewriting. Hits already injected on the active branch are removed; an empty or duplicate-only response adds no message. Recalled content is enclosed in an escaped `<hindsight_memory>` block labeled as untrusted reference data.

Pi wiring stores one `hindsight-memory.recall` custom message immediately after the user prompt. Persisting the message preserves an auditable, cache-friendly prefix instead of rewriting the system prompt. The model still pays for retrieved input tokens, typically once at full price and then through cache reads. Heuristics can miss relevant history or retrieve irrelevant hits; tools remain useful for explicit historical questions.

## Retention behavior and privacy

After a settled prompt, the extension renders the active branch as timestamped user and assistant text. It includes compact tool-call arguments when `includeToolCalls:true`; failed tools contribute only a bounded one-line error marker. It excludes thinking, images, successful tool-result bodies, recall injections, hidden custom messages, compaction and branch summaries, system messages, and `!!` shell commands. Ordinary `!` shell commands retain their command text, without raw command output. Redaction happens before message and argument caps. Messages are capped at 4,000 characters; tool arguments at 200 characters and error text at 300.

Redaction recognizes PEM private keys, AWS access IDs, GitHub tokens, OpenAI/Anthropic-style `sk-` keys, Slack tokens, Google API keys, JWTs, Bearer credentials, URL user/password credentials and secret-like values assigned to common key names. Replacements use `[REDACTED:<kind>]`. Ordinary expressions such as `token = getToken()` are preserved. Pattern-based redaction cannot recognize every credential or private fact; review what you send, disable automatic retention for sensitive projects, or set `includeToolCalls:false` to reduce exposure through arguments.

Messages are packed into segments of at most `segmentChars` characters. Oversized individual messages are split deterministically. Appending messages preserves all earlier frozen segments. Each changed segment is retained asynchronously as `pi:<sessionId>:<segment>` with a SHA-256 content hash; unchanged acknowledged segments are skipped. Hindsight upserts the document and reuses unchanged chunks, avoiding repeated extraction of a stable prefix. Branch rewrites update affected segments and delete acknowledged higher segments that no longer exist.

The writer allows one request in flight, coalesces pending snapshots to the latest, and retries transient network/timeouts, HTTP 429, and HTTP 5xx errors at most twice after 500 ms and 1,500 ms. Each segment submission uses one generated operation ID across its retries. Only successful responses acknowledge hashes. A successful HTTP submission means the server accepted asynchronous work; it does not mean extraction has completed.

Graceful shutdown checkpoints and waits at most `shutdownFlushMs` (default 3 seconds). Work still pending at that bound may be lost on exit; crashes or SIGKILL can lose the current prompt. Forks exclude inherited branch entry IDs to avoid re-retaining the parent transcript. Resumed sessions use their existing session ID. Ephemeral `--no-session` sessions still have an ID and are retained by default; set `retain.ephemeral:false` globally to exclude them.

Recall times out after 2.5 seconds by default; retain requests after 5 seconds. Three consecutive failures open a circuit breaker for 60 seconds. A later checkpoint after cooldown can submit the current transcript again. A missing bank returns empty recall until the first retain creates it. Pi event handlers fail open, report status, and limit UI warnings to once per session per kind.

## Tools and commands

The Pi wiring supplies these controls:

| Control                     | Behavior                                                                 |
| --------------------------- | ------------------------------------------------------------------------ |
| `/hindsight status`         | Show server URL, bank, project, policy, recent results and breaker state |
| `/hindsight pause`          | Persist a branch-local pause for automatic recall and retention          |
| `/hindsight resume`         | Persist a branch-local resume                                            |
| `/hindsight recall <query>` | Display a manual preview without injecting it into model context         |
| `/hindsight checkpoint`     | Request a checkpoint                                                     |
| `/hindsight forget`         | Confirm deletion of this session's conversation documents                |
| `hindsight_recall` tool     | Model-directed retrieval with `query` and optional `max_tokens`          |
| `hindsight_retain` tool     | Retain a redacted durable fact with `content` and optional `context`     |

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

`npm run e2e:check` checks each sandbox JavaScript file independently, shell syntax, Compose configuration and assertion helper tests. `npm run e2e` runs the full disposable sandbox journey after T3 supplies `e2e/`: Hindsight on `127.0.0.1:18890` with no-LLM chunk extraction and a local model stub on `127.0.0.1:18891`. It must never touch an existing Hindsight service on `:18889`. The sandbox is separate from normal installation and uses no external LLM calls.
