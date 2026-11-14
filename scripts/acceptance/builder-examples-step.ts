// The plugin builder's examples (checklist 5.4), each installed on the real app and its UI drawn. The builder's skill
// (plugins/clover/plugins/plugin-builder/skills/plugin-examples) holds 15 examples; each validates and loads in the unit
// tests, and this row installs every one from a folder (its files written under the run's temp folder, `plugin.install`
// over RPC, its `plugin-ok` OK card approved: ex-tool's pressed in the window), reaches running or enabled, and then, in
// the window, sees each part drawn by its own layer:
//   ex-settings, ex-point, ex-board, ex-buddy's child: their Settings sections (the Settings dialog, by title);
//   ex-status: its line in the status bar; ex-app, ex-timeline, ex-fit: their pages, from their sidebar entries;
//   ex-board-widget: its widget inside ex-board's section; ex-fit-tile: its tile inside ex-fit's page;
//   ex-buddy: its header and side panel on its bot's tab (the bot in `bot.list`); ex-bot: in `bot.list`;
//   ex-theme: listed as a theme (`plugin.ui`); ex-model: its model listed (`models.list`);
//   ex-tool, ex-timeline: the tool answers one call from Alpha; ex-trigger: installed and running.
// All fifteen are installed first and then looked at: a plugin with UI installed after the window was served loads the
// window's document again, so the checks wait until that has settled. Each is removed afterwards (the fillers first).
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readExamples, type Example } from "../../plugins/clover/plugins/plugin-builder/test/examples";
import { callTurn, fail, frames, leave, treeDocs, until, type ExampleCtx } from "./example-steps";
import { clickShown, drawn, drawnInSettings, openSidebarEntry, reloadsSettled } from "./window-open";

export const BUILDER_EXAMPLES_STEP = "the plugin builder's 15 examples, each installed from a folder over RPC behind its OK card (ex-tool's pressed in the window) and running: Settings sections (ex-settings, ex-point, ex-board with ex-board-widget's widget in it, ex-buddy's child), the status line (ex-status), the pages from their sidebar entries (ex-app, ex-timeline, ex-fit with ex-fit-tile's tile in it) and ex-buddy's header and side panel on its bot's tab are drawn in the window; ex-theme is listed as a theme, ex-bot and ex-buddy as bots, ex-model's model as a model; ex-tool and ex-timeline's tools answer a call from Alpha; each removed afterwards";

interface Card { id: string; kind: string; pluginId?: string }

/** The order they install in: a plugin that declares a point before the ones that fill it. */
export const INSTALL_ORDER = [
  "ex-tool", "ex-settings", "ex-theme", "ex-bot", "ex-model", "ex-trigger", "ex-point", "ex-status", "ex-app", "ex-board",
  "ex-board-widget", "ex-buddy", "ex-timeline", "ex-fit", "ex-fit-tile",
] as const;

/** An example's files written as a plugin folder under `dir`; the folder. */
export function writeExample(dir: string, ex: Example): string {
  const folder = join(dir, ex.folder);
  rmSync(folder, { recursive: true, force: true });
  for (const [path, body] of Object.entries(ex.files)) {
    const file = join(folder, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, body);
  }
  return folder;
}

const stateOf = async (ctx: ExampleCtx, id: string) => (await ctx.rpc.request<{ plugin: { state: string } }>("plugin.get", { id }).catch(() => undefined))?.plugin.state;
const cardsNow = async (ctx: ExampleCtx) => (await ctx.rpc.request<{ cards: Card[] }>("card.list")).cards;

export async function builderExamplesStep(ctx: ExampleCtx, session: string): Promise<string> {
  try {
    return await run(ctx, session);
  } finally {
    // Whatever happened: no card left waiting, and every example out, the fillers first.
    for (const id of [...INSTALL_ORDER].reverse()) {
      for (const c of await cardsNow(ctx).catch(() => [] as Card[])) if (c.pluginId === id || c.pluginId?.startsWith(`${id}/`)) await ctx.denyCard(c.id).catch(() => undefined);
      await leave(ctx, id);
    }
  }
}

async function run(ctx: ExampleCtx, session: string): Promise<string> {
  const { rpc, cdp, root } = ctx;
  const done: string[] = [];
  const examples = new Map(readExamples().map((e) => [e.folder, e]));
  const missing = INSTALL_ORDER.filter((id) => !examples.has(id));
  const extra = [...examples.keys()].filter((id) => !(INSTALL_ORDER as readonly string[]).includes(id));
  if (missing.length > 0 || extra.length > 0) fail(`the builder's examples changed: missing ${missing.join(", ") || "none"}, new ${extra.join(", ") || "none"} (the row lists all of them)`);
  const dir = join(root, "builder-examples");
  rmSync(dir, { recursive: true, force: true });

  // The app up and told of cards before the first one comes (its island's layer connected).
  await until("the app's island connected to the core", 30_000, () => (ctx.appLog().includes("layers: clover/island's layer connected to the core") ? true : undefined));
  await new Promise((r) => setTimeout(r, 2_000));

  // 1. Every example installed from its folder and OK'd.
  const approved: string[] = [];
  for (const id of INSTALL_ORDER) {
    const folder = writeExample(dir, examples.get(id)!);
    if (existsSync(join(folder, "node_modules"))) fail(`${id} ships a node_modules`);
    const installed = await rpc.request<{ id: string; card?: string }>("plugin.install", { source: { from: "folder", path: folder } }, 90_000).catch((err: unknown) => fail(`${id}: plugin.install failed: ${err instanceof Error ? err.message : String(err)}`));
    if (installed.id !== id) fail(`${id} installed as ${installed.id}`);
    const card = await until(`${id}'s OK card`, 60_000, async () => (await cardsNow(ctx)).find((c) => c.kind === "plugin-ok" && c.pluginId === id));
    const text = JSON.stringify((await rpc.request<{ card: unknown }>("card.get", { id: card.id })).card);
    const name = (JSON.parse(examples.get(id)!.files["clover.json"]!) as { name: string }).name;
    if (!text.includes(name)) fail(`${id}'s OK card doesn't name it (${name}): ${text.slice(0, 300)}`);
    if (id === "ex-tool") await ctx.pressCard(`${id}'s OK card`, (c) => c.id === card.id);
    else await ctx.approveCard(card.id);
    await until(`${id} running after its OK`, 60_000, async () => {
      const s = await stateOf(ctx, id);
      return s === "running" || s === "enabled" ? s : undefined;
    }, async () => `it is ${(await stateOf(ctx, id)) ?? "gone"}${(await rpc.request<{ plugin: { reason?: string } }>("plugin.get", { id }).catch(() => undefined))?.plugin.reason ? ` (${(await rpc.request<{ plugin: { reason?: string } }>("plugin.get", { id })).plugin.reason})` : ""}`);
    // A child plugin of its own (ex-buddy's settings) has no card of its own beside the parent's, or one more to approve.
    for (const c of await cardsNow(ctx)) if (c.kind === "plugin-ok" && c.pluginId?.startsWith(`${id}/`)) await ctx.approveCard(c.id);
    approved.push(id);
  }
  done.push(`1 all ${approved.length} installed from folders and OK'd (ex-tool's card pressed in the window), each running or enabled`);

  // The window's document loads again for each new layer: the checks start when it has stopped.
  const reloads = await reloadsSettled(ctx);
  done.push(`(the window's document loaded again ${reloads} time(s) for the new layers, then stayed)`);

  // 2. Each part, looked at; every failure named, so one run reads them all.
  const failed: string[] = [];
  const check = async (label: string, fn: () => Promise<string>) => {
    try {
      done.push(`${label}: ${await fn()}`);
    } catch (err) {
      failed.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  await check("ex-settings", async () => {
    const d = await drawnInSettings(ctx, "Ex settings", "ex-settings", "Hello from Ex settings.", "its Settings section");
    return `its Settings section drawn ("${d.text.trim().slice(0, 60)}")`;
  });
  await check("ex-point", async () => {
    await drawnInSettings(ctx, "Ex point", "ex-point", "", "its Settings section", "!!document.querySelector('ul')");
    return "its Settings section drawn (a list no plugin fills yet)";
  });
  await check("ex-board and ex-board-widget", async () => {
    const w = await drawnInSettings(ctx, "Ex board", "ex-board-widget", "Hello from a small widget", "ex-board-widget's widget inside ex-board's section");
    return `ex-board's Settings section drawn with ex-board-widget's widget inside it, handed its props ("${w.text.trim().slice(0, 40)}")`;
  });
  await check("ex-buddy's child", async () => {
    const d = await drawnInSettings(ctx, "Ex buddy", "ex-buddy", "Ex buddy has nothing to set yet.", "its child's Settings section");
    return `its child plugin's Settings section drawn (${d.url.slice(0, 60)})`;
  });
  await check("ex-status", async () => {
    const d = await drawn(ctx, "ex-status", "Ex status is on", "its status line");
    return `its line drawn in the status bar ("${d.text.trim().slice(0, 40)}")`;
  });

  // The tools, called by Alpha (cards pressed in the window); the timeline gets a clip her tool added.
  let clip = "";
  await check("ex-tool", async () => {
    const t = await callTurn(ctx, session, "hello", { name: "Acceptance" });
    if (!t.called.includes("ex-tool")) fail(`the call went to ${t.called}`);
    if (t.result.isError || !t.result.text.includes("Hello, Acceptance!")) fail(`its tool answered "${t.result.text.slice(0, 160)}"`);
    return `Alpha's call of ${t.called} answered "${t.result.text.slice(0, 40)}"`;
  });
  await check("ex-timeline's tool", async () => {
    clip = `Acceptance clip ${Date.now() % 100000}`;
    const t = await callTurn(ctx, session, "TimelineAdd", { title: clip, start: 1, length: 3 });
    if (!t.called.includes("ex-timeline")) fail(`the call went to ${t.called}`);
    if (t.result.isError || !t.result.text.includes(clip)) fail(`its tool answered "${t.result.text.slice(0, 200)}"`);
    return `Alpha's call of ${t.called} answered "${t.result.text.slice(0, 60)}…"`;
  });

  await check("ex-app", async () => {
    await openSidebarEntry(ctx, "Ex app");
    const d = await drawn(ctx, "ex-app", "Open a video", "its page");
    return `its page drawn from its sidebar entry ("${d.text.replace(/\s+/g, " ").trim().slice(0, 50)}")`;
  });
  await check("ex-timeline's page", async () => {
    await openSidebarEntry(ctx, "Ex timeline");
    const d = await drawn(ctx, "ex-timeline", "Add a clip", "its page");
    const withClip = await drawn(ctx, "ex-timeline", clip, "its page with the clip Alpha's tool added").catch(() => undefined);
    return `its page drawn from its sidebar entry ("${d.text.replace(/\s+/g, " ").trim().slice(0, 40)}")${withClip !== undefined ? `, showing the clip Alpha's tool added` : `; the clip "${clip}" Alpha's tool added isn't drawn in its first 400 characters`}`;
  });
  await check("ex-fit and ex-fit-tile", async () => {
    await openSidebarEntry(ctx, "Ex fit");
    const page = await drawn(ctx, "ex-fit", "Ex fit", "its page");
    const tile = await drawn(ctx, "ex-fit-tile", "Sunny, 21", "ex-fit-tile's tile inside the page");
    // Its page fills its column (row 1.76): the frame the shell hosts it in is as tall as the column it stands in, the page inside
    // reads the same height as its own window, and the page's own content is a good deal shorter than that (so a frame that took
    // the content's height would be small).
    const fill = await until("ex-fit's frame measured against its column", 20_000, async () => {
      for (const d of await treeDocs(cdp)) {
        const v = await cdp.evaluate(d.session, `(() => {
          const f = [...document.querySelectorAll('iframe[data-clover-fill]')].find((e) => /^ex-fit(?!-)/.test(e.getAttribute('data-clover-entry') || ''));
          if (!f) return null;
          let col = f.parentElement;
          while (col && getComputedStyle(col).display === 'contents') col = col.parentElement;
          const main = f.closest('.cl-window__main');
          const r = f.getBoundingClientRect();
          return JSON.stringify({ frame: Math.round(r.height), col: col ? Math.round(col.clientHeight - parseFloat(getComputedStyle(col).paddingTop || '0') - parseFloat(getComputedStyle(col).paddingBottom || '0')) : 0, colBox: col ? col.clientHeight + ' ' + getComputedStyle(col).padding + ' ' + col.className : '', main: main ? Math.round(main.getBoundingClientRect().height) : 0, entry: f.getAttribute('data-clover-entry') });
        })()`).catch(() => null);
        if (typeof v === "string") return JSON.parse(v) as { frame: number; col: number; colBox: string; main: number; entry: string };
      }
      return undefined;
    }, async () => frames(cdp));
    const inside = Number(await cdp.evaluate(page.session, "document.documentElement.clientHeight").catch(() => NaN));
    const content = Number(await cdp.evaluate(page.session, "(() => { const kids = [...document.body.children]; return kids.length ? Math.max(...kids.map((e) => e.getBoundingClientRect().bottom)) : 0; })()").catch(() => NaN));
    if (Math.abs(fill.frame - fill.col) > 2) fail(`ex-fit's frame is ${fill.frame}px tall, its column's content ${fill.col}px (${fill.entry}; column ${fill.colBox})`);
    if (fill.main > 0 && fill.frame < fill.main * 0.6) fail(`ex-fit's frame (${fill.frame}px) doesn't fill the main column (${fill.main}px)`);
    if (!Number.isFinite(inside) || Math.abs(inside - fill.frame) > 2) fail(`ex-fit's page reads a ${inside}px window inside a ${fill.frame}px frame`);
    return `its page drawn from its sidebar entry ("${page.text.replace(/\s+/g, " ").trim().slice(0, 50)}") with ex-fit-tile's tile in it ("${tile.text.replace(/\s+/g, " ").trim().slice(0, 40)}"); its frame is ${fill.frame}px tall in a ${fill.col}px column (the page inside reads ${inside}px; its content ends at ${Math.round(content)}px)`;
  });

  // The bots: listed, and ex-buddy's header and side panel on its tab.
  await check("ex-bot", async () => {
    const bots = (await rpc.request<{ bots: { id: string; name?: unknown }[] }>("bot.list", {})).bots;
    const mine = bots.find((b) => b.id === "ex-bot" || b.id === "ex-bot/bot");
    if (mine === undefined) fail(`bot.list lists ${bots.map((b) => b.id).join(", ")}`);
    return `listed in bot.list as ${mine!.id}`;
  });
  await check("ex-buddy", async () => {
    const bots = (await rpc.request<{ bots: { id: string }[] }>("bot.list", {})).bots;
    const mine = bots.find((b) => b.id === "ex-buddy" || b.id === "ex-buddy/bot");
    if (mine === undefined) fail(`bot.list lists ${bots.map((b) => b.id).join(", ")}`);
    await openSidebarEntry(ctx, "Ex buddy");
    // The bot's column (`bot.side`) opens from the tab's own "Details" button, as the user opens it.
    const side = await drawn(ctx, "ex-buddy", "Today: one page of notes.", "its side panel on its bot's tab", 6_000).catch(async () => {
      await clickShown(ctx, "the tab's Details button", "button.cl-panel-toggle[aria-pressed=false]", "Details", 10_000);
      return drawn(ctx, "ex-buddy", "Today: one page of notes.", "its side panel on its bot's tab, after its Details button");
    });
    const header = await drawn(ctx, "ex-buddy", "Ex buddy", "its header on its bot's tab");
    return `listed in bot.list as ${mine!.id}; on its tab its header ("${header.text.trim().slice(0, 30)}") and side panel ("${side.text.trim().slice(0, 40)}") drawn`;
  });
  await check("ex-theme", async () => {
    // `plugin.ui` is the app's own call: a packaged core's CLI-role connection may not make it, and the plugin's record
    // (`plugin.get`: its manifest's themes) says the same of the theme there.
    const ui = (await rpc.request<{ plugins: { pluginId: string; themes: { id: string }[] }[] }>("plugin.ui", {}).catch((e: unknown) => { if (/may not call plugin\.ui/.test(String((e as { message?: unknown })?.message ?? e))) return undefined; throw e; }))?.plugins;
    if (ui === undefined) {
      const got = (await rpc.request<{ plugin: { state: string; manifest?: { contributes?: { themes?: { id: string }[] } } } }>("plugin.get", { id: "ex-theme" })).plugin;
      const themes = got.manifest?.contributes?.themes ?? [];
      if (got.state !== "running" && got.state !== "enabled") fail(`it is ${got.state}`);
      if (!themes.some((t) => t.id === "ex-theme")) fail(`its record's themes are ${JSON.stringify(themes)}`);
      return `installed and ${got.state}, its record naming its theme (plugin.get; plugin.ui isn't this connection's to call on a packaged core)`;
    }
    const mine = ui.find((p) => p.pluginId === "ex-theme");
    if (mine === undefined || !mine.themes.some((t) => t.id === "ex-theme")) fail(`plugin.ui has ${mine === undefined ? "no ex-theme" : `ex-theme with themes ${JSON.stringify(mine.themes)}`}`);
    return "listed as a theme (plugin.ui: ex-theme#ex-theme)";
  });
  await check("ex-model", async () => {
    const models = (await rpc.request<{ models: { id: string; name: unknown; plugin: string; provider: string }[] }>("models.list", {})).models;
    const mine = models.filter((m) => m.plugin === "ex-model");
    if (mine.length === 0) fail(`models.list has no model of ex-model (${models.filter((m) => /ex/i.test(m.plugin)).map((m) => m.id).join(", ") || "none like it"})`);
    return `its model listed (${mine.map((m) => m.id).join(", ")})`;
  });
  await check("ex-trigger", async () => {
    const s = await stateOf(ctx, "ex-trigger");
    if (s !== "running" && s !== "enabled") fail(`it is ${s ?? "gone"}`);
    return `installed and ${s} (its trigger type is armed only by a routine file: row 1.59)`;
  });

  if (failed.length > 0) fail(`${failed.length} of the examples' checks failed: ${failed.join(" || ")}`);
  return done.join("; ");
}
