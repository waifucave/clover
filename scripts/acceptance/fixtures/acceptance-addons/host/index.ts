// The acceptance fixture with add-ons of its own (spec §5.4): a stamp is `<data>/addons/<name>.json`, `{ "stamp": "WORD" }`.
// `StampRun { addon, text }` runs one only when its hash is in the plugin's synced store (`trusted`), put there after the
// user's yes to the plugin's own question card (`confirm`); a no runs nothing. Each start of the host half counts itself
// in `<data>/starts` (the Plugins page's Restart row reads it). No network, no other process.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface McpServerTransport {
  start(): Promise<void>;
  send(message: Record<string, unknown>): Promise<void>;
  close(): Promise<void>;
  onmessage?: (message: Record<string, unknown>) => void;
}
interface Api {
  storage: { dataFolder?: string; synced: { get<T>(key: string): Promise<T | undefined>; set(key: string, value: unknown): Promise<void> } };
  confirm(text: string): Promise<boolean>;
}

const TOOLS = [{
  name: "StampRun",
  description: "Runs one of the plugin's stamps (its add-ons) on a text.",
  inputSchema: { type: "object", properties: { addon: { type: "string" }, text: { type: "string" } }, required: ["addon", "text"], additionalProperties: false },
}];

let api: Api | undefined;
let starts = 0;

export async function start(a: Api): Promise<void> {
  api = a;
  const data = a.storage.dataFolder;
  if (data === undefined) return;
  mkdirSync(data, { recursive: true });
  try { starts = Number(readFileSync(join(data, "starts"), "utf8")) || 0; } catch { starts = 0; }
  starts += 1;
  writeFileSync(join(data, "starts"), String(starts));
}
export async function stop(): Promise<void> {}

async function run(addon: string, text: string): Promise<string> {
  if (api?.storage.dataFolder === undefined) throw new Error("no data folder");
  if (!/^[a-z0-9-]{1,40}$/.test(addon)) throw new Error("an add-on's name is lowercase letters, digits and dashes");
  const raw = readFileSync(join(api.storage.dataFolder, "addons", `${addon}.json`), "utf8");
  const hash = createHash("sha256").update(raw).digest("hex");
  const stamp = String((JSON.parse(raw) as { stamp?: unknown }).stamp ?? "").slice(0, 40);
  const trusted = (await api.storage.synced.get<string[]>("trusted")) ?? [];
  let asked = "trusted already";
  if (!trusted.includes(hash)) {
    const yes = await api.confirm(`Run the stamp "${addon}" (${hash.slice(0, 12)})? It writes "${stamp}" on the text it's given.`);
    if (!yes) return `acceptance-addons: not run: the user said no to ${addon} (${hash.slice(0, 12)})`;
    await api.storage.synced.set("trusted", [...trusted, hash]);
    asked = "trusted on the user's yes";
  }
  return `acceptance-addons-stamped: ${stamp}: ${text} (${asked}; host start ${starts})`;
}

export const mcp = {
  stamps: async (transport: McpServerTransport): Promise<void> => {
    const reply = (id: unknown, body: Record<string, unknown>) => void transport.send({ jsonrpc: "2.0", id, ...body }).catch(() => {});
    transport.onmessage = (m) => {
      if (m.id === undefined) return;
      const params = (m.params ?? {}) as Record<string, unknown>;
      if (m.method === "initialize") {
        reply(m.id, { result: { protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "acceptance-addons", version: "1" } } });
      } else if (m.method === "ping") {
        reply(m.id, { result: {} });
      } else if (m.method === "tools/list") {
        reply(m.id, { result: { tools: TOOLS } });
      } else if (m.method === "tools/call" && params.name === "StampRun") {
        const a = (params.arguments ?? {}) as { addon?: unknown; text?: unknown };
        run(String(a.addon ?? ""), String(a.text ?? "")).then(
          (text) => reply(m.id, { result: { content: [{ type: "text", text }] } }),
          (err: unknown) => reply(m.id, { result: { content: [{ type: "text", text: `acceptance-addons: ${err instanceof Error ? err.message : String(err)}` }], isError: true } }),
        );
      } else {
        reply(m.id, { error: { code: -32601, message: `unknown: ${String(m.method)}` } });
      }
    };
    await transport.start();
  },
};
