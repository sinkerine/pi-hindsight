import { appendFileSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

function text(content) {
  if (typeof content === "string") return content;
  return (content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n");
}

export function replyFor(messages) {
  // A persisted injection from an earlier turn must not make the "ok" check pass.
  const lastAssistant = messages.findLastIndex((message) => message.role === "assistant");
  const current = messages.slice(lastAssistant + 1).filter((message) => message.role === "user");
  const blocks = current.flatMap((message) => text(message.content).match(/<hindsight_memory\b[^>]*>[\s\S]*?<\/hindsight_memory>/g) ?? []);
  return blocks.length ? blocks.join("\n") : "NO_MEMORY";
}

export function createStubServer({ logPath } = {}) {
  return createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"status":"healthy"}');
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    try {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 4 * 1024 * 1024) throw new Error("Request too large");
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (body.model !== "stub" || !Array.isArray(body.messages)) throw new Error("Expected stub model and messages");
      const content = replyFor(body.messages);
      if (logPath) appendFileSync(logPath, `${JSON.stringify({ request: body, reply: content })}\n`);
      const base = { id: "chatcmpl-e2e", created: 1, model: "stub" };
      if (body.stream) {
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        for (const [delta, finish_reason] of [[{ role: "assistant", content }, null], [{}, "stop"]]) {
          response.write(`data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
        }
        response.end("data: [DONE]\n\n");
      } else {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ...base, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }));
      }
    } catch (error) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: error.message } }));
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const server = createStubServer({ logPath: process.env.E2E_STUB_LOG });
  server.listen(18891, "127.0.0.1", () => console.log("Stub listening on 127.0.0.1:18891"));
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)));
}
