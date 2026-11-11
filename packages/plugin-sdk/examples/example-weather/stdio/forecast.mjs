// The Weather plugin's forecast server: an MCP server on stdio (a JSON-RPC message per line), plain JavaScript that Bun
// runs with no dependency. Clover starts it fenced: it reads and writes only its own data folder (its first argument),
// and reaches the network only through the proxy Clover hands it (HTTP_PROXY), which lets through the one host the
// manifest names. Its key is read from the file WEATHER_KEY_FILE names (`${secretFile:…}`: mode 0600, readable only by
// this plugin's processes, where an environment variable could be read by other processes of the user); it never goes
// into an answer.
//
// Tools: forecast (only reads, but the plugin reaches the network, so it still asks) and save_place (keeps the user's
// usual place in its data folder; it only changes the plugin's own state, but asks for the same reason).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const data = process.argv[2] ?? "";
const base = (process.env.WEATHER_URL ?? "").replace(/\/+$/, "");
const readKey = () => { try { return readFileSync(process.env.WEATHER_KEY_FILE ?? "", "utf8").trim(); } catch { return ""; } };
const placeFile = data === "" ? "" : join(data, "place.txt");

const clean = (v) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) : "");
const savedPlace = () => { try { return clean(readFileSync(placeFile, "utf8")); } catch { return ""; } };

async function forecast(args) {
  const place = clean(args.place) || savedPlace();
  if (place === "") return { text: "Say which place, or save one with save_place first.", isError: true };
  const key = readKey();
  if (key === "") return { text: "The weather service's key isn't set: enter it on the Plugins page (Weather, Enter key…).", isError: true };
  let r;
  try {
    r = await fetch(`${base}/forecast?place=${encodeURIComponent(place)}`, { headers: { "x-api-key": key }, signal: AbortSignal.timeout(10_000) });
  } catch (err) {
    return { text: `The weather service didn't answer (${err?.code ?? err?.name ?? "error"}).`, isError: true };
  }
  if (r.status === 401 || r.status === 403) return { text: "The weather service refused the key: check it on the Plugins page.", isError: true };
  if (!r.ok) return { text: `The weather service answered ${r.status}.`, isError: true };
  const f = await r.json().catch(() => undefined);
  if (f === undefined || typeof f.summary !== "string") return { text: "The weather service sent something that isn't a forecast.", isError: true };
  const temp = typeof f.tempC === "number" ? `, ${Math.round(f.tempC)}°C` : "";
  return { text: `Forecast for ${place}: ${clean(f.summary)}${temp}.`, structured: { kind: "weather", label: place, value: `${clean(f.summary)}${temp}` } };
}

function savePlace(args) {
  const place = clean(args.place);
  if (place === "") return { text: "Say which place.", isError: true };
  try { writeFileSync(placeFile, place + "\n"); } catch { return { text: "Couldn't keep the place.", isError: true }; }
  return { text: `Saved your place: ${place}.`, structured: { kind: "place", label: "Place", value: place } };
}

const TOOLS = [
  {
    name: "forecast",
    title: "Get the forecast",
    description: "Today's forecast for a place (or the saved one), from the user's weather service. It only reads.",
    inputSchema: { type: "object", properties: { place: { type: "string", maxLength: 60 } }, additionalProperties: false },
  },
  {
    name: "save_place",
    title: "Save my place",
    description: "Keep the user's usual place for forecasts. It only changes this plugin's own state.",
    inputSchema: { type: "object", properties: { place: { type: "string", minLength: 1, maxLength: 60 } }, required: ["place"], additionalProperties: false },
  },
];

const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
async function handle(m) {
  if (typeof m.id !== "number" && typeof m.id !== "string") return; // a notification
  const params = m.params ?? {};
  if (m.method === "initialize") return send({ id: m.id, result: { protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "forecast", version: "1.0.0" } } });
  if (m.method === "ping") return send({ id: m.id, result: {} });
  if (m.method === "tools/list") return send({ id: m.id, result: { tools: TOOLS } });
  if (m.method === "tools/call") {
    const args = params.arguments !== null && typeof params.arguments === "object" ? params.arguments : {};
    const r = params.name === "forecast" ? await forecast(args) : params.name === "save_place" ? savePlace(args) : undefined;
    if (r === undefined) return send({ id: m.id, error: { code: -32602, message: "unknown tool" } });
    return send({ id: m.id, result: { content: [{ type: "text", text: r.text }], ...(r.isError ? { isError: true } : {}), ...(r.structured ? { structuredContent: r.structured } : {}) } });
  }
  send({ id: m.id, error: { code: -32601, message: "unknown method" } });
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line === "") continue;
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    void handle(m).catch(() => undefined);
  }
});
