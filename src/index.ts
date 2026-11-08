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
import { HindsightClient, HindsightError } from "./core/client.js";
import { loadConfig } from "./core/config.js";
import {
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
    const controller = new AbortController();
    const breaker = new CircuitBreaker();
    let closed = false;
    let forgetting = false;
    let lastRecall = "none";
    let lastRetain = "none";
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
        state.paused ||
        breaker.isOpen()
      )
        return;
      if (!manual && !config.retain.auto) return;
      if (!config.retain.ephemeral && !ctx.sessionManager.getSessionFile())
        return;
      const rendered = renderMessages(ctx.sessionManager.getBranch(), {
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
          timeoutMs: config.recall.timeoutMs,
          signal,
        });
        breaker.recordSuccess();
        const unique = new Map(hits.map((hit) => [hit.id, hit]));
        const fresh = [...unique.values()].filter(
          (hit) => !state.injectedIds.has(hit.id),
        );
        const details: RecallDetails = {
          query: boundQuery(query),
          reason,
          bankId: config.bankId,
          project,
          ids: (reason === "tool" ? [...unique.values()] : fresh).map(
            (hit) => hit.id,
          ),
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
        return { hits, fresh, details };
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
    for (const warning of warnings) warn("config", warning);
    return {
      config,
      project,
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
        `${new URL(config.apiUrl).origin} | bank: ${config.bankId} | project: ${project} | policy: ${config.recall.policy} | ${state.paused ? "paused" : "active"} | recall: ${lastRecall} | retain: ${lastRetain} | breaker: ${breaker.isOpen() ? "open" : "closed"}`,
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
          `Hindsight: ${message.details?.injectedCount ?? 0} memories`.slice(
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
    if (!decision.recall) return;
    try {
      const { fresh, details } = await r.recall(
        decision.query,
        decision.reason,
      );
      if (fresh.length)
        return {
          message: {
            customType: RECALL_CUSTOM_TYPE,
            content: formatRecallBlock(fresh),
            display: r.config.recall.display,
            details,
          },
        };
    } catch {}
  });
  pi.on("session_compact", () => {
    if (runtime) runtime.state.compactedSinceLastRecall = true;
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
    description: "Memory status, pause, resume, recall, checkpoint, or forget",
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
              "Usage: /hindsight status|pause|resume|recall <query>|checkpoint|forget",
              "info",
            );
          return;
        }
        if (ctx.hasUI && runtime) ctx.ui.notify(runtime.describe(), "info");
      } catch {
        if (ctx.hasUI)
          ctx.ui.notify("Hindsight command unavailable.", "warning");
      }
    },
  });
  const guidelines = [
    "Use hindsight_recall when prior decisions/conventions/history of this project would help and no recalled memory is present; use hindsight_retain for durable facts (decisions, conventions, user preferences), not for transient task state.",
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
        return {
          content: [{ type: "text", text: "Memory retained." }],
          details: { documentId },
        };
      } catch {
        r.breaker.recordFailure();
        return unavailable();
      }
    },
  });
}
