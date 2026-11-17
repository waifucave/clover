// F5 on the app (the owner's general capabilities, 2026-11-15: no door checks a plugin's id), a clause of the Browser row:
// `browser.*` and the terminal are served by capability. Three folder plugins, none of MOSS's own:
// * `acc-surf`, holding `browser`, with a host MCP server whose `Surf` tool its manifest lists in `browserTools`: Alpha's
//   call drives her own tab (open, read with no card; a click asks for the site, as the Browser tool's does).
// * `acc-view`, holding `browser`, a live view nested in the main window (Alpha's composer, `composer.action` keyed `model`): from its own frame, with no press,
//   it lists Alpha's tab, shows and hides it, and its navigate is refused; its button, pressed for real, navigates.
// * `acc-bg`, holding `browser`, a part kept in the background (`app.background`): its `browser.tabs` is refused.
//   (browser-press, the coordinator's narrowing of F5: the app main process's gesture rule, browser-calls.ts.)
// * `acc-term`, holding `terminal`: its layer opens a terminal and hears its shell's output; its own call writing to the
//   terminal (`plugin.layer.call`'s `terminal.input`) is refused.
// Kept apart from browser-step.ts so the fixtures and the verdict are unit-tested.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const F5_IDS = { surf: "acc-surf", view: "acc-view", term: "acc-term", bg: "acc-bg" } as const;
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

/** A component that does nothing on its own (the run drives its plugin's layer): the terminal needs one. */
const CLIENT = "export function Part() { return null; }\n";

const REFUSED = "(e) => \"refused \" + (e && e.message ? e.message : String(e))";
/** The live view's part: `window.__accView` makes its calls from its own frame (the run evaluates them: no press), and its
 *  button, pressed, navigates `__accView.target`, saying what came of it in `data-said`. */
const VIEW_CLIENT = [
  "import { jsx } from \"react/jsx-runtime\";",
  "import { useEffect, useState } from \"react\";",
  "import { usePluginApi } from \"@waifucave/moss-plugin-sdk/ui\";",
  "export function Go() {",
  "  const api = usePluginApi();",
  "  const [said, setSaid] = useState(\"\");",
  "  useEffect(() => {",
  "    if (!api || !api.browser) return;",
  "    const b = api.browser;",
  `    const no = ${REFUSED};`,
  "    window.__accView = {",
  "      target: null,",
  "      list: (owner) => b.tabs({ owner }).then((t) => \"ok \" + JSON.stringify(t.map((x) => ({ id: x.id, place: x.place, url: x.url }))), no),",
  "      show: (id) => b.show(id, \"browser\", { width: 800, height: 600 }).then((t) => \"ok \" + t.place, no),",
  "      hide: (id) => b.hide(id).then((t) => \"ok \" + t.place, no),",
  "      navigate: (id, url) => b.navigate(id, url).then((t) => \"ok \" + t.url, no),",
  "    };",
  "  }, [api]);",
  "  const onClick = () => {",
  "    const t = window.__accView && window.__accView.target;",
  "    if (!api || !t) { setSaid(\"no target\"); return; }",
  `    api.browser.navigate(t.id, t.url).then((x) => setSaid("ok " + x.url), (e) => setSaid((${REFUSED})(e)));`,
  "  };",
  "  return jsx(\"button\", { type: \"button\", \"data-acc-view\": \"go\", \"data-said\": said, onClick, children: \"Acceptance view go\" });",
  "}",
  "",
].join("\n");

/** The background part: on mount it asks for the tab list and writes what came of it in `data-acc-bg`. */
const BG_CLIENT = [
  "import { jsx } from \"react/jsx-runtime\";",
  "import { useEffect, useState } from \"react\";",
  "import { usePluginApi } from \"@waifucave/moss-plugin-sdk/ui\";",
  "export function Bg() {",
  "  const api = usePluginApi();",
  "  const [said, setSaid] = useState(\"waiting\");",
  "  useEffect(() => {",
  "    if (!api) return;",
  "    if (!api.browser) { setSaid(\"refused no browser in the api\"); return; }",
  `    api.browser.tabs({}).then((t) => setSaid("ok " + t.length), (e) => setSaid((${REFUSED})(e)));`,
  "  }, [api]);",
  "  return jsx(\"div\", { \"data-acc-bg\": said, children: \"background\" });",
  "}",
  "",
].join("\n");

function write(dir: string, manifest: Record<string, unknown>, files: Record<string, string>): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "moss.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

/** The three plugins' folders under `root`. */
export function writeF5(root: string): { surf: string; view: string; term: string; bg: string } {
  const engines = { moss: "^1.0.0" };
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
  const view = write(join(root, F5_IDS.view), {
    manifest: 1, id: F5_IDS.view, name: "Acceptance view", version: "1.0.0", engines, capabilities: ["browser"],
    client: { entry: "client/index.js" },
    // A part nested in the main window, as a third party's panel is: its frame inside the shell's, which the press is credited
    // to by its own document's report (lane E's `moss:press-seen`).
    contributes: { ui: [{ spot: "composer.action", key: "model", id: "go", component: "Go", title: "Acceptance view" }] },
  }, { "client/index.js": VIEW_CLIENT });
  const bg = write(join(root, F5_IDS.bg), {
    manifest: 1, id: F5_IDS.bg, name: "Acceptance background browser", version: "1.0.0", engines, capabilities: ["browser"],
    client: { entry: "client/index.js" },
    contributes: { ui: [{ spot: "app.background", id: "bg", component: "Bg" }] },
  }, { "client/index.js": BG_CLIENT });
  return { surf, view, term: part(F5_IDS.term, "Acceptance terminal", "terminal"), bg };
}

/** What the clause saw. */
export interface F5Seen {
  surfCard: string;
  open: { text: string; cards: string[] };
  read: { text: string; cards: string[] };
  click: { text: string; cards: string[] };
  /** What the live view's own frame got: each with no press, and the navigate its button made when pressed. */
  view: { list: string; show: string; hide: string; navNoPress: string; navPressed: string; otherUrl: string };
  /** What the background part's `browser.tabs` got. */
  bg: string;
  term: { output: boolean; inputRefused: string };
}

/** What is wrong; empty when the folder tool drove Alpha's tab (open and read with no card, a click with one), the
 *  folder live view listed, showed and hid her tab with no press, was refused a navigate with no press and navigated on a
 *  real one, the background part was refused, and the folder terminal opened and spoke, with its own write refused. */
export function f5Wrong(s: F5Seen): string[] {
  const wrong: string[] = [];
  if (!s.surfCard.includes(`says ${SURF_TOOL} drives the calling bot's own tab of the MOSS Browser`)) wrong.push("acc-surf's OK card doesn't name its Browser tool with the warning");
  if (!/surf opened tab_/.test(s.open.text)) wrong.push(`Surf didn't open Alpha's tab (${s.open.text.slice(0, 160)})`);
  if (s.open.cards.length > 0 || s.read.cards.length > 0) wrong.push(`looking raised a card (${[...s.open.cards, ...s.read.cards].join("; ")})`);
  if (!/Browser fixture home/.test(s.read.text)) wrong.push(`Surf didn't read the page (${s.read.text.slice(0, 160)})`);
  if (!s.click.cards.some((c) => c.startsWith("a tool card"))) wrong.push(`Surf's click raised no tool card (${s.click.cards.join("; ") || "none"})`);
  if (!/hello was clicked/.test(s.click.text)) wrong.push(`Surf's click, approved, didn't act (${s.click.text.slice(0, 160)})`);
  if (!/^ok \[\{"id":"tab_/.test(s.view.list)) wrong.push(`acc-view's list with no press: ${s.view.list.slice(0, 200)}`);
  if (s.view.show !== "ok shown" || s.view.hide !== "ok headless") wrong.push(`acc-view's show and hide with no press: ${s.view.show}, ${s.view.hide}`);
  if (!/^refused .*right after your own key press or click/.test(s.view.navNoPress)) wrong.push(`acc-view's navigate with no press wasn't refused for want of a press (${s.view.navNoPress.slice(0, 200)})`);
  // The tab it answers with may still show the old address while the new page loads: a navigate that went is "ok".
  if (!s.view.navPressed.startsWith("ok ")) wrong.push(`acc-view's navigate on a real press didn't go (${s.view.navPressed.slice(0, 200)})`);
  if (!/^refused .*background/.test(s.bg)) wrong.push(`acc-bg's background part wasn't refused the browser (${s.bg.slice(0, 200)})`);
  if (!s.term.output) wrong.push("acc-term's terminal never spoke");
  if (!/only the user's own key presses and pastes/.test(s.term.inputRefused)) wrong.push(`acc-term's own write wasn't refused (${s.term.inputRefused.slice(0, 160)})`);
  return wrong;
}
