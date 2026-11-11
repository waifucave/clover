// The acceptance page fixture's stdio MCP server (`page`, one tool, `PageProbe`): MCP's stdio transport, a JSON-RPC
// message per line. The run lists it like any installed plugin's server while it is installed; nothing calls its tool.
const TOOLS = [{
  name: "PageProbe",
  description: "Answers pong (the acceptance run's Plugins page fixture).",
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
    if (m.method === "initialize") send({ id: m.id, result: { protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "acceptance-page", version: "1" } } });
    else if (m.method === "ping") send({ id: m.id, result: {} });
    else if (m.method === "tools/list") send({ id: m.id, result: { tools: TOOLS } });
    else if (m.method === "tools/call" && params.name === "PageProbe") send({ id: m.id, result: { content: [{ type: "text", text: "acceptance-page-pong" }] } });
    else send({ id: m.id, error: { code: -32601, message: `unknown: ${String(m.method)}` } });
  }
});
process.stdin.on("end", () => process.exit(0));
