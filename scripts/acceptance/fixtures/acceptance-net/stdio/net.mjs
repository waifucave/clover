// The acceptance fixture's network probe (`NetProbe`, a stdio MCP server's one tool): MCP's stdio transport, a JSON-RPC
// message per line, plain JavaScript Bun runs. A call answers with what it saw:
//   granted=<status>:<body>  http://localhost:<port>/net-page through its proxy (its one granted host, stdio/targets line 1)
//   ungranted=<status>|none  http://localhost:<port>/ through its proxy, a port it wasn't granted (stdio/targets line 2)
//   direct=reached|denied    127.0.0.1:<granted port> straight, around the proxy
// No dollar-brace anywhere: a pasted config's args take the manifest's substitutions. It keeps the proxy it was given in its data folder (acceptance-net-proxy), for the run's borrowing check; the token
// never goes into an answer. Run as a pasted MCP config (open network, no proxy), the same calls go straight.
import { readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";

const root = process.argv[2] ?? "";
const data = process.argv[3] ?? "";
// The ports: ACCEPTANCE_NET_PORTS (a pasted config's env, run inline with no folder of its own), else stdio/targets.
const [grantedLine, ungrantedLine] = process.env.ACCEPTANCE_NET_PORTS !== undefined
  ? process.env.ACCEPTANCE_NET_PORTS.split(",")
  : (() => { try { return readFileSync(join(root, "stdio", "targets"), "utf8").split("\n"); } catch { return ["0", "0"]; } })();
const granted = Number(grantedLine) || 0;
const ungranted = Number(ungrantedLine) || 0;
const proxy = process.env.HTTP_PROXY ?? process.env.http_proxy ?? "";
if (data !== "" && proxy !== "") { try { writeFileSync(join(data, "acceptance-net-proxy"), proxy + "\n"); } catch { /* fenced */ } }

const get = async (url) => {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const text = (await r.text()).replace(/\s+/g, " ").slice(0, 80);
    return r.status + ":" + text;
  } catch (err) {
    return "none:" + String(err?.code ?? err?.name ?? "error");
  }
};
const tryConnect = () => new Promise((resolve) => {
  const s = connect({ host: "127.0.0.1", port: granted });
  const done = (v) => { s.destroy(); resolve(v); };
  s.setTimeout(2000, () => done("denied"));
  s.once("connect", () => done("reached"));
  s.once("error", () => done("denied"));
});

async function probe() {
  const seen = {
    granted: (await get("http://localhost:" + granted + "/net-page")).replace(/\s/g, "_"),
    ungranted: (await get("http://localhost:" + ungranted + "/")).split(":")[0],
    direct: await tryConnect(),
    proxied: proxy === "" ? "no" : "yes",
  };
  return "acceptance-net-pong " + Object.entries(seen).map(([k, v]) => k + "=" + v).join(" ");
}

const TOOLS = [{
  name: "NetProbe",
  description: "Fetches the acceptance run's site through this plugin's network and answers with what it saw.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
}];

const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
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
    if (m.method === "initialize") send({ id: m.id, result: { protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "acceptance-net", version: "1" } } });
    else if (m.method === "ping") send({ id: m.id, result: {} });
    else if (m.method === "tools/list") send({ id: m.id, result: { tools: TOOLS } });
    else if (m.method === "tools/call" && params.name === "NetProbe") void probe().then((text) => send({ id: m.id, result: { content: [{ type: "text", text }] } }));
    else send({ id: m.id, error: { code: -32601, message: "unknown: " + String(m.method) } });
  }
});
process.stdin.on("end", () => process.exit(0));
