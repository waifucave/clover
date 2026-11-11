// The bundled tools' smoke: every tool a bundled plugin offers a bot is called once, harmlessly, on the real path (the
// fake model's tool_use, the core's turn loop, the plugin host, the plugin's own host half and the API calls it makes).
// No answer may be the plugin host's "not served on this computer", a ContractError, a call the catalog marks not
// served yet, or a member the plugin API doesn't have: each of those is a bundled plugin calling into a core that doesn't
// serve it. A tool that needs something the run doesn't have may answer with an honest refusal, and each such refusal
// is named here (HONEST), so no other error passes.
//
// The tools come from the plugins' own sources (their names) and every bundled manifest's `mcpServers` (so a server
// added to a bundled plugin without a line here fails the step). The web tools reach only the run's fake search backend
// and its loopback outside world (fake-exa.ts); with no such seam they aren't called, and the step says so.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { STAGE_TOOLS } from "../../plugins/alpha/server/tools";
import { TOOL_NAME as BROWSER_TOOL } from "../../plugins/clover/plugins/browser/src/schema";
import { WEB_TOOLS } from "../../plugins/clover/plugins/web/src/tools";
import { callTurn, type ExampleCtx } from "./example-steps";
import { FAKE_PUBLIC_SITE } from "./fake-exa";

export const BUNDLED_TOOLS_STEP = "every tool a bundled plugin offers a bot answers one harmless call: none is \"not served on this computer\", a ContractError or a call the core doesn't serve; a refusal is an honest one this step names";

const PLUGINS = resolve(import.meta.dir, "..", "..", "plugins");

/** Each bundled plugin's MCP server, by `<plugin>/<server>`, with the names of the tools it lists. */
const SERVERS: Record<string, readonly string[]> = {
  "alpha/stage": STAGE_TOOLS.map((t) => t.name),
  "clover/browser/browser": [BROWSER_TOOL],
  "clover/web/web": WEB_TOOLS.map((t) => t.name),
};
const WEB: ReadonlySet<string> = new Set(WEB_TOOLS.map((t) => t.name));

/** One harmless call per tool: it reads, or changes only Alpha's display, and undoes what it pins. */
const INPUTS: Record<string, Record<string, unknown>> = {
  stage_status: {},
  set_scene: { scene: "meadow" },
  set_mood: { mood: "calm" },
  pin_note: { text: "acceptance smoke" },
  unpin_note: { handle: "all" },
  celebrate: {},
  set_expression: { name: "acceptance-smoke" },
  play_motion: { name: "acceptance-smoke" },
  toggle_outfit: { part: "acceptance-smoke" },
  [BROWSER_TOOL]: { verb: "tabs" },
  WebSearch: { query: "acceptance smoke" },
  WebFetch: { url: `https://${FAKE_PUBLIC_SITE}/article` },
};

/** The honest refusals a harmless call may get, by tool: the run's window shows Alpha headless, with no model of hers
 *  loaded, so a model's names aren't there (her stage's own words, plugins/alpha/server/stage.ts). */
const HONEST: Record<string, RegExp> = {
  set_expression: /Her tab hasn't loaded a model yet|The model has no expression/,
  play_motion: /Her tab hasn't loaded a model yet|The model has no motion/,
  toggle_outfit: /Her tab hasn't loaded a model yet|The model has no outfit part/,
};

/** What a bundled plugin calling into a core that doesn't serve the call looks like. */
const NOT_SERVED = /not served on this computer|ContractError|isn't available yet|doesn't exist in the plugin API|is a component's alone/;

class Failed extends Error {}
const fail = (m: string): never => { throw new Failed(m); };

/** Every bundled manifest's MCP servers, as `<plugin>/<server>`. */
function bundledServers(): string[] {
  const out: string[] = [];
  const visit = (folder: string, id: string) => {
    const file = join(folder, "clover.json");
    if (!existsSync(file)) return;
    const m = JSON.parse(readFileSync(file, "utf8")) as { contributes?: { mcpServers?: Record<string, unknown> } };
    for (const server of Object.keys(m.contributes?.mcpServers ?? {})) out.push(`${id}/${server}`);
    const children = join(folder, "plugins");
    if (existsSync(children)) for (const d of readdirSync(children)) visit(join(children, d), `${id}/${d}`);
  };
  for (const d of readdirSync(PLUGINS)) visit(join(PLUGINS, d), basename(d));
  return out.sort();
}

/** The smoke, on a bot session that has every bundled tool (Alpha's: her stage's, and the clover tree's for every bot).
 *  `web` says whether the run's fake search backend is there (or why not). */
export async function bundledToolsStep(ctx: ExampleCtx, session: string, web: true | string): Promise<string> {
  const servers = bundledServers();
  const unknown = servers.filter((s) => SERVERS[s] === undefined);
  if (unknown.length > 0) fail(`a bundled plugin's MCP server this step doesn't call: ${unknown.join(", ")} (add its tools to SERVERS and a harmless call each to INPUTS)`);
  const gone = Object.keys(SERVERS).filter((s) => !servers.includes(s));
  if (gone.length > 0) fail(`SERVERS names a server no bundled manifest has: ${gone.join(", ")}`);
  const tools = Object.values(SERVERS).flat();
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
  if (problems.length > 0) fail(`${problems.join(" | ")}${lines.length > 0 ? ` (the rest: ${lines.join("; ")})` : ""}`);
  return `${tools.length} bundled tools from ${servers.join(", ")}: ${lines.join("; ")}`;
}
