// The stage's own clause (F6, the owner's ruling of 2026-11-15: the stage is a plugin that takes renderer plugins, and nothing
// in the app or the core knows the bundled stage by id). A copy of the bundled character part, folder-installed under another id
// behind its OK card, takes the bundled stage's place in a bot's tab:
//   * its OK card says what it holds, in the catalog's plain lines, `avatar.report`'s (with its warning) and `bots.avatar`'s
//     among them, and it runs after the press on its card;
//   * with the bundled stage switched off, a bot with a community-format avatar (the picture-swap renderer, installed from
//     its folder) has its figure drawn under the copy, and the copy's report is what the core answers a cue by: the bot's own
//     command cues `happy`, the core answers ok and the renderer's frame swaps picture sets;
//   * the bot editor's Avatar section on Alpha's Edit page is the copy's (the bundled one is off), drawn in a document of the
//     copy's own plugin, whose card carries `bots.avatar`;
//   * the bundled stage comes back when switched on again (and the copy off): the same cue answers ok;
//   * the app logged no refusal of the copy's calls (by id or by want of a capability).
// Nothing here names the bundled plugin's id but to switch it off and on: the copy is the stage's own source, built into a
// client module and given another id and name.
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CLIENT_BARE_IMPORTS, capabilityOkText } from "../../packages/plugin-sdk/src/index";
import { EXAMPLES, SIDEBAR_ITEMS, clickTree, fail, layerDocs, sleep, toAlphasTab, treeDocs, until, type ExampleCtx } from "./example-steps";

export const STAGE_COPY_STEP = "a folder-installed copy of the stage, under another id and behind its OK card (reports figures, sets avatars), takes the bundled one's place: it draws a bot's figure with the installed renderer and its report answers the bot's cue; its own Avatar section is on the Edit page; the bundled stage comes back when switched on again; the app logs no refusal by id";

const PLUGINS = resolve(import.meta.dir, "..", "..", "plugins", "moss", "plugins");
export const COPY_ID = "mirror-stage";
const COPY_NAME = "Mirror stage";
/** The bundled plugin the copy stands in for (switched off while the copy runs, on again after). */
const BUNDLED = "moss/character";

/** The OK card's plain lines for what the copy holds: the catalog's own `ok` words for `avatar.report` and `bots.avatar`. */
export const COPY_OK_LINES: readonly string[] = ["avatar.report", "bots.avatar"].map((c) => capabilityOkText(c) ?? c);

/** The copy's manifest: the bundled stage's, with an id and a name of its own and its client built to one module. Its
 *  capabilities and what it declares are the bundled stage's own, so what it may do is what its OK card says. */
export function copyManifest(): Record<string, unknown> {
  const src = JSON.parse(readFileSync(join(PLUGINS, "character", "moss.json"), "utf8")) as Record<string, unknown> & { contributes: Record<string, unknown>; client: Record<string, unknown> };
  const { locales: _locales, ...contributes } = src.contributes;
  return { ...src, id: COPY_ID, name: COPY_NAME, client: { ...src.client, entry: "client/index.js" }, contributes };
}

/** Writes the copy's folder under `root` and returns its path: the bundled stage's own source, unchanged, built to one module as
 *  the registry builds a client entry (everything bundled in but the layers' bare imports), and its stylesheets. */
export async function buildCopy(root: string): Promise<string> {
  const dir = join(root, COPY_ID);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "client"), { recursive: true });
  const manifest = copyManifest() as { client: { css?: string[] } };
  writeFileSync(join(dir, "moss.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const css of manifest.client.css ?? []) copyFileSync(join(PLUGINS, "character", css), join(dir, css));
  const result = await Bun.build({
    entrypoints: [join(PLUGINS, "character", "client", "index.tsx")], outdir: join(dir, "client"), target: "browser", format: "esm", splitting: false, minify: false,
    naming: { entry: "index.[ext]" }, external: [...CLIENT_BARE_IMPORTS], define: { "process.env.NODE_ENV": JSON.stringify("production") }, throw: false,
    ...{ macros: false },
  });
  if (!result.success || !existsSync(join(dir, "client", "index.js"))) throw new Error(`the stage copy's client wasn't built: ${result.logs.map((l) => String(l)).join("; ").slice(0, 400)}`);
  return dir;
}

/** A bot plugin with a community-format avatar whose one command cues `happy` through the plugin API: the answer is the core's. */
function pictureBot(parent: string, botId: string, name: string): string {
  const folder = join(parent, botId);
  mkdirSync(join(folder, "model"), { recursive: true });
  mkdirSync(join(folder, "bot"), { recursive: true });
  mkdirSync(join(folder, "tab"), { recursive: true });
  mkdirSync(join(folder, "host"), { recursive: true });
  cpSync(join(EXAMPLES, "example-pngtuber", "sample-model"), join(folder, "model"), { recursive: true });
  writeFileSync(join(folder, "bot", "instructions.md"), "You are a test bot.\n");
  writeFileSync(join(folder, "tab", "layout.json"), JSON.stringify({ layout: 1, root: { stack: [{ spot: "conversation", grow: 1 }, { spot: "bot.stage", grow: 1 }], grow: 1 } }));
  writeFileSync(join(folder, "host", "index.ts"), [
    "let held: { avatar: { cue(cue: unknown): Promise<unknown> | unknown } } | undefined;",
    "export async function start(api: { avatar: { cue(cue: unknown): Promise<unknown> | unknown } }): Promise<void> { held = api; }",
    "export async function stop(): Promise<void> {}",
    "export async function cue(): Promise<{ text: string }> {",
    "  if (held === undefined) return { text: \"cue: no api\" };",
    "  return { text: `cue: ${JSON.stringify(await held.avatar.cue({ type: \"expression\", name: \"happy\" }))}` };",
    "}",
    "",
  ].join("\n"));
  writeFileSync(join(folder, "moss.json"), JSON.stringify({
    manifest: 1, id: botId, name, description: "The stage clause's bot with a community-format avatar.", version: "0.0.1", engines: { moss: "^1.0.0" },
    capabilities: ["avatar.control"], host: { entry: "host/index.ts", runtime: "bun" },
    contributes: { commands: [{ name: "cue", description: "Cues the figure's happy expression", handler: "cue" }], bot: { name, instructions: "bot/instructions.md", model: { default: "anthropic/claude-sonnet-5-5", effort: "medium" }, avatar: { file: "model/sunny.pngtuber.json", format: "pngtuber" }, layout: "tab/layout.json" } },
  }));
  return folder;
}

export async function stageCopyStep(ctx: ExampleCtx, _session: string): Promise<string> {
  const { rpc, cdp } = ctx;
  const said: string[] = [];
  const botId = "mirror-stage-bot";
  const botName = "Mirror Stage Bot";
  const parent = mkdtempSync(join(tmpdir(), "moss-stage-copy-"));
  const installed: string[] = [];
  let switchedOff = false;
  const refusals = () => ctx.appLog().split("\n").filter((l) => l.includes(`tree: ${COPY_ID}:`) && l.includes("refused"));
  const install = async (dir: string, id: string, lines: readonly string[] = []): Promise<void> => {
    const r = await rpc.request<{ id: string }>("plugin.install", { source: { from: "folder", path: dir } }, 60_000);
    if (r.id !== id) fail(`${id} installed as ${r.id}`);
    installed.push(id);
    const card = await until(`${id}'s OK card`, 30_000, async () => (await rpc.request<{ cards: { id: string; kind: string; pluginId?: string }[] }>("card.list", {})).cards.find((c) => c.kind === "plugin-ok" && c.pluginId === id));
    const text = JSON.stringify((await rpc.request<{ card: unknown }>("card.get", { id: card.id })).card);
    for (const line of lines) if (!text.includes(line)) fail(`${id}'s OK card doesn't say "${line}": ${text.slice(0, 300)}`);
    await ctx.pressCard(`${id}'s OK card`, (c) => c.id === card.id);
    await until(`${id} running`, 60_000, async () => ((await rpc.request<{ plugin: { state: string } }>("plugin.get", { id }).catch(() => undefined))?.plugin.state === "running" ? true : undefined),
      async () => JSON.stringify(await rpc.request("plugin.get", { id }).catch(() => null)).slice(0, 300));
  };
  const cue = async (): Promise<string> => {
    const r = await rpc.request<{ result?: { text?: string }; text?: string }>("command.run", { name: `${botId}.cue` }).catch((e: unknown) => ({ text: `cue: threw ${String(e)}` }));
    return (r as { result?: { text?: string }; text?: string }).result?.text ?? (r as { text?: string }).text ?? "";
  };
  const ok = async (what: string): Promise<string> => until(what, 60_000, async () => {
    const t = await cue();
    return t.startsWith("cue:") && t.includes('"ok":true') ? t : undefined;
  }, async () => `the cue answered ${await cue()}`);
  const PROBE = "(() => { const e = document.querySelector('[data-pngtuber]'); const img = e && e.querySelector('img'); return e ? { state: e.getAttribute('data-pngtuber'), loaded: !!img && img.complete && img.naturalWidth > 0 } : null; })()";
  const rendererDrawn = async (): Promise<string> => until("the renderer drawing the bot's picture", 60_000, async () => {
    for (const d of (await cdp.documents()).filter((x) => x.url.startsWith("moss-plugin://example-pngtuber/"))) {
      const r = await cdp.evaluate(d.session, PROBE).catch(() => undefined) as { state: string; loaded: boolean } | null | undefined;
      if (r?.loaded) return d.session;
    }
    await clickTree(cdp, `${botName} in the sidebar`, SIDEBAR_ITEMS, botName, 3_000).catch(() => undefined);
    return undefined;
  }, async () => (await cdp.documents()).map((d) => d.url.slice(0, 60)).join(" | "));
  try {
    await toAlphasTab(ctx);
    // 1. The renderer and the bot with its figure, under the bundled stage: the cue answers (a baseline), then the copy installs behind
    //    its OK card, which says what it holds.
    await install(join(EXAMPLES, "example-pngtuber"), "example-pngtuber");
    await install(pictureBot(parent, botId, botName), botId);
    await clickTree(cdp, `${botName} in the sidebar`, SIDEBAR_ITEMS, botName, 20_000);
    await rendererDrawn();
    await ok("the cue answered ok under the bundled stage");
    const folder = await buildCopy(ctx.root);
    await install(folder, COPY_ID, COPY_OK_LINES);
    said.push("the copy installed behind an OK card that carries avatar.report's and bots.avatar's lines, and runs after the press");

    // 2. The copy takes the place: the bundled stage off (as a user would in the Plugins page), the bot's tab drawn again.
    await rpc.request("plugin.setEnabled", { id: BUNDLED, enabled: false }, 30_000);
    switchedOff = true;
    await clickTree(cdp, "Alpha in the sidebar", SIDEBAR_ITEMS, "Alpha", 20_000).catch(() => undefined);
    await sleep(500);
    await clickTree(cdp, `${botName} in the sidebar`, SIDEBAR_ITEMS, botName, 20_000);
    const doc = await until("the stage copy's document in the bot's tab", 60_000, async () => (await layerDocs(cdp, COPY_ID))[0], async () => (await cdp.documents()).map((d) => d.url.slice(0, 70)).join(" || "));
    const frame = await rendererDrawn();
    const answered = await ok("the cue answered ok with the copy as the stage");
    const happy = await until("the renderer's frame showing the cued picture set", 20_000, async () => {
      const r = await cdp.evaluate(frame, PROBE).catch(() => undefined) as { state: string } | null | undefined;
      return r?.state === "happy" ? true : undefined;
    }, async () => `the renderer says ${JSON.stringify(await cdp.evaluate(frame, PROBE).catch(() => "?"))}`);
    void happy;
    said.push(`with the bundled stage off, the copy drew the bot's figure (${doc.url.slice(0, 40)}…) with the picture-swap renderer, and its report answered the bot's cue (${answered}): the renderer's frame swapped to the cued set`);

    // 3. The Edit page: Alpha's Edit button; the Avatar section is drawn in a document of the copy's own plugin.
    await toAlphasTab(ctx);
    const edit = await until("Alpha's Edit button", 30_000, async () => {
      for (const d of await treeDocs(cdp)) {
        const c = await cdp.centerOf(d.session, 'button[aria-label="Edit Alpha"]').catch(() => undefined);
        if (c !== undefined) return { session: d.session, c };
      }
      return undefined;
    });
    await cdp.click(edit.session, edit.c.x, edit.c.y);
    const section = await until("the copy's Avatar section on the Edit page", 30_000, async () => {
      for (const d of await layerDocs(cdp, COPY_ID)) {
        if ((await cdp.evaluate(d.session, "!!document.querySelector('.cl-avatar-section')").catch(() => false)) === true) return d.url;
      }
      return undefined;
    }, async () => (await cdp.documents()).map((d) => d.url.slice(0, 70)).join(" || "));
    said.push(`Alpha's Edit page showed the Avatar section drawn by the copy (${section.slice(0, 40)}…), which holds bots.avatar on its card`);
    await toAlphasTab(ctx);

    // 4. The bundled stage comes back when switched on again (the copy off): the same cue answers ok.
    await rpc.request("plugin.setEnabled", { id: COPY_ID, enabled: false }, 30_000);
    await rpc.request("plugin.setEnabled", { id: BUNDLED, enabled: true }, 30_000);
    switchedOff = false;
    await clickTree(cdp, `${botName} in the sidebar`, SIDEBAR_ITEMS, botName, 20_000);
    await until("the stage copy's document gone", 30_000, async () => ((await layerDocs(cdp, COPY_ID)).length === 0 ? true : undefined));
    await rendererDrawn();
    await ok("the cue answered ok with the bundled stage back");
    said.push("the copy off and the bundled stage on again: the same cue answered ok");

    // The app logged no refusal of the copy's calls: not by its id, not for want of a capability.
    const refused = refusals();
    if (refused.length > 0) fail(`the app refused the stage copy's calls: ${refused.slice(-3).join(" | ")}`);
    said.push("the app logged no refusal of the copy's calls");
    return said.join("; ");
  } finally {
    if (switchedOff) await rpc.request("plugin.setEnabled", { id: BUNDLED, enabled: true }, 30_000).catch(() => undefined);
    for (const id of installed.reverse()) {
      const rm = await rpc.request<{ card?: string }>("plugin.remove", { id }).catch(() => undefined);
      if (rm?.card !== undefined) await ctx.approveCard(rm.card).catch(() => undefined);
    }
    for (let i = 0; i < 30 && (await layerDocs(cdp, COPY_ID)).length > 0; i++) await sleep(300);
    rmSync(join(ctx.root, COPY_ID), { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
}
