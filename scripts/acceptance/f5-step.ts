// F5 on the app (the owner's general capabilities, 2026-11-15: no door checks a plugin's id), a clause of the Browser row:
// `browser.*` and the terminal are served by capability. Three folder plugins, none of Clover's own:
// * `acc-surf`, holding `browser`, with a host MCP server whose `Surf` tool its manifest lists in `browserTools`: Alpha's
//   call drives her own tab (open, read with no card; a click asks for the site, as the Browser tool's does).
// * `acc-view`, holding `browser`, a live view: its layer lists Alpha's tab, shows it, hears the change and hides it.
// * `acc-term`, holding `terminal`: its layer opens a terminal and hears its shell's output; its own call writing to the
//   terminal (`plugin.layer.call`'s `terminal.input`) is refused.
// Kept apart from browser-step.ts so the fixtures and the verdict are unit-tested.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const F5_IDS = { surf: "acc-surf", view: "acc-view", term: "acc-term" } as const;
export const SURF_TOOL = "Surf";

/** The Surf tool's host half: an MCP server over `api.browser`, for the session whose tool call it serves. */
const SURF_HOST = [
  "// The acceptance run's F5 Browser tool (written by the run).",
  "let api;",
  "export async function start(a) { api = a; }",
  "export async function stop() {}",
  "async function surf(args) {",
  "  const who = await api.browser.toolCaller();",
  "  const owner = who.bot !== undefined ? { kind: \"bot\", bot: who.bot } : { kind: \"session\", session: who.sessionId };",
  "  const tabs = await api.browser.tabs();",
  "  let tab = tabs[0];",
  "  if (args.verb === \"open\") { tab = tab !== undefined ? await api.browser.navigate(tab.id, args.url) : await api.browser.open({ owner, url: args.url }); return `surf opened ${tab.id} for ${who.bot ?? who.sessionId}`; }",
  "  if (tab === undefined) return \"surf: no tab\";",
  "  const evaluate = async (expression) => { const r = await api.browser.cdp(tab.id, \"Runtime.evaluate\", { expression, returnByValue: true }); return r && r.result ? r.result.value : undefined; };",
  "  if (args.verb === \"read\") { for (let i = 0; i < 40; i++) { const t = await evaluate(\"document.readyState === 'complete' ? document.title + ' | ' + document.body.innerText : ''\"); if (t) return `surf read: ${t}`; await new Promise((r) => setTimeout(r, 250)); } return \"surf read: nothing\"; }",
  "  if (args.verb === \"click\") return `surf clicked: ${await evaluate(\"(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('Say hello')); if (b) b.click(); return document.getElementById('said') ? document.getElementById('said').textContent : 'no said'; })()\")}`;",
  "  return `surf: no verb ${args.verb}`;",
  "}",
  "export const mcp = { surf: async (transport) => {",
  "  const reply = (id, body) => void transport.send({ jsonrpc: \"2.0\", id, ...body }).catch(() => {});",
  "  transport.onmessage = (m) => {",
  "    if (m.id === undefined) return;",
  "    const p = m.params ?? {};",
  "    if (m.method === \"initialize\") reply(m.id, { result: { protocolVersion: typeof p.protocolVersion === \"string\" ? p.protocolVersion : \"2025-06-18\", capabilities: { tools: {} }, serverInfo: { name: \"acc-surf\", version: \"1\" } } });",
  "    else if (m.method === \"ping\") reply(m.id, { result: {} });",
  `    else if (m.method === "tools/list") reply(m.id, { result: { tools: [{ name: "${SURF_TOOL}", description: "The acceptance run's Surf: drives your own tab.", inputSchema: { type: "object", properties: { verb: { type: "string" }, url: { type: "string" } }, required: ["verb"] } }] } });`,
  `    else if (m.method === "tools/call" && p.name === "${SURF_TOOL}") surf(p.arguments ?? {}).then((t) => reply(m.id, { result: { content: [{ type: "text", text: String(t) }] } }), (e) => reply(m.id, { result: { content: [{ type: "text", text: \`surf refused: \${e && e.message ? e.message : String(e)}\` }], isError: true } }));`,
  "    else reply(m.id, { error: { code: -32601, message: `unknown: ${String(m.method)}` } });",
  "  };",
  "  await transport.start();",
  "} };",
  "",
].join("\n");

/** A component that does nothing on its own (the run drives its plugin's layer): a live view or a terminal needs one. */
const CLIENT = "export function Part() { return null; }\n";

function write(dir: string, manifest: Record<string, unknown>, files: Record<string, string>): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "clover.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

/** The three plugins' folders under `root`. */
export function writeF5(root: string): { surf: string; view: string; term: string } {
  const engines = { clover: "^1.0.0" };
  const surf = write(join(root, F5_IDS.surf), {
    manifest: 1, id: F5_IDS.surf, name: "Acceptance surf", version: "1.0.0", engines, capabilities: ["browser"],
    host: { entry: "host/index.js", runtime: "bun" },
    contributes: { mcpServers: { surf: { type: "host", tools: { [SURF_TOOL]: "preload" }, browserTools: [SURF_TOOL] } } },
  }, { "host/index.js": SURF_HOST, "package.json": "{\"type\":\"module\"}\n" });
  const part = (id: string, name: string, capability: string) => write(join(root, id), {
    manifest: 1, id, name, version: "1.0.0", engines, capabilities: [capability],
    client: { entry: "client/index.tsx" },
    contributes: { ui: [{ spot: "panel", key: id, title: name, component: "Part" }] },
  }, { "client/index.tsx": CLIENT });
  return { surf, view: part(F5_IDS.view, "Acceptance view", "browser"), term: part(F5_IDS.term, "Acceptance terminal", "terminal") };
}

/** What the clause saw. */
export interface F5Seen {
  surfCard: string;
  open: { text: string; cards: string[] };
  read: { text: string; cards: string[] };
  click: { text: string; cards: string[] };
  view: { listed: number; shown: string; heard: boolean; hidden: string };
  term: { output: boolean; inputRefused: string };
}

/** What is wrong; empty when the folder tool drove Alpha's tab (open and read with no card, a click with one), the
 *  folder live view listed, showed (hearing it) and hid her tab, and the folder terminal opened and spoke, with its own
 *  write refused. */
export function f5Wrong(s: F5Seen): string[] {
  const wrong: string[] = [];
  if (!s.surfCard.includes(`says ${SURF_TOOL} drives the calling bot's own tab of the Clover Browser`)) wrong.push("acc-surf's OK card doesn't name its Browser tool with the warning");
  if (!/surf opened tab_/.test(s.open.text)) wrong.push(`Surf didn't open Alpha's tab (${s.open.text.slice(0, 160)})`);
  if (s.open.cards.length > 0 || s.read.cards.length > 0) wrong.push(`looking raised a card (${[...s.open.cards, ...s.read.cards].join("; ")})`);
  if (!/Browser fixture home/.test(s.read.text)) wrong.push(`Surf didn't read the page (${s.read.text.slice(0, 160)})`);
  if (!s.click.cards.some((c) => c.startsWith("a tool card"))) wrong.push(`Surf's click raised no tool card (${s.click.cards.join("; ") || "none"})`);
  if (!/hello was clicked/.test(s.click.text)) wrong.push(`Surf's click, approved, didn't act (${s.click.text.slice(0, 160)})`);
  if (s.view.listed < 1 || s.view.shown !== "shown" || !s.view.heard || s.view.hidden !== "headless") wrong.push(`acc-view's live view: ${JSON.stringify(s.view)}`);
  if (!s.term.output) wrong.push("acc-term's terminal never spoke");
  if (!/only the user's own key presses and pastes/.test(s.term.inputRefused)) wrong.push(`acc-term's own write wasn't refused (${s.term.inputRefused.slice(0, 160)})`);
  return wrong;
}
