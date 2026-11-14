import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import {
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { CircuitBreaker } from "./core/breaker.js";
import {
  HindsightClient,
  HindsightError,
  type MentalModel,
} from "./core/client.js";
import { loadConfig } from "./core/config.js";
import { collapseDuplicates, restatedFacts } from "./core/dedup.js";
import { digestSpec } from "./core/digest.js";
import {
  formatDigestBlock,
  formatHitsForTool,
  formatRecallBlock,
  RECALL_CUSTOM_TYPE,
  type RecallDetails,
  STATE_ENTRY_TYPE,
} from "./core/format.js";
import { boundQuery, decideRecall, type RecallReason } from "./core/policy.js";
import { deriveProjectName } from "./core/project.js";
import { redactSecrets } from "./core/redact.js";
import { reconstructState } from "./core/state.js";
import { renderMessages, segmentMessages } from "./core/transcript.js";
import { CheckpointWriter, documentIdFor } from "./core/writer.js";

function readConfig(cwd: string) {
  return loadConfig({
    env: process.env,
    agentDir: getAgentDir(),
    cwd,
    readFile: (path) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return undefined;
      }
    },
  });
}

// Supplemental state is stored outside model context, including successful empty recalls.
function replay(branch: readonly SessionEntry[]) {
  return reconstructState(
    branch.map((entry): SessionEntry => {
      if (entry.type === "custom" && entry.customType === STATE_ENTRY_TYPE) {
        const data = entry.data as { recall?: RecallDetails } | undefined;
        if (data?.recall)
          return {
            ...entry,
            type: "custom_message",
            customType: RECALL_CUSTOM_TYPE,
            content: "",
            display: false,
            details: data.recall,
          };
      }
      return entry;
    }),
  );
}

export default function hindsightMemory(pi: ExtensionAPI): void {
  let runtime: ReturnType<typeof createRuntime> | undefined;

  function createRuntime(ctx: ExtensionContext, project: string) {
    const { config, warnings } = readConfig(ctx.cwd);
    const sessionId = ctx.sessionManager.getSessionId();
    const canRetain =
      process.env.PI_SUBAGENT_CHILD !== "1" || config.subagents === "full";
    const controller = new AbortController();
    const breaker = new CircuitBreaker();
    let closed = false;
    let forgetting = false;
    let lastRecall = "none";
    let lastRetain = "none";
    let digest: MentalModel | undefined;
    let digestStatus = "off";
    const notices = new Set<string>();
    let state = replay(ctx.sessionManager.getBranch());
    let forkBaseline = new Set<string>();
    const documents = new Set<number>();
    const client = new HindsightClient({
      ...config,
      fetch: async (input, init) => {
        if (controller.signal.aborted)
          throw new HindsightError("Hindsight stopped", "parse");
        try {
          return await fetch(input, {
            ...init,
            signal: AbortSignal.any([
              controller.signal,
              ...(init?.signal ? [init.signal] : []),
            ]),
          });
        } catch (error) {
          // A nonretryable error prevents writer retries after cancellation.
          if (controller.signal.aborted)
            throw new HindsightError("Hindsight stopped", "parse");
          throw error;
        }
      },
    });
    const status = () => {
      if (ctx.hasUI && !closed)
        ctx.ui.setStatus(
          "hindsight",
          `Hindsight: ${!config.enabled ? "disabled" : state.paused ? "paused" : breaker.isOpen() ? "unavailable" : "ready"}`,
        );
    };
    const warn = (kind: string, message: string) => {
      if (closed || notices.has(kind)) return;
      notices.add(kind);
      if (ctx.hasUI) ctx.ui.notify(message, "warning");
    };
    const writer = new CheckpointWriter({
      client,
      timeoutMs: config.retain.timeoutMs,
      breaker,
      sleep: async (ms) => {
        try {
          await delay(ms, undefined, { signal: controller.signal });
        } catch {
          throw new HindsightError("Hindsight stopped", "parse");
        }
      },
      onResult: (result) => {
        if (!result.ok) lastRetain = "unavailable";
        else if (result.sent > 0)
          lastRetain = `saved ${result.sent} segment(s)`;
        if (!result.ok) warn("retain", "Hindsight checkpoint unavailable.");
        status();
      },
    });
    const persist = (data: unknown) => pi.appendEntry(STATE_ENTRY_TYPE, data);
    const restore = () => {
      const branch = ctx.sessionManager.getBranch();
      state = replay(branch);
      forkBaseline = new Set();
      for (const entry of ctx.sessionManager.getEntries()) {
        if (entry.type !== "custom" || entry.customType !== STATE_ENTRY_TYPE)
          continue;
        const data = entry.data as
          | { sessionId?: string; forkBaseline?: string[] }
          | undefined;
        if (data?.sessionId === sessionId && data.forkBaseline)
          forkBaseline = new Set(data.forkBaseline);
      }
      // Remember all submitted document indices, including abandoned branches and resumed runs.
      for (const entry of ctx.sessionManager.getEntries()) {
        if (entry.type !== "custom" || entry.customType !== STATE_ENTRY_TYPE)
          continue;
        const data = entry.data as
          | { sessionId?: string; segments?: number[] }
          | undefined;
        if (data?.sessionId === sessionId)
          for (const index of data.segments ?? []) documents.add(index);
      }
      status();
    };
    restore();
    const tags = () => [
      "harness:pi",
      `project:${project}`,
      `session:${sessionId}`,
      ...config.retain.extraTags,
    ];
    const checkpoint = (manual = false) => {
      if (
        closed ||
        forgetting ||
        !config.enabled ||
        !canRetain ||
        state.paused ||
        breaker.isOpen()
      )
        return;
      if (!manual && !config.retain.auto) return;
      if (!config.retain.ephemeral && !ctx.sessionManager.getSessionFile())
        return;
      const branch = ctx.sessionManager.getBranch();
      if (
        !manual &&
        branch.filter(
          (entry) =>
            !forkBaseline.has(entry.id) &&
            entry.type === "message" &&
            entry.message.role === "user",
        ).length < config.retain.minUserTurns
      )
        return;
      const rendered = renderMessages(branch, {
        includeToolCalls: config.retain.includeToolCalls,
        excludeEntryIds: forkBaseline,
      });
      const segments = segmentMessages(
        rendered.messages,
        config.retain.segmentChars,
      );
      if (!writer.busy) {
        const acknowledged = writer.ackedHashes(sessionId);
        if (
          acknowledged.size === segments.length &&
          segments.every(
            (segment) => acknowledged.get(segment.index) === segment.hash,
          )
        )
          return;
      }
      const added = segments.filter((s) => !documents.has(s.index));
      if (added.length) {
        for (const s of added) documents.add(s.index);
        persist({ sessionId, segments: added.map((s) => s.index) });
      }
      writer.submit({
        sessionId,
        segments,
        tags: tags(),
        context: `Pi coding-agent session in project ${project}`,
        metadata: {
          harness: "pi",
          project,
          session_id: sessionId,
          cwd: ctx.cwd,
        },
        observationScopes: [[`project:${project}`]],
      });
    };
    const recall = async (
      query: string,
      reason: RecallReason,
      maxTokens = config.recall.maxTokens,
      signal?: AbortSignal,
    ) => {
      if (closed || forgetting || !config.enabled || breaker.isOpen())
        throw new HindsightError("Hindsight disabled or unavailable", "parse");
      const started = Date.now();
      try {
        const hits = await client.recall({
          query: boundQuery(query),
          budget: config.recall.budget,
          maxTokens,
          tags: [`project:${project}`],
          tagsMatch: "any",
          types: config.recall.types,
          preferObservations: config.recall.preferObservations,
          timeoutMs: config.recall.timeoutMs,
          signal,
        });
        breaker.recordSuccess();
        const unique = collapseDuplicates(
          [...new Map(hits.map((hit) => [hit.id, hit])).values()],
          config.recall.dedupThreshold,
        );
        const fresh = unique.filter((hit) => !state.injectedIds.has(hit.id));
        const details: RecallDetails = {
          query: boundQuery(query),
          reason,
          bankId: config.bankId,
          project,
          ids: (reason === "tool" ? unique : fresh).map((hit) => hit.id),
          hitCount: hits.length,
          injectedCount: reason === "manual" ? 0 : fresh.length,
          ms: Date.now() - started,
        };
        if (!closed && reason !== "manual") {
          if (reason !== "tool" || details.ids.length) {
            // Nonempty auto-recalls are persisted by Pi as the returned message instead.
            if (reason === "tool" || !fresh.length)
              persist({ recall: details });
            for (const id of details.ids) state.injectedIds.add(id);
            if (reason !== "tool") {
              state.autoRecalls++;
              state.lastRecallQuery = details.query;
              state.compactedSinceLastRecall = false;
            }
          }
        }
        lastRecall = `${reason}: ${hits.length} hit(s)`;
        status();
        return { hits: unique, fresh, details };
      } catch (error) {
        if (!closed) {
          breaker.recordFailure();
          lastRecall = "unavailable";
          warn("recall", "Hindsight recall unavailable.");
          status();
        }
        throw error;
      }
    };
    // The server refreshes the digest on its own schedule; the session only reads it.
    const digestLoad = (async () => {
      if (!config.enabled || !config.digest.enabled) return;
      const spec = digestSpec(project, config.digest);
      digestStatus = "loading";
      try {
        digest = await client.findMentalModel(
          spec.id,
          spec.tags,
          config.digest.timeoutMs,
        );
        if (!digest) {
          await client.createMentalModel(spec, config.digest.timeoutMs);
          digestStatus = "created; the server is generating it";
        } else if (!digest.content.trim() && digest.isStale) {
          // A digest created before any memories stays empty until its cron; bootstrap it once.
          await client.refreshMentalModel(spec.id, config.digest.timeoutMs);
          digestStatus = "refresh requested; the server is generating it";
        } else
          digestStatus = digest.content.trim()
            ? `ready${digest.lastRefreshedAt ? ` (refreshed ${digest.lastRefreshedAt})` : ""}`
            : "empty; awaiting a server refresh";
      } catch {
        digest = undefined;
        digestStatus = "unavailable";
      }
    })();
    const loadedDigest = async (): Promise<MentalModel | undefined> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          digestLoad,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, config.digest.timeoutMs);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      return digest?.content.trim() ? digest : undefined;
    };
    for (const warning of warnings) warn("config", warning);
    return {
      config,
      canRetain,
      project,
      loadedDigest,
      get digest() {
        return digest;
      },
      breaker,
      writer,
      client,
      recall,
      checkpoint,
      restore,
      get state() {
        return state;
      },
      fork() {
        forkBaseline = new Set(
          ctx.sessionManager.getBranch().map((entry) => entry.id),
        );
        persist({ sessionId, forkBaseline: [...forkBaseline] });
      },
      pause(paused: boolean) {
        state.paused = paused;
        persist({ paused });
        status();
      },
      describe: () =>
        `${new URL(config.apiUrl).origin} | bank: ${config.bankId} | project: ${project} | policy: ${config.recall.policy} | ${state.paused ? "paused" : "active"} | recall: ${lastRecall} | retain: ${lastRetain} | digest: ${digestStatus} | breaker: ${breaker.isOpen() ? "open" : "closed"}`,
      async forget() {
        forgetting = true;
        state.paused = true;
        persist({ paused: true });
        controller.abort();
        await writer.flush(config.retain.timeoutMs);
        // Use a fresh client after the canceled writer has drained.
        const deletionClient = new HindsightClient(config);
        for (const index of documents)
          await deletionClient.deleteDocument(
            documentIdFor(sessionId, index),
            config.retain.timeoutMs,
          );
        status();
      },
      async shutdown() {
        if (closed) return;
        try {
          checkpoint();
        } finally {
          closed = true;
          try {
            await writer.flush(config.retain.shutdownFlushMs);
          } finally {
            controller.abort();
            await writer.flush(0);
            if (ctx.hasUI) ctx.ui.setStatus("hindsight", undefined);
          }
        }
      },
    };
  }

  pi.registerMessageRenderer<RecallDetails>(
    RECALL_CUSTOM_TYPE,
    (message, _options, theme) => ({
      invalidate() {},
      render: (width) => [
        theme.fg(
          "muted",
          `Hindsight: ${message.details?.injectedCount ?? 0} memories${message.details?.digest ? " + project digest" : ""}`.slice(
            0,
            Math.max(0, width),
          ),
        ),
      ],
    }),
  );
  pi.on("session_start", async (event, ctx) => {
    try {
      await runtime?.shutdown();
      const { config } = readConfig(ctx.cwd);
      const project =
        config.project ??
        (await deriveProjectName(ctx.cwd, (cmd, args, opts) =>
          pi.exec(cmd, args, opts),
        ));
      runtime = createRuntime(ctx, project);
      if (event.reason === "fork") runtime.fork();
    } catch {
      runtime = undefined;
      if (ctx.hasUI)
        ctx.ui.notify("Hindsight initialization unavailable.", "warning");
    }
  });
  pi.on("before_agent_start", async (event) => {
    const r = runtime;
    if (!r) return;
    const decision = decideRecall({
      ...r.config.recall,
      enabled: r.config.enabled,
      paused: r.state.paused,
      breakerOpen: r.breaker.isOpen(),
      messageType: event.messageType,
      prompt: event.messageType === "user" ? event.prompt : "",
      priorAutoRecalls: r.state.autoRecalls,
      maxAutoRecalls: r.config.recall.maxAutoRecallsPerSession,
      lastRecallQuery: r.state.lastRecallQuery,
      compactedSinceLastRecall: r.state.compactedSinceLastRecall,
    });
    const wantDigest =
      r.config.enabled &&
      r.config.digest.enabled &&
      !r.state.paused &&
      !r.state.digestInjected &&
      event.messageType === "user";
    const [recalled, digest] = await Promise.all([
      decision.recall
        ? r.recall(decision.query, decision.reason).catch(() => undefined)
        : undefined,
      wantDigest ? r.loadedDigest().catch(() => undefined) : undefined,
    ]);
    const fresh = recalled?.fresh ?? [];
    if (!fresh.length && !digest) return;
    const digestDetails = digest && {
      id: digest.id,
      ...(digest.lastRefreshedAt
        ? { refreshedAt: digest.lastRefreshedAt }
        : {}),
    };
    // An empty recall already persisted its own details, so it must not be replayed twice.
    const details: RecallDetails =
      recalled && fresh.length
        ? {
            ...recalled.details,
            ...(digestDetails ? { digest: digestDetails } : {}),
          }
        : {
            query: "",
            reason: "digest",
            bankId: r.config.bankId,
            project: r.project,
            ids: [],
            hitCount: 0,
            injectedCount: 0,
            ms: 0,
            ...(digestDetails ? { digest: digestDetails } : {}),
          };
    if (digest) r.state.digestInjected = true;
    return {
      message: {
        customType: RECALL_CUSTOM_TYPE,
        content: [
          ...(digest ? [formatDigestBlock(digest.content, digest)] : []),
          ...(fresh.length ? [formatRecallBlock(fresh)] : []),
        ].join("\n\n"),
        display: r.config.recall.display,
        details,
      },
    };
  });
  pi.on("session_compact", () => {
    if (!runtime) return;
    runtime.state.compactedSinceLastRecall = true;
    runtime.state.digestInjected = false;
  });
  pi.on("session_tree", () => runtime?.restore());
  pi.on("agent_settled", () => {
    try {
      runtime?.checkpoint();
    } catch {}
  });
  pi.on("session_shutdown", async () => {
    try {
      await runtime?.shutdown();
    } catch {}
  });

  pi.registerCommand("hindsight", {
    description:
      "Memory status, pause, resume, recall, digest, checkpoint, retry-failed, or forget",
    handler: async (args, ctx) => {
      const r = runtime;
      if (!r) return;
      const [command = "status", ...rest] = args.trim().split(/\s+/);
      try {
        if (command === "pause" || command === "resume")
          r.pause(command === "pause");
        else if (command === "checkpoint") {
          r.checkpoint(true);
          await r.writer.flush(r.config.retain.shutdownFlushMs);
        } else if (command === "recall" && rest.length) {
          const { hits } = await r.recall(rest.join(" "), "manual");
          if (ctx.hasUI) ctx.ui.notify(formatHitsForTool(hits), "info");
        } else if (command === "digest") {
          if (rest[0] === "refresh") {
            if (!r.config.enabled || !r.config.digest.enabled || r.state.paused)
              return;
            await r.loadedDigest();
            const spec = digestSpec(r.project, r.config.digest);
            await r.client.updateMentalModel(spec, r.config.digest.timeoutMs);
            await r.client.refreshMentalModel(
              spec.id,
              r.config.digest.timeoutMs,
              undefined,
              true,
            );
            if (ctx.hasUI)
              ctx.ui.notify(
                "Digest settings updated; full regeneration queued. Reload after it completes to use the new digest.",
                "info",
              );
            return;
          }
          const digest = await r.loadedDigest();
          if (ctx.hasUI)
            ctx.ui.notify(
              digest ? formatDigestBlock(digest.content, digest) : r.describe(),
              "info",
            );
          return;
        } else if (command === "retry-failed" && rest.length === 1) {
          if (!r.config.enabled || !r.canRetain || r.state.paused) return;
          await r.client.retryOperation(
            rest[0] ?? "",
            r.config.retain.timeoutMs,
          );
          if (ctx.hasUI)
            ctx.ui.notify(
              "Operation queued for retry; extraction is not yet complete.",
              "info",
            );
          return;
        } else if (command === "forget") {
          if (
            ctx.hasUI &&
            (await ctx.ui.confirm(
              "Forget session memory?",
              "Delete this session's documents and pause retention?",
            ))
          ) {
            try {
              await r.forget();
            } finally {
              runtime = createRuntime(ctx, r.project);
            }
          }
        } else if (command !== "status" && command !== "") {
          if (ctx.hasUI)
            ctx.ui.notify(
              "Usage: /hindsight status|pause|resume|recall <query>|digest|checkpoint|retry-failed <operation-id>|forget",
              "info",
            );
          return;
        }
        let serverStatus = "";
        if ((command === "status" || command === "") && r.config.enabled) {
          try {
            serverStatus = ` | server failed operations (bank-wide): ${await r.client.failedOperations(r.config.recall.timeoutMs)}`;
          } catch {
            serverStatus = " | server failed operations: unavailable";
          }
        }
        if (ctx.hasUI && runtime)
          ctx.ui.notify(runtime.describe() + serverStatus, "info");
      } catch {
        if (ctx.hasUI)
          ctx.ui.notify("Hindsight command unavailable.", "warning");
      }
    },
  });
  const guidelines = [
    "Use hindsight_recall when project history could affect the task and the available memory does not answer the relevant question, even when other memories or a project digest are already present. Search narrowly for the missing decision, rationale, correction, or evidence; stop when the relevant history is sufficient.",
    "Treat memory as historical reference. Mentioned-at and digest refresh timestamps are not verification times; verify consequential or changeable claims against the current owning source when needed, and preserve material uncertainty and project/task scope.",
    "Use hindsight_retain for durable facts (decisions, conventions, user preferences), not for transient task state. Distinguish proposals and hypotheses from verified outcomes, and keep single-task requests scoped to that task.",
  ];
  const unavailable = () => ({
    content: [
      {
        type: "text" as const,
        text: "Hindsight unavailable: disabled or request failed.",
      },
    ],
    details: undefined,
    isError: true,
  });
  pi.registerTool({
    name: "hindsight_recall",
    label: "Hindsight recall",
    description: "Recall project memories",
    promptGuidelines: guidelines,
    executionMode: "parallel",
    annotations: { readOnlyHint: true },
    parameters: Type.Object({
      query: Type.String({ minLength: 1 }),
      max_tokens: Type.Optional(Type.Integer({ minimum: 1 })),
    }),
    async execute(_id, params, signal) {
      const r = runtime;
      if (!r?.config.tools || !r.config.enabled) return unavailable();
      try {
        const { hits, details } = await r.recall(
          params.query,
          "tool",
          params.max_tokens,
          signal,
        );
        return {
          content: [{ type: "text", text: formatHitsForTool(hits) }],
          details,
        };
      } catch {
        return unavailable();
      }
    },
  });
  pi.registerTool({
    name: "hindsight_retain",
    label: "Hindsight retain",
    description: "Retain a durable project fact",
    promptGuidelines: guidelines,
    executionMode: "parallel",
    parameters: Type.Object({
      content: Type.String({ minLength: 1 }),
      context: Type.Optional(Type.String()),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const r = runtime;
      if (
        !r?.config.tools ||
        !r.config.enabled ||
        !r.canRetain ||
        r.state.paused ||
        r.breaker.isOpen()
      )
        return unavailable();
      try {
        const content = redactSecrets(params.content).text;
        const project = r.project;
        const documentId = `pi:fact:${createHash("sha256")
          .update(project + content)
          .digest("hex")
          .slice(0, 16)}`;
        await r.client.retain({
          operationId: randomUUID(),
          timeoutMs: r.config.retain.timeoutMs,
          signal,
          items: [
            {
              content,
              documentId,
              context: redactSecrets(
                params.context ?? `Durable fact in project ${project}`,
              ).text,
              tags: [
                "harness:pi",
                `project:${project}`,
                `session:${ctx.sessionManager.getSessionId()}`,
                ...r.config.retain.extraTags,
                "kind:explicit",
              ],
              observationScopes: [[`project:${project}`]],
            },
          ],
        });
        r.breaker.recordSuccess();
        const superseded: string[] = [];
        if (r.config.retain.supersede) {
          try {
            const older = await r.client.recall({
              query: boundQuery(content),
              budget: "low",
              maxTokens: r.config.recall.maxTokens,
              tags: [`project:${project}`, "kind:explicit"],
              tagsMatch: "all_strict",
              types: ["world", "experience"],
              timeoutMs: r.config.recall.timeoutMs,
              signal,
            });
            for (const hit of restatedFacts(
              content,
              older,
              documentId,
              r.config.retain.supersedeThreshold,
              r.config.retain.supersedeMinRelevance,
            ))
              if (
                await r.client
                  .invalidateMemory(
                    hit.id,
                    `superseded-by:${documentId}`,
                    r.config.retain.timeoutMs,
                    signal,
                  )
                  .catch(() => false)
              )
                superseded.push(hit.id);
          } catch {}
          if (superseded.length)
            pi.appendEntry(STATE_ENTRY_TYPE, {
              superseded: { by: documentId, ids: superseded },
            });
        }
        return {
          content: [
            {
              type: "text",
              text: superseded.length
                ? `Memory retained; invalidated ${superseded.length} restated older fact(s).`
                : "Memory retained.",
            },
          ],
          details: { documentId, superseded },
        };
      } catch {
        r.breaker.recordFailure();
        return unavailable();
      }
    },
  });
}
