// The bundled tools' smoke: every tool a bundled plugin offers a bot is called once, harmlessly, on the real path (the
// fake model's tool_use, the core's turn loop, the plugin host, the plugin's own host half and the API calls it makes).
// No answer may be the plugin host's "not served on this computer", a ContractError, a call the catalog marks not
// served yet, or a member the plugin API doesn't have: each of those is a bundled plugin calling into a core that doesn't
// serve it. A tool that needs something the run doesn't have may answer with an honest refusal, and each such refusal
// is named here (HONEST), so no other error passes.
//
// The tools come from the plugins' own sources (their names) and every bundled manifest's `mcpServers` (so a server
// added to a bundled plugin without a line here fails the step). A plugin carrying lane B's mark (`availability`
// `not-yet`, read from its manifest) offers no server: none of its tools may reach the bot, and it isn't called. The web tools reach only the run's fake search backend
// and its loopback outside world (fake-exa.ts); with no such seam they aren't called, and the step says so.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { STAGE_TOOLS } from "../../plugins/alpha/server/tools";
import { FIGURE_TOOLS } from "../../plugins/moss/plugins/character/server/tools";
import { TOOL_NAME as BROWSER_TOOL } from "../../plugins/moss/plugins/browser/src/schema";
import { WEB_TOOLS } from "../../plugins/moss/plugins/web/src/tools";
import { TOOLS as BUILDER_TOOLS, TOOL_NEW } from "../../plugins/moss/plugins/plugin-builder/src/tools";
import { callTurn, type ExampleCtx } from "./example-steps";
import { FAKE_PUBLIC_SITE } from "./fake-exa";

export const BUNDLED_TOOLS_STEP = "every tool a bundled plugin offers a bot answers one harmless call: none is \"not served on this computer\", a ContractError or a call the core doesn't serve; a refusal is an honest one this step names";

const PLUGINS = resolve(import.meta.dir, "..", "..", "plugins");

/** Each bundled plugin's MCP server, by `<plugin>/<server>`, with the names of the tools it lists. */
const SERVERS: Record<string, readonly string[]> = {
  "alpha/stage": STAGE_TOOLS.map((t) => t.name),
  "moss/browser/browser": [BROWSER_TOOL],
  "moss/character/figure": FIGURE_TOOLS.map((t) => t.name),
  "moss/plugin-builder/builder": BUILDER_TOOLS.map((t) => t.name),
  "moss/web/web": WEB_TOOLS.map((t) => t.name),
};
const WEB: ReadonlySet<string> = new Set(WEB_TOOLS.map((t) => t.name));
/** Servers only a bot is offered: not called in a code session. */
const BOTS_ONLY: ReadonlySet<string> = new Set(["alpha/stage"]);

/** One harmless call per tool: it reads, or changes only a display (Alpha's room, the avatar), and undoes what it pins. */
const INPUTS: Record<string, Record<string, unknown>> = {
  stage_status: {},
  set_scene: { scene: "meadow" },
  set_mood: { mood: "calm" },
  pin_note: { text: "acceptance smoke" },
  unpin_note: { handle: "all" },
  celebrate: {},
  set_expression: { name: "acceptance-smoke" },
  play_motion: { name: "acceptance-smoke" },
  toggle_outfit: { part: "acceptance-smoke", on: true },
  figure_status: {},
  [BROWSER_TOOL]: { verb: "tabs" },
  WebSearch: { query: "acceptance smoke" },
  WebFetch: { url: `https://${FAKE_PUBLIC_SITE}/article` },
  // It returns a template's files and writes nothing (plugins/moss/plugins/plugin-builder/src/tools.ts).
  [TOOL_NEW]: { template: "theme", id: "acceptance-smoke", name: "Acceptance smoke" },
};

/** The honest refusals a harmless call may get, by tool: the avatar plugin's tools (plugins/moss/plugins/character/server)
 *  say so when no avatar is shown for the session, or when the model shown has no such name. */
const HONEST: Record<string, RegExp> = {
  set_expression: /no avatar is shown|this model has no expression|nothing is drawing the figure/,
  play_motion: /no avatar is shown|this model has no motion|nothing is drawing the figure|doesn't do motions/,
  toggle_outfit: /no avatar is shown|this model has no outfit part|nothing is drawing the figure|doesn't do outfits/,
  figure_status: /no avatar is shown/,
};

/** What a bundled plugin calling into a core that doesn't serve the call looks like. */
const NOT_SERVED = /not served on this computer|ContractError|isn't available yet|doesn't exist in the plugin API|is a component's alone/;

class Failed extends Error {}
const fail = (m: string): never => { throw new Failed(m); };

/** For a failure message: each `mcp__<server>__` prefix the requests declared (`body.tools`, with how many deferred) and offered
 *  callable (`tools`, the declared list with the conversation's additions and removals applied), per request, newest last. */
function serverShapes(ctx: ExampleCtx): string {
  const out: string[] = [];
  for (const [i, r] of ctx.requests().entries()) {
    const declared = ((r.body as { tools?: { name: string; defer_loading?: boolean }[] } | undefined)?.tools ?? []).filter((t) => t.name.startsWith("mcp__moss_"));
    const servers = [...new Set(declared.map((t) => t.name.split("__")[1]!))];
    const part = servers.map((k) => `${k.slice(5, 9)}: declared ${declared.filter((t) => t.name.startsWith(`mcp__${k}__`)).length} (${declared.filter((t) => t.name.startsWith(`mcp__${k}__`) && t.defer_loading === true).length} deferred), callable ${r.tools.filter((t) => t.startsWith(`mcp__${k}__`)).length}`);
    if (part.length > 0) out.push(`#${i} ${part.join(" / ")}`);
  }
  return out.slice(-6).join(" | ");
}

/** Every bundled manifest's MCP servers, as `<plugin>/<server>`, each with whether its plugin carries lane B's mark
 *  (`availability.status: "not-yet"`: listed on the Plugins page, never started, no server offered). */
function bundledServers(): { key: string; marked: boolean }[] {
  const out: { key: string; marked: boolean }[] = [];
  const visit = (folder: string, id: string) => {
    const file = join(folder, "moss.json");
    if (!existsSync(file)) return;
    const m = JSON.parse(readFileSync(file, "utf8")) as { availability?: { status?: string }; contributes?: { mcpServers?: Record<string, unknown> } };
    for (const server of Object.keys(m.contributes?.mcpServers ?? {})) out.push({ key: `${id}/${server}`, marked: m.availability?.status === "not-yet" });
    const children = join(folder, "plugins");
    if (existsSync(children)) for (const d of readdirSync(children)) visit(join(children, d), `${id}/${d}`);
  };
  for (const d of readdirSync(PLUGINS)) visit(join(PLUGINS, d), basename(d));
  return out.sort((a, b) => (a.key < b.key ? -1 : 1));
}

/** The smoke, on a bot session that has every bundled tool (Alpha's: her stage's, and the moss tree's for every bot).
 *  `web` says whether the run's fake search backend is there (or why not). */
export async function bundledToolsStep(ctx: ExampleCtx, session: string, web: true | string): Promise<string> {
  const all = bundledServers();
  // A marked plugin offers no server: its tools must not reach the bot. Every other bundled server is called.
  const marked = all.filter((s) => s.marked).map((s) => s.key);
  const servers = all.filter((s) => !s.marked).map((s) => s.key);
  const unknown = servers.filter((s) => SERVERS[s] === undefined);
  if (unknown.length > 0) fail(`a bundled plugin's MCP server this step doesn't call: ${unknown.join(", ")} (add its tools to SERVERS and a harmless call each to INPUTS)`);
  const gone = Object.keys(SERVERS).filter((s) => !servers.includes(s) && !marked.includes(s));
  if (gone.length > 0) fail(`SERVERS names a server no bundled manifest has: ${gone.join(", ")}`);
  // Alpha's stage server is her own (scope bots, lane MC2's until her figure is a pack): MOSS Code's run calls every other
  // bundled tool in its code session, and her stage's are proved where she has a tab.
  const botsOnly = servers.filter((s) => BOTS_ONLY.has(s));
  const tools = servers.filter((s) => !BOTS_ONLY.has(s)).flatMap((s) => SERVERS[s] ?? []);
  const unoffered = marked.flatMap((s) => SERVERS[s] ?? []);
  const noInput = tools.filter((t) => INPUTS[t] === undefined);
  if (noInput.length > 0) fail(`no harmless call for ${noInput.join(", ")} (add one to INPUTS)`);

  const lines: string[] = [];
  const problems: string[] = [];
  for (const tool of tools) {
    if (WEB.has(tool) && web !== true) {
      lines.push(`${tool} not called (${web})`);
      continue;
    }
    const r = await callTurn(ctx, session, tool, INPUTS[tool]!).catch((err: unknown) => {
      problems.push(`${tool}: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    });
    if (r === undefined) continue;
    const text = r.result.text.replace(/\s+/g, " ").trim();
    const cards = r.cards.length > 0 ? `, ${r.cards.length} card(s): ${r.cards.join("; ").slice(0, 160)}` : ", no card";
    if (NOT_SERVED.test(text)) problems.push(`${r.called} answered as a call the core doesn't serve: ${text.slice(0, 300)}`);
    else if (r.result.isError && !(HONEST[tool]?.test(text) ?? false)) problems.push(`${r.called} failed: ${text.slice(0, 300)}`);
    else lines.push(`${r.called} ${r.result.isError ? "refused honestly" : "answered"} (${text.slice(0, 80)}${text.length > 80 ? "…" : ""})${cards}`);
  }
  // What the session was offered, from the turns this step ran: no marked plugin's tool among them.
  const offered = new Set(ctx.requests().flatMap((r) => r.tools));
  const leaked = [...offered].filter((name) => unoffered.some((t) => name === t || name.endsWith(`__${t}`)));
  if (leaked.length > 0) problems.push(`a plugin listed as not available offered ${leaked.join(", ")}`);
  if (problems.length > 0) problems.push(`the bridge servers in the requests this step sent: ${serverShapes(ctx)}`);
  if (problems.length > 0) fail(`${problems.join(" | ")}${lines.length > 0 ? ` (the rest: ${lines.join("; ")})` : ""}`);
  return `${tools.length} bundled tools from ${servers.filter((x) => !BOTS_ONLY.has(x)).join(", ")}${botsOnly.length > 0 ? ` (not called here, a bot's own: ${botsOnly.join(", ")})` : ""}: ${lines.join("; ")}${marked.length > 0 ? `; not offered (listed as not available): ${marked.join(", ")}` : ""}`;
}
