/**
 * Generic HTTP ingest server for iOS Shortcuts data.
 *
 * Registers handlers by path. Each handler parses the POST body,
 * saves data, and optionally returns a Telegram notification.
 *
 * Routes: POST /{path} for each registered handler.
 * Designed for Apple Health, location, activity, exercise, etc.
 */

import { createServer } from "node:http";

export interface IngestResult {
  /** JSON response sent to the HTTP client */
  response: unknown;
  /** If set, sent as a Telegram message */
  notification?: string;
}

export interface IngestHandler {
  /** Route path without leading slash, e.g. "sleep", "activity" */
  path: string;
  /** Process raw POST body, save data, return result */
  handle(body: string): Promise<IngestResult>;
}

export function startIngestServer(
  port: number,
  handlers: IngestHandler[],
  notify: (text: string) => Promise<void>,
): void {
  const routeMap = new Map<string, IngestHandler>();
  for (const h of handlers) {
    routeMap.set(`/${h.path}`, h);
  }

  const server = createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405);
      res.end("Method not allowed");
      return;
    }

    const handler = routeMap.get(req.url ?? "");
    if (!handler) {
      const paths = handlers.map((h) => `POST /${h.path}`).join(", ");
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found", routes: paths }));
      return;
    }

    try {
      const body = await readBody(req);
      console.log(`[ingest] ${handler.path} body (${body.length} bytes): ${body.slice(0, 200)}`);
      const result = await handler.handle(body);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result.response));

      if (result.notification) {
        await notify(result.notification).catch(() => {});
      }
    } catch (e) {
      const err = e as Error;
      console.error(`[ingest] ${handler.path} error: ${err.message}`);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`[ingest] Port ${port} in use — ingest server not started`);
    } else {
      console.error(`[ingest] Server error: ${err.message}`);
    }
  });

  server.listen(port, "0.0.0.0", () => {
    const routes = handlers.map((h) => h.path).join(", ");
    console.log(`Ingest server: http://0.0.0.0:${port} [${routes}]`);
  });
}

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: Buffer) => { data += chunk.toString(); });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}
