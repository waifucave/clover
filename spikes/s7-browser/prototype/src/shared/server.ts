// The spike's local web server, on 127.0.0.1 only: the probe pages, the media clip, a server-sent-events stream (to
// see whether a connection survives a move), and cookie endpoints for the per-bot profile checks. node:http, so the
// Electron main process (Node) and the Bun runners share it.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import type { Duplex } from "node:stream";

export interface SpikeServer {
  readonly server: Server;
  readonly port: number;
  readonly origin: string;
  /** SSE connections opened so far, by the `tab` query value. */
  sseOpens(tab: string): number;
  close(): Promise<void>;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".webm": "video/webm",
  ".png": "image/png",
};

export interface ServerOptions {
  /** Where the built pages are (`out/pages`). */
  pagesDir: string;
  /** Where the fixtures are (`fixtures`). */
  fixturesDir: string;
  /** A WebSocket (or other) upgrade handler. */
  onUpgrade?: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
}

function serveFile(req: IncomingMessage, res: ServerResponse, file: string): void {
  if (!existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
    return;
  }
  const body = readFileSync(file);
  const type = TYPES[extname(file)] ?? "application/octet-stream";
  const range = req.headers.range;
  const m = typeof range === "string" ? /^bytes=(\d*)-(\d*)$/.exec(range) : null;
  if (m !== null) {
    const start = m[1] === "" ? 0 : Number(m[1]);
    const end = m[2] === "" ? body.length - 1 : Math.min(body.length - 1, Number(m[2]));
    if (start > end || start >= body.length) {
      res.writeHead(416, { "content-range": `bytes */${body.length}` });
      res.end();
      return;
    }
    res.writeHead(206, {
      "content-type": type,
      "accept-ranges": "bytes",
      "content-range": `bytes ${start}-${end}/${body.length}`,
      "content-length": String(end - start + 1),
      "cache-control": "no-store",
    });
    res.end(body.subarray(start, end + 1));
    return;
  }
  res.writeHead(200, { "content-type": type, "accept-ranges": "bytes", "content-length": String(body.length), "cache-control": "no-store" });
  res.end(body);
}

/** Resolve `rel` under `dir`, refusing anything that climbs out. */
function under(dir: string, rel: string): string | undefined {
  const p = normalize(join(dir, rel));
  return p === dir || p.startsWith(dir.endsWith(sep) ? dir : dir + sep) ? p : undefined;
}

export function startServer(opts: ServerOptions): Promise<SpikeServer> {
  const opens = new Map<string, number>();
  const streams = new Set<ServerResponse>();
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;
    if (path === "/sse") {
      const tab = url.searchParams.get("tab") ?? "";
      opens.set(tab, (opens.get(tab) ?? 0) + 1);
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      res.write("retry: 500\n\n");
      let seq = 0;
      const timer = setInterval(() => {
        seq++;
        res.write(`id: ${seq}\ndata: ${seq}\n\n`);
      }, 100);
      streams.add(res);
      const done = () => { clearInterval(timer); streams.delete(res); };
      req.on("close", done);
      res.on("close", done);
      return;
    }
    if (path === "/cookie/set") {
      const bot = (url.searchParams.get("bot") ?? "none").replace(/[^a-z0-9-]/gi, "");
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "set-cookie": `s7bot=${bot}; Max-Age=86400; Path=/; SameSite=Lax`,
        "cache-control": "no-store",
      });
      res.end(`<!doctype html><title>set</title><p id="r">set ${bot}</p><script>localStorage.setItem("s7bot", ${JSON.stringify(bot)});</script>`);
      return;
    }
    if (path === "/cookie/read") {
      const cookie = req.headers.cookie ?? "";
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(`<!doctype html><title>read</title><pre id="r">${JSON.stringify({ cookie }).replace(/</g, "\\u003c")}</pre>`);
      return;
    }
    if (path === "/blank") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<!doctype html><title>blank</title><body style=\"margin:0;background:#fff\"></body>");
      return;
    }
    if (path.startsWith("/pages/")) {
      const file = under(opts.pagesDir, path.slice("/pages/".length));
      if (file !== undefined) return serveFile(req, res, file);
    }
    if (path.startsWith("/media/")) {
      const file = under(opts.fixturesDir, path.slice("/media/".length));
      if (file !== undefined) return serveFile(req, res, file);
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });
  if (opts.onUpgrade !== undefined) server.on("upgrade", opts.onUpgrade);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      resolve({
        server,
        port,
        origin: `http://127.0.0.1:${port}`,
        sseOpens: (tab) => opens.get(tab) ?? 0,
        close: () => new Promise<void>((done) => {
          for (const s of streams) s.destroy();
          server.close(() => done());
          // node keeps idle keep-alive sockets; don't wait on them
          setTimeout(done, 500);
        }),
      });
    });
  });
}
