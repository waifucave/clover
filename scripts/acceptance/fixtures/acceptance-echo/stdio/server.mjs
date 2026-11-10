// The acceptance fixture's stdio MCP server (`probe`, one tool, `StdioProbe`): MCP's stdio transport, a JSON-RPC
// message per line, plain JavaScript that Bun and Node both run. A call tries what its plugin's fence must refuse and
// one thing it must allow, and answers with what it saw:
//   data=written|denied     a file in its own data folder (allowed)
//   outside=written|denied  a file outside its folders (the path in stdio/targets, line 2)
//   tree=written|denied     a file in its plugin's own folder
//   direct=reached|denied   127.0.0.1:<port> (stdio/targets, line 1) straight
//   proxied=<status>|none   the same address through its proxy (HTTP_PROXY): no host the plugin declared
// The run checks the disk and its own listener too; this is only the server's side of it.
import { readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";

const root = process.argv[2] ?? "";
const data = process.argv[3] ?? process.cwd();
const [portLine, outside] = (() => { try { return readFileSync(join(root, "stdio", "targets"), "utf8").split("\n"); } catch { return ["0", ""]; } })();
const port = Number(portLine) || 0;

const tryWrite = (path) => { try { writeFileSync(path, "escaped\n"); return "written"; } catch { return "denied"; } };
const tryConnect = () => new Promise((resolve) => {
  const s = connect({ host: "127.0.0.1", port });
  const done = (v) => { s.destroy(); resolve(v); };
  s.setTimeout(2000, () => done("denied"));
  s.once("connect", () => done("reached"));
  s.once("error", () => done("denied"));
});
const tryProxy = () => new Promise((resolve) => {
  const raw = process.env.HTTP_PROXY ?? process.env.http_proxy;
  if (!raw) return resolve("none");
  let u;
  try { u = new URL(raw); } catch { return resolve("none"); }
  const s = connect({ host: u.hostname, port: Number(u.port) || 80 });
  let buf = "";
  const done = (v) => { s.destroy(); resolve(v); };
  s.setTimeout(5000, () => done("none"));
  s.once("error", () => done("none"));
  s.once("connect", () => s.write(`GET http://127.0.0.1:${port}/ HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`));
  s.on("data", (d) => { buf += d.toString("latin1"); const m = /^HTTP\/1\.[01] (\d{3})/.exec(buf); if (m) done(m[1]); });
  s.once("end", () => done(/^HTTP\/1\.[01] (\d{3})/.exec(buf)?.[1] ?? "none"));
});

async function probe() {
  const seen = {
    data: tryWrite(join(data, "stdio-probe-data.txt")),
    outside: outside ? tryWrite(outside) : "denied",
    tree: tryWrite(join(root, "escaped-stdio")),
    direct: await tryConnect(),
    proxied: await tryProxy(),
  };
  return `acceptance-stdio-pong ${Object.entries(seen).map(([k, v]) => `${k}=${v}`).join(" ")}`;
}

const TOOLS = [{
  name: "StdioProbe",
  description: "Tries what this plugin's fence must refuse and answers with what it saw (the acceptance run's stdio tool).",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
}];

const send = (m) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line === "") continue;
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    if (m.id === undefined) continue;
    const params = m.params ?? {};
    if (m.method === "initialize") send({ id: m.id, result: { protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "acceptance-stdio", version: "1" } } });
    else if (m.method === "ping") send({ id: m.id, result: {} });
    else if (m.method === "tools/list") send({ id: m.id, result: { tools: TOOLS } });
    else if (m.method === "tools/call" && params.name === "StdioProbe") void probe().then((text) => send({ id: m.id, result: { content: [{ type: "text", text }] } }));
    else send({ id: m.id, error: { code: -32601, message: `unknown: ${String(m.method)}` } });
  }
});
process.stdin.on("end", () => process.exit(0));
// A line on stderr, which goes to the plugin's log.
process.stderr.write("acceptance stdio server started\n");
