import { randomUUID } from "node:crypto";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionEntry,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

export function fakePi(
  cwd: string,
  branch: SessionEntry[] = [],
  sessionId = "session-test",
) {
  const handlers = new Map<
    string,
    (event: never, ctx: ExtensionContext) => unknown
  >();
  const tools = new Map<string, ToolDefinition>();
  const entries = [...branch];
  let command:
    | ((args: string, ctx: ExtensionCommandContext) => Promise<void>)
    | undefined;
  const notices: string[] = [];
  const statuses: (string | undefined)[] = [];
  let confirmed = true;
  let ephemeral = false;
  const context = {
    cwd,
    hasUI: true,
    mode: "tui",
    ui: {
      notify: (text: string) => notices.push(text),
      setStatus: (_key: string, value: string | undefined) =>
        statuses.push(value),
      confirm: async () => confirmed,
    },
    sessionManager: {
      getBranch: () => [...branch],
      getEntries: () => [...entries],
      getSessionId: () => sessionId,
      getSessionFile: () => (ephemeral ? undefined : "/tmp/fake-session.jsonl"),
    },
  } as unknown as ExtensionCommandContext;
  const append = (entry: object) => {
    const added = {
      id: randomUUID(),
      parentId: branch.at(-1)?.id ?? null,
      timestamp: new Date().toISOString(),
      ...entry,
    } as SessionEntry;
    branch.push(added);
    entries.push(added);
  };
  const api = {
    on: (
      event: string,
      handler: (event: never, ctx: ExtensionContext) => unknown,
    ) => {
      handlers.set(event, handler);
    },
    registerTool: (tool: ToolDefinition) => {
      tools.set(tool.name, tool);
    },
    registerCommand: (
      _name: string,
      definition: { handler: typeof command },
    ) => {
      command = definition.handler;
    },
    registerMessageRenderer: () => {},
    exec: async () => ({
      stdout: "/repos/demo/.git\n",
      stderr: "",
      code: 0,
      killed: false,
    }),
    appendEntry: (customType: string, data: unknown) =>
      append({ type: "custom", customType, data }),
    sendMessage: () => {
      throw new Error("Manual preview must not enter model context");
    },
  } as unknown as ExtensionAPI;
  return {
    api,
    context,
    branch,
    notices,
    statuses,
    tools,
    append,
    confirm(value: boolean) {
      confirmed = value;
    },
    ephemeral(value: boolean) {
      ephemeral = value;
    },
    user(text: string) {
      append({
        type: "message",
        message: { role: "user", content: text, timestamp: Date.now() },
      });
    },
    async emit(event: string, payload: object = {}) {
      return await handlers.get(event)?.(
        { type: event, ...payload } as never,
        context,
      );
    },
    async prompt(prompt: string) {
      this.user(prompt);
      const result = (await this.emit("before_agent_start", {
        messageType: "user",
        prompt,
      })) as { message?: object } | undefined;
      if (result?.message)
        append({ type: "custom_message", ...result.message });
      return result;
    },
    async command(args: string) {
      await command?.(args, context);
    },
    async tool(name: string, params: Record<string, unknown>) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`Missing tool ${name}`);
      return await tool.execute(
        "call",
        params,
        undefined,
        undefined,
        context as never,
      );
    },
  };
}
