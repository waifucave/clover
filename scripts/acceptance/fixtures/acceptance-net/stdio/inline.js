// NetProbe, short enough to paste as one argument (a manifest's string is at most 4096 characters), for the run's pasted MCP config: ports from ACCEPTANCE_NET_PORTS; no dollar-brace anywhere (the manifest's substitutions).
const [g, u] = (process.env.ACCEPTANCE_NET_PORTS || "0,0").split(",");
const net = require("node:net");
const get = async (x) => { try { const r = await fetch(x, { signal: AbortSignal.timeout(8000) }); return r.status + ":" + (await r.text()).replace(/\s+/g, "_").slice(0, 80); } catch (e) { return "none:" + String(e && (e.code || e.name)); } };
const direct = () => new Promise((res) => { const s = net.connect({ host: "127.0.0.1", port: Number(g) }); const d = (v) => { s.destroy(); res(v); }; s.setTimeout(2000, () => d("denied")); s.once("connect", () => d("reached")); s.once("error", () => d("denied")); });
const probe = async () => "acceptance-net-pong granted=" + (await get("http://localhost:" + g + "/net-page")) + " ungranted=" + (await get("http://localhost:" + u + "/")).split(":")[0] + " direct=" + (await direct()) + " proxied=" + (process.env.HTTP_PROXY ? "yes" : "no");
const T = [{ name: "NetProbe", description: "Fetches the acceptance run's site.", inputSchema: { type: "object", properties: {}, additionalProperties: false } }];
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
let b = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => {
  b += c;
  for (let i = b.indexOf("\n"); i >= 0; i = b.indexOf("\n")) {
    const l = b.slice(0, i).trim(); b = b.slice(i + 1);
    if (!l) continue;
    let m; try { m = JSON.parse(l); } catch { continue; }
    if (m.id === undefined) continue;
    const p = m.params || {};
    if (m.method === "initialize") send({ id: m.id, result: { protocolVersion: p.protocolVersion || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "accnet", version: "1" } } });
    else if (m.method === "tools/list") send({ id: m.id, result: { tools: T } });
    else if (m.method === "tools/call") void probe().then((t) => send({ id: m.id, result: { content: [{ type: "text", text: t }] } }));
    else send({ id: m.id, result: {} });
  }
});
process.stdin.on("end", () => process.exit(0));
