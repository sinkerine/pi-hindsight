import { createServer, type ServerResponse } from "node:http";

export interface RecordedRequest {
  method: string;
  path: string;
  body: Record<string, unknown>;
}
export async function mockHindsight() {
  const requests: RecordedRequest[] = [];
  let recallStatus = 200;
  let retainStatus = 200;
  let hangRecall = false;
  let hangRetain = false;
  let hits = [{ id: "memory-1", text: "Deploy with make ship. ZEBRA-42." }];
  const waiting = new Set<ServerResponse>();
  const server = createServer(async (req, res) => {
    let content = "";
    for await (const part of req) content += part;
    const body = content ? JSON.parse(content) : {};
    const path = req.url ?? "/";
    requests.push({ method: req.method ?? "GET", path, body });
    res.setHeader("Content-Type", "application/json");
    if (path.endsWith("/recall")) {
      if (hangRecall) {
        waiting.add(res);
        return;
      }
      res.writeHead(recallStatus).end(JSON.stringify({ results: hits }));
    } else if (req.method === "DELETE") {
      res.end("{}");
    } else if (path.endsWith("/memories")) {
      if (hangRetain) {
        waiting.add(res);
        return;
      }
      res
        .writeHead(retainStatus)
        .end(JSON.stringify({ operation_id: body.operation_id }));
    } else res.end('{"status":"healthy"}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw Error("Missing server port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    recalls: () => requests.filter((r) => r.path.endsWith("/recall")),
    retains: () =>
      requests.filter(
        (r) => r.method === "POST" && r.path.endsWith("/memories"),
      ),
    deletes: () => requests.filter((r) => r.method === "DELETE"),
    hits(value: typeof hits) {
      hits = value;
    },
    recallStatus(value: number) {
      recallStatus = value;
    },
    retainStatus(value: number) {
      retainStatus = value;
    },
    hangRecall(value = true) {
      hangRecall = value;
    },
    hangRetain(value = true) {
      hangRetain = value;
    },
    async close() {
      for (const response of waiting) response.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
