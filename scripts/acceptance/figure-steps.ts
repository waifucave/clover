// The figure's rows (spec revision 19, G7: there is no avatar in the platform). The bundled avatar plugin (moss/character)
// shows one figure at a time in a panel of MOSS Code's window beside a session, drawn by the renderer plugin of its format
// through its own UI spot, from packs that fill its own point; a plugin that moves it fills its own `moss.character.figure`;
// MOSS Voice tells the renderers that fill its own `moss.voice.speech` how loud a bot speaks. And the general pieces these
// stand on, proven with plugins that have nothing to do with figures: point messages and the files a point's entries bring.
//
// Every plugin a row installs is written into a temp folder here (nothing is added to the repo), installed the user's way
// behind its OK card, pressed in the window, and removed after. Nothing draws a visible window or plays a sound: the app
// runs headless, and the voice is the run's fixture tone, muted.
import { randomBytes } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Cdp } from "./cdp";
import type { MossClient } from "./client";
import { EXAMPLES, fail, layerDocs, sleep, treeDocs, until } from "./example-steps";

export const GENERAL_POINTS_STEP = "a plugin's point carries messages and files, for any plugin (a metronome and a dancer, nothing about figures): the filler's OK card names the declarer's line; the declarer's message reaches the filler and its answer comes back, in order; a plugin with no entry is refused; the files the dancer's entry brings are served by the declared kinds, and nothing else of its folder";
export const FIGURE_PACK_STEP = "a home made by an earlier MOSS with the person's own models chosen draws them after the figure moved to the avatar plugin (the pick and a Live2D and a VRM own model came over into its own data; beside a coding session the bundled 2D renderer draws the one and the 3D renderer the other, from its own shared files); then the avatar plugin's figure beside a coding session in MOSS Code's window: a third-party avatar pack (the placeholder Live2D files) picked in the avatar plugin's own setting, drawn by the bundled 2D renderer in the session's Avatar panel, with no \"can't be shown\" note";
export const FIGURE_RENDERER_STEP = "a third-party renderer for the avatar plugin (the SDK's picture-swap example, with its own pack) draws the figure beside a coding session; a plugin that fills the avatar plugin's moss.character.figure cues happy and is answered ok as the renderer swaps pictures, and is told plainly when the model has no such expression";
export const FIGURE_REACTS_STEP = "the figure reacts: beside a coding session it follows that session's activity (a turn that ends plays the model's happy picture), and while a bot speaks (the run's fixture voice, on MOSS Voice) its renderer, which fills MOSS Voice's moss.voice.speech, shows its talking picture, then rests";

const AVATAR = "moss/character";
export const RENDERER_PROBE = "(() => { const e = document.querySelector('[data-pngtuber]'); const img = e && e.querySelector('img'); return e ? { state: e.getAttribute('data-pngtuber'), loaded: !!img && img.complete && img.naturalWidth > 0 } : null; })()";

export interface FigureCtx {
  cdp: Cdp;
  rpc: MossClient;
  /** Waits for a pending card and presses its Approve in the window; its id. */
  pressCard(what: string, match: (card: { id: string; kind: string; change?: string; session?: string; pluginId?: string }) => boolean): Promise<string>;
  /** A coding session, shown in the window (the sidebar's Code switch, its row): its id. */
  toCodingSession(): Promise<string>;
  /** Closes what is open over the window (a menu, a sheet). */
  escape(): Promise<void>;
  /** A session's turn that calls one tool (`ACCEPTANCE-CALL`, a deferred one loaded first), its cards answered: the result. */
  /** A new coding session of the person's, on the model the run's key drives (Alpha's), so its later turns reach the run's
   *  fake model; it is then the newest, the one `toCodingSession` shows. Its id. */
  startCodingSession?(): Promise<string>;
  callTool?(session: string, tool: string, input: Record<string, unknown>): Promise<{ called: string; result: { text: string; isError: boolean }; cards: string[] }>;
}

/** The sidebar back on its Bots switch, the Avatar panel closed (where the rows after these expect the window). */
export async function backToBots(f: FigureCtx): Promise<void> {
  for (const [selector, text] of [["button.cl-panel-toggle[aria-label=Avatar][aria-pressed=true]", undefined], [".cl-sidebar__switch-option", "Bots"]] as const) {
    for (const d of await treeDocs(f.cdp)) {
      const c = await f.cdp.centerOf(d.session, selector, text).catch(() => undefined);
      if (c !== undefined) { await f.cdp.click(d.session, c.x, c.y); await sleep(500); break; }
    }
  }
}

type Rpc = MossClient;
const running = async (rpc: Rpc, id: string) => until(`${id} running`, 60_000, async () => ((await rpc.request<{ plugin: { state: string } }>("plugin.get", { id }).catch(() => undefined))?.plugin.state === "running" ? true : undefined),
  async () => JSON.stringify(await rpc.request("plugin.get", { id }).catch(() => null)).slice(0, 300));

/** Installs a folder the user's way: its OK card read (it must say each of `lines`) and pressed in the window; running. */
export async function install(f: FigureCtx, dir: string, id: string, lines: readonly string[] = []): Promise<string> {
  const r = await f.rpc.request<{ id: string }>("plugin.install", { source: { from: "folder", path: dir } }, 60_000);
  if (r.id !== id) fail(`${id} installed as ${r.id}`);
  const card = await until(`${id}'s OK card`, 30_000, async () => (await f.rpc.request<{ cards: { id: string; kind: string; pluginId?: string }[] }>("card.list", {})).cards.find((c) => c.kind === "plugin-ok" && c.pluginId === id));
  const text = JSON.stringify((await f.rpc.request<{ card: unknown }>("card.get", { id: card.id })).card);
  for (const line of lines) if (!text.includes(line)) fail(`${id}'s OK card doesn't say "${line}": ${text.slice(0, 400)}`);
  await f.pressCard(`${id}'s OK card`, (c) => c.id === card.id);
  await running(f.rpc, id);
  return text;
}

export async function removeAll(rpc: Rpc, ids: string[]): Promise<void> {
  for (const id of [...ids].reverse()) await rpc.request("plugin.remove", { id }).catch(() => undefined);
}

export const command = async (rpc: Rpc, name: string): Promise<string> => {
  const r = await rpc.request<{ result?: { text?: string }; text?: string }>("command.run", { name }, 30_000).catch((e: unknown) => ({ text: `threw ${String(e)}` }));
  return (r as { result?: { text?: string } }).result?.text ?? (r as { text?: string }).text ?? "";
};

export const hostPlugin = (dir: string, manifest: Record<string, unknown>, host: string[]): string => {
  mkdirSync(join(dir, "host"), { recursive: true });
  writeFileSync(join(dir, "host", "index.ts"), `${host.join("\n")}\n`);
  writeFileSync(join(dir, "moss.json"), JSON.stringify({ manifest: 1, version: "0.0.1", engines: { moss: "^1.0.0" }, ...manifest, host: { entry: "host/index.ts", runtime: "bun", ...(manifest.host as object | undefined) } }));
  return dir;
};

/** The avatar plugin's figure pick, its own setting (what its Settings section writes). */
export const pick = (rpc: Rpc, figure: string, plugin = AVATAR) => rpc.request("plugin.settings.set", { id: plugin, key: "figure", value: figure });

/** The coding session shown and its Avatar panel open: the figure's place in it drawn. */
export async function figureBesideCode(f: FigureCtx, docs: () => Promise<{ session: string }[]> = () => treeDocs(f.cdp)): Promise<{ session: string; code: string }> {
  const code = await f.toCodingSession();
  const at = await until("the coding session's Avatar panel, open", 45_000, async () => {
    for (const d of await docs()) {
      if (await f.cdp.evaluate(d.session, "!!document.querySelector('.cl-figure[data-place=panel]')").catch(() => false)) return d.session;
    }
    for (const d of await treeDocs(f.cdp)) {
      const c = await f.cdp.centerOf(d.session, "button.cl-panel-toggle[aria-label=Avatar][aria-pressed=false]").catch(() => undefined);
      if (c !== undefined) { await f.cdp.click(d.session, c.x, c.y); await sleep(700); break; }
    }
    return undefined;
  }, async () => `the toggles: ${(await Promise.all((await treeDocs(f.cdp)).map((d) => f.cdp.evaluate(d.session, "[...document.querySelectorAll('.cl-panel-toggle')].map((b) => b.getAttribute('aria-label') + '=' + b.getAttribute('aria-pressed')).join(',')").catch(() => "")))).filter(Boolean).join(" | ")}`);
  return { session: at, code };
}

/** The picture-swap renderer's frame drawing its picture (its own layer's document). */
export const pictureFrame = (f: FigureCtx, renderer = "example-pngtuber") => until("the picture-swap renderer drawing the figure", 60_000, async () => {
  for (const d of await layerDocs(f.cdp, renderer)) {
    const r = await f.cdp.evaluate(d.session, RENDERER_PROBE).catch(() => undefined) as { state: string; loaded: boolean } | null | undefined;
    if (r?.state === "broken") fail("the renderer says the picture set can't be shown");
    if (r?.loaded) return d.session;
  }
  return undefined;
}, async () => (await f.cdp.documents()).map((d) => d.url.slice(0, 60)).join(" | "));

// ------------------------------------------------------------------------------------------------------------------
// The general row: point messages and the files a point's entries bring.

export async function generalPointsStep(f: FigureCtx): Promise<string> {
  const parent = mkdtempSync(join(tmpdir(), "moss-points-row-"));
  const installed: string[] = [];
  const POINT = "acceptance-metronome.beats";
  const LINE = "it hears the metronome's beats and answers them";
  try {
    const metronome = hostPlugin(join(parent, "acceptance-metronome"), {
      id: "acceptance-metronome", name: "Acceptance metronome", description: "Declares a point of beats and sends each filler a beat.",
      host: { declares: { [POINT]: { shape: "list", title: "Beats", fields: { type: "object", required: ["id", "list"], properties: { id: { type: "string" }, list: { type: "string", format: "path" } } }, files: { list: { kinds: [{ ext: [".json"], type: "json", maxBytes: 4096 }] } }, fills: { ok: LINE } } } },
      contributes: { commands: [{ name: "beat", description: "Sends a beat", handler: "beat" }, { name: "heard", description: "What came back", handler: "heard" }] },
    }, [
      "type Api = { points: { send(p: string, v: unknown, o?: { to?: string }): Promise<void>; onMessage(p: string, l: (m: { from: string; value: unknown }) => void): () => void } };",
      "let api: Api | undefined; const back: unknown[] = []; let n = 0;",
      `export async function start(a: Api): Promise<void> { api = a; a.points.onMessage(${JSON.stringify(POINT)}, (m) => back.push({ from: m.from, value: m.value })); }`,
      "export async function stop(): Promise<void> {}",
      `export async function beat(): Promise<{ text: string }> { for (let i = 0; i < 3; i++) await api!.points.send(${JSON.stringify(POINT)}, { n: ++n }); return { text: "beat: sent" }; }`,
      "export async function heard(): Promise<{ text: string }> { return { text: `heard: ${JSON.stringify(back)}` }; }",
    ]);
    const dancer = hostPlugin(join(parent, "acceptance-dancer"), {
      id: "acceptance-dancer", name: "Acceptance dancer", description: "Fills the metronome's point with a list of steps, and answers each beat.",
      contributes: { [POINT]: [{ id: "waltz", list: "lists/en/steps.json" }], commands: [{ name: "ready", description: "Wakes its host half", handler: "ready" }] },
    }, [
      "type Api = { points: { send(p: string, v: unknown): Promise<void>; onMessage(p: string, l: (m: { from: string; value: { n?: number } }) => void): () => void } };",
      `export async function start(a: Api): Promise<void> { a.points.onMessage(${JSON.stringify(POINT)}, (m) => { if (m.from === "acceptance-metronome") void a.points.send(${JSON.stringify(POINT)}, { echo: m.value.n, step: "waltz" }); }); }`,
      "export async function stop(): Promise<void> {}",
      "export async function ready(): Promise<{ text: string }> { return { text: \"ready\" }; }",
    ]);
    mkdirSync(join(dancer, "lists", "en"), { recursive: true });
    writeFileSync(join(dancer, "lists", "en", "steps.json"), JSON.stringify(["box", "turn", "dip"]));
    writeFileSync(join(dancer, "lists", "en", "steps.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
    writeFileSync(join(dancer, "notes.json"), JSON.stringify({ PROBE_SECRET: "dummy123" }));
    const stranger = hostPlugin(join(parent, "acceptance-stranger"), {
      id: "acceptance-stranger", name: "Acceptance stranger", description: "Holds no entry in the metronome's point and tries to send there.",
      contributes: { commands: [{ name: "poke", description: "Tries a beat", handler: "poke" }] },
    }, [
      "type Api = { points: { send(p: string, v: unknown): Promise<void> } };",
      "let api: Api | undefined;",
      "export async function start(a: Api): Promise<void> { api = a; }",
      "export async function stop(): Promise<void> {}",
      `export async function poke(): Promise<{ text: string }> { try { await api!.points.send(${JSON.stringify(POINT)}, { n: 99 }); return { text: "poke: sent" }; } catch (e) { return { text: \`poke: refused \${e instanceof Error ? e.message : String(e)}\` }; } }`,
    ]);
    await install(f, metronome, "acceptance-metronome");
    installed.push("acceptance-metronome");
    await install(f, dancer, "acceptance-dancer", [LINE]);
    installed.push("acceptance-dancer");
    await install(f, stranger, "acceptance-stranger");
    installed.push("acceptance-stranger");

    // A host half hears point messages while it runs, and starts on its first call: the dancer's is woken first.
    await until("the dancer's host half running", 30_000, async () => ((await command(f.rpc, "acceptance-dancer.ready")) === "ready" ? true : undefined), async () => command(f.rpc, "acceptance-dancer.ready"));
    // The messages: three beats out, three answers back, in order.
    const beat = await command(f.rpc, "acceptance-metronome.beat");
    if (beat !== "beat: sent") fail(`the metronome's beat: ${beat}`);
    const heard = await until("the dancer's three answers", 20_000, async () => {
      const t = await command(f.rpc, "acceptance-metronome.heard");
      const list = JSON.parse(t.slice("heard: ".length) || "[]") as { from: string; value: { echo?: number } }[];
      return list.length >= 3 ? list : undefined;
    }, async () => command(f.rpc, "acceptance-metronome.heard"));
    if (heard.some((h) => h.from !== "acceptance-dancer") || heard.map((h) => h.value.echo).join(",") !== "1,2,3") fail(`the answers came back as ${JSON.stringify(heard)}`);
    const poke = await command(f.rpc, "acceptance-stranger.poke");
    if (!poke.startsWith("poke: refused") || !poke.includes("neither declares nor fills")) fail(`a plugin with no entry wasn't refused: ${poke}`);
    const after = JSON.parse((await command(f.rpc, "acceptance-metronome.heard")).slice("heard: ".length)) as unknown[];
    if (after.length !== 3) fail(`the metronome heard ${after.length} messages, not 3`);

    // The files the dancer's entry brings: its list's folder, by the declared kind, to any layer; nothing else of its folder.
    const doc = (await treeDocs(f.cdp))[0] ?? fail("no window document to fetch from");
    const fetched = await f.cdp.evaluate(doc.session, `(async () => { const one = async (p) => { try { const r = await fetch('/_t/acceptance-dancer/' + p); return r.status + ' ' + (r.headers.get('content-type') || '') + ' ' + (r.status === 200 ? (await r.text()).includes('dummy123') : false); } catch (e) { return 'threw'; } }; return JSON.stringify({ list: await one('lists/en/steps.json'), svg: await one('lists/en/steps.svg'), notes: await one('notes.json'), manifest: await one('moss.json') }); })()`) as string;
    const got = JSON.parse(fetched) as Record<string, string>;
    if (!got.list!.startsWith("200 application/json")) fail(`the dancer's list wasn't served as JSON: ${fetched}`);
    for (const k of ["svg", "notes", "manifest"]) if (got[k]!.startsWith("200")) fail(`${k} of the dancer's folder was served: ${fetched}`);
    if (Object.values(got).some((v) => v.endsWith("true"))) fail("the planted dummy was visible");
    return `the dancer's OK card says the metronome's line ("${LINE}"); three beats went out and came back in order from the dancer (echo 1,2,3); the stranger's send was refused (${poke.slice(0, 120)}); the dancer's list was served as ${got.list!.split(" ").slice(0, 2).join(" ")}, its SVG (${got.svg!.split(" ")[0]}), its other JSON (${got.notes!.split(" ")[0]}) and its manifest (${got.manifest!.split(" ")[0]}) not; the planted dummy visible: false`;
  } finally {
    await removeAll(f.rpc, installed);
    rmSync(parent, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------------------------------------------------------
// A third-party pack, drawn by the bundled 2D renderer, beside a coding session.

export async function figurePackStep(f: FigureCtx): Promise<string> {
  // First, the home's earlier figure (seedOldFigure, written before its first daemon): moved and drawn.
  const migrated = await figureMigratedStep(f);
  return `${migrated}; then ${await figurePackRow(f)}`;
}

async function figurePackRow(f: FigureCtx): Promise<string> {
  const parent = mkdtempSync(join(tmpdir(), "moss-figure-pack-"));
  const installed: string[] = [];
  const id = "acceptance-figure-pack";
  try {
    const dir = join(parent, id);
    mkdirSync(join(dir, "model"), { recursive: true });
    // The placeholder's files (generated by code, in Alpha's pack): copied into the temp pack, never into the repo.
    const stock = resolve(import.meta.dir, "..", "..", "plugins", "moss", "plugins", "alpha-figure", "live2d");
    for (const file of ["alpha.model3.json", "alpha.moc3", "alpha.png"]) cpSync(join(stock, file), join(dir, "model", file));
    writeFileSync(join(dir, "moss.json"), JSON.stringify({
      manifest: 1, id, name: "Acceptance figure pack", version: "0.0.1", description: "One figure for the avatar plugin.",
      contributes: { "moss.character.packs": [{ id: "hero", name: "Hero", file: "model/alpha.model3.json", format: "live2d", license: "A placeholder made by code" }] },
    }));
    await install(f, dir, id, ["its figures are offered in the avatar plugin's picker"]);
    installed.push(id);
    await pick(f.rpc, `pack:${id}#hero`);
    await f.escape();
    const place = await figureBesideCode(f);
    const seen = await until("the 2D renderer drawing the pack's model", 60_000, async () => {
      for (const d of await treeDocs(f.cdp)) {
        const r = await f.cdp.evaluate(d.session, "(() => { const fig = document.querySelector('.cl-figure[data-place=panel]'); if (!fig) return null; return { format: fig.getAttribute('data-format'), canvas: !!fig.querySelector('.clvl-canvas'), refused: (fig.innerText || '').includes(\"can't be shown\") }; })()").catch(() => undefined) as { format: string; canvas: boolean; refused: boolean } | null | undefined;
        if (r?.refused) fail("the figure says the model can't be shown");
        if (r?.canvas && r.format === "live2d") return r;
      }
      return undefined;
    });
    return `${id} installed behind its OK card (the avatar plugin's packs line), picked in the avatar plugin's own setting; beside the coding session ${place.code}, its Avatar panel drew the pack's model with the bundled 2D renderer (format ${seen.format}, a canvas, no "can't be shown" note)`;
  } finally {
    await backToBots(f).catch(() => undefined);
    await pick(f.rpc, "").catch(() => undefined);
    await removeAll(f.rpc, installed);
    rmSync(parent, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------------------------------------------------------
// A home an earlier MOSS made, with the person's own models: Alpha's figure their own Live2D model, Luna's their own VRM.

/** What the migrated half of the pack row proves. */
export const FIGURE_MIGRATED_CLAUSE = "a home made by an earlier MOSS with the person's own model chosen draws it after the figure moved to the avatar plugin: the pick and both own models (a Live2D one and a VRM one) came over into the plugin's own data, and beside a coding session the bundled 2D renderer draws the Live2D one and the 3D renderer the VRM one, each from the plugin's own shared files";
/** The folders the earlier MOSS kept the models in (`user-layers/avatars/<bot>/<folder>/`). */
const OLD_LIVE2D = "k1live2d";
const OLD_VRM = "q1vrm";

/** Writes, before the home's first daemon, what an earlier MOSS kept for a person who picked their own models: Alpha's
 *  user layer naming her own Live2D model and Luna's naming a VRM one, their files in the old fenced folder. The
 *  placeholder models are the code-made ones of Alpha's pack, copied into the run's home only. */
export function seedOldFigure(home: string): void {
  const stock = resolve(import.meta.dir, "..", "..", "plugins", "moss", "plugins", "alpha-figure");
  const layers = join(home, "user-layers");
  const live2d = join(layers, "avatars", "alpha", OLD_LIVE2D);
  mkdirSync(live2d, { recursive: true });
  for (const file of ["alpha.model3.json", "alpha.moc3", "alpha.png"]) cpSync(join(stock, "live2d", file), join(live2d, file));
  const vrm = join(layers, "avatars", "luna", OLD_VRM);
  mkdirSync(vrm, { recursive: true });
  cpSync(join(stock, "vrm", "alpha.vrm"), join(vrm, "luna.vrm"));
  writeFileSync(join(layers, "alpha.json"), JSON.stringify({ userLayer: 1, bot: "alpha", fields: { avatar: { file: `user:${OLD_LIVE2D}/alpha.model3.json`, format: "live2d", credit: "Acceptance fixture model, made by code." } } }));
  writeFileSync(join(layers, "luna.json"), JSON.stringify({ userLayer: 1, bot: "luna", fields: { avatar: { file: `user:${OLD_VRM}/luna.vrm`, format: "vrm" } } }));
}

async function figureMigratedStep(f: FigureCtx): Promise<string> {
  const settings = async () => Object.fromEntries((await f.rpc.request<{ settings: { key: string; value?: unknown }[] }>("plugin.settings.get", { id: AVATAR })).settings.map((x) => [x.key, x.value]));
  const live2dFile = `own/alpha/${OLD_LIVE2D}/alpha.model3.json`;
  const vrmFile = `own/luna/${OLD_VRM}/luna.vrm`;
  const before = await settings();
  if (before.figure !== `own:live2d:${live2dFile}`) fail(`the earlier pick didn't come over as the avatar plugin's figure: ${JSON.stringify(before.figure)}`);
  const own = JSON.parse(typeof before.ownModels === "string" ? before.ownModels : "[]") as { file: string; format: string }[];
  if (!own.some((m) => m.file === live2dFile && m.format === "live2d") || !own.some((m) => m.file === vrmFile && m.format === "vrm")) fail(`the own models didn't come over: ${JSON.stringify(own)}`);
  /** The panel's figure drawn by `format`'s renderer, with the model fetched from the plugin's own shared files. */
  const drawn = (what: string, format: string, canvas: string, file: string, figure: string) => until(what, 90_000, async () => {
    for (const d of await treeDocs(f.cdp)) {
      // The renderer's own word: its model loaded (`data-state` ready) from the file the figure handed it, which for an own
      // model is the plugin's own shared file (`/_d/…`, nowhere else); an error state fails at once with its words.
      const r = await f.cdp.evaluate(d.session, `(() => { const fig = document.querySelector('.cl-figure[data-place=panel]'); if (!fig) return null; const a = fig.querySelector(${JSON.stringify(canvas)}); return { format: fig.getAttribute('data-format'), figure: fig.getAttribute('data-figure'), state: a ? a.getAttribute('data-state') : null, text: a ? a.textContent.slice(0, 200) : null, refused: !!fig.querySelector('.cl-figure__empty') }; })()`).catch(() => null) as { format: string; state: string | null; text: string | null; refused: boolean; figure: string | null } | null;
      if (r?.state === "error") fail(`the ${format} renderer couldn't load the moved model (${file}): ${r.text}`);
      if (r?.refused) fail(`the figure says the moved ${format} model can't be shown`);
      // The figure shown is the moved own model itself, not the pack that stands in when the plugin has not (yet) read its own models.
      if (r?.state === "ready" && r.format === format && r.figure === figure) return r;
    }
    return undefined;
  }, async () => {
    // What decides the format shown (the figure's pick and the formats the plugins declare), so a figure that never switched is told from a renderer that was slow.
    const state = await f.rpc.request("plugin.settings.get", { id: AVATAR }).then((r) => JSON.stringify((r as { settings: { key: string; value?: unknown }[] }).settings.filter((x) => x.key === "figure").map((x) => x.value)), (e) => String(e));
    const renderer = await f.rpc.request("plugin.get", { id: `moss/${format}` }).then((r) => JSON.stringify((r as { plugin?: { state?: string } }).plugin?.state ?? null), (e) => String(e));
    return `pick ${state}, renderer plugin moss/${format} state ${renderer}; ${JSON.stringify(await Promise.all((await treeDocs(f.cdp)).map((d) => f.cdp.evaluate(d.session, "(() => { const fig = document.querySelector('.cl-figure'); return fig ? fig.outerHTML.slice(0, 300) : null; })()").catch(() => null))))}`;
  });
  try {
    const place = await figureBesideCode(f);
    await drawn("the bundled 2D renderer drawing the moved Live2D model", "live2d", ".clvl-avatar", live2dFile, `own:live2d:${live2dFile}`);
    await pick(f.rpc, `own:vrm:${vrmFile}`);
    await drawn("the bundled 3D renderer drawing the moved VRM model", "vrm", ".clvr-avatar", vrmFile, `own:vrm:${vrmFile}`);
    return `the earlier MOSS's pick came over as the avatar plugin's figure (own:live2d:${live2dFile}) with both own models (${own.map((m) => m.format).join(", ")}); beside the coding session ${place.code} the bundled 2D renderer drew the Live2D one and, picked, the 3D renderer the VRM one, each loaded (its renderer ready) from the plugin's own shared files`;
  } finally {
    await backToBots(f).catch(() => undefined);
    await pick(f.rpc, "").catch(() => undefined);
  }
}

// ------------------------------------------------------------------------------------------------------------------
// A third-party renderer and a controller.

/** A plugin that moves the figure: it fills `moss.character.figure` and sends a cue, waiting for the avatar plugin's answer. */
export function controller(dir: string, point = "moss.character.figure", declarer = AVATAR, id = "acceptance-figure-moves"): string {
  return hostPlugin(dir, {
    id, name: "Acceptance figure moves", description: "Cues the avatar plugin's figure.",
    contributes: { [point]: [{ id: "moves" }], commands: [{ name: "happy", description: "Cues happy", handler: "happy" }, { name: "angry", description: "Cues angry", handler: "angry" }] },
  }, [
    "type Api = { points: { send(p: string, v: unknown): Promise<void>; onMessage(p: string, l: (m: { from: string; value: { id?: string; result?: unknown } }) => void): () => void } };",
    "let api: Api | undefined; const answers = new Map<string, unknown>();",
    `export async function start(a: Api): Promise<void> { api = a; a.points.onMessage(${JSON.stringify(point)}, (m) => { if (m.from === ${JSON.stringify(declarer)} && typeof m.value?.id === "string") answers.set(m.value.id, m.value.result); }); }`,
    "export async function stop(): Promise<void> {}",
    "async function cue(name: string): Promise<{ text: string }> {",
    "  const id = `${name}-${Date.now()}`;",
    `  await api!.points.send(${JSON.stringify(point)}, { id, cue: { type: "expression", name } });`,
    "  for (let i = 0; i < 50 && !answers.has(id); i++) await new Promise((r) => setTimeout(r, 100));",
    "  return { text: `cue: ${JSON.stringify(answers.get(id) ?? null)}` };",
    "}",
    "export const happy = () => cue(\"happy\");",
    "export const angry = () => cue(\"angry\");",
  ]);
}

export async function figureRendererStep(f: FigureCtx): Promise<string> {
  const parent = mkdtempSync(join(tmpdir(), "moss-figure-renderer-"));
  const installed: string[] = [];
  try {
    await install(f, join(EXAMPLES, "example-pngtuber"), "example-pngtuber", ["it draws the figure the avatar plugin shows"]);
    installed.push("example-pngtuber");
    const moves = controller(join(parent, "acceptance-figure-moves"));
    await install(f, moves, "acceptance-figure-moves", ["moves the figure"]);
    installed.push("acceptance-figure-moves");
    await pick(f.rpc, "pack:example-pngtuber#sunny");
    await f.escape();
    // A coding session whose turns the run's model answers (its tool calls below), shown beside the figure.
    if (f.startCodingSession !== undefined) await f.startCodingSession();
    const place = await figureBesideCode(f);
    const frame = await pictureFrame(f);
    const happy = await until("the controller's happy cue answered ok", 30_000, async () => {
      const t = await command(f.rpc, "acceptance-figure-moves.happy");
      return t.includes('"ok":true') ? t : undefined;
    }, async () => command(f.rpc, "acceptance-figure-moves.happy"));
    await until("the renderer showing the cued picture set", 15_000, async () => ((await f.cdp.evaluate(frame, RENDERER_PROBE).catch(() => undefined)) as { state?: string } | null | undefined)?.state === "happy" ? true : undefined,
      async () => JSON.stringify(await f.cdp.evaluate(frame, RENDERER_PROBE).catch(() => "?")));
    // The renderer's names reach the avatar plugin a moment after it draws (it asks again until they do): until then a cue
    // goes on to the renderer; once they have, a name the model lacks is answered plainly.
    const angry = await until("a cue the model has no name for answered plainly", 20_000, async () => {
      const t = await command(f.rpc, "acceptance-figure-moves.angry");
      return t.includes('"ok":false') && t.includes("unknown-name") ? t : undefined;
    }, async () => `the cue was answered ${await command(f.rpc, "acceptance-figure-moves.angry")}`);
    // The avatar plugin's own tools (its figure server): the coding session's call reaches the figure beside it, which
    // judges it by the renderer's names; a bot's (Alpha's) with the figure not following bots is told plainly that
    // nothing moved.
    let toolsSaid = "";
    if (f.callTool !== undefined) {
      await f.rpc.request("plugin.settings.set", { id: "moss/character", key: "followBots", value: false }, 20_000);
      try {
        const lacks = await f.callTool(place.code, "set_expression", { name: "angry" });
        if (!lacks.result.isError || !/this model has no expression "angry"; it has: happy/.test(lacks.result.text)) fail(`the coding session's set_expression wasn't refused with the model's names: ${JSON.stringify(lacks.result)}`);
        const status = await f.callTool(place.code, "figure_status", {});
        if (status.result.isError || !/expressions: happy/.test(status.result.text)) fail(`the coding session's figure_status didn't list the model's names: ${JSON.stringify(status.result)}`);
        const alpha = (await f.rpc.request<{ bots: { id: string; mainSession: string }[] }>("bot.list", {})).bots.find((b) => b.id === "alpha")?.mainSession ?? fail("no Alpha");
        const bot = await f.callTool(alpha, "set_expression", { name: "happy" });
        if (!bot.result.isError || !/no avatar is shown/.test(bot.result.text)) fail(`Alpha's set_expression with the figure not following bots wasn't told that nothing moved: ${JSON.stringify(bot.result)}`);
        toolsSaid = `; the avatar plugin's own tools: the coding session's ${lacks.called} was refused with the model's names ("${lacks.result.text}"), its figure_status said "${status.result.text}" (${[...lacks.cards, ...status.cards].length} card(s) answered), and Alpha's set_expression, with the figure not following bots, was told "${bot.result.text.slice(0, 60)}…"`;
      } finally {
        await f.rpc.request("plugin.settings.set", { id: "moss/character", key: "followBots", value: null }, 20_000).catch(() => undefined);
      }
    }
    return `example-pngtuber (renderer and pack) and a controller installed behind their OK cards (the avatar plugin's renderer and figure lines); beside the coding session ${place.code} the picture-swap renderer drew Sunny; the controller's happy cue was answered ${happy.slice(5)} and the renderer swapped to its happy set; angry was answered ${angry.slice(5, 90)}${toolsSaid}`;
  } finally {
    await backToBots(f).catch(() => undefined);
    await pick(f.rpc, "").catch(() => undefined);
    await removeAll(f.rpc, installed);
    rmSync(parent, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------------------------------------------------------
// The figure reacting to a session's activity, and to speech.

export async function figureReactsStep(f: FigureCtx): Promise<string> {
  const installed: string[] = [];
  const voiced: string[] = [];
  const setVoice = async (bot: string, voice: { provider: string; voice: string } | null) => {
    for (const [key, value] of [["provider", voice?.provider ?? null], ["voice", voice?.voice ?? null]] as const) await f.rpc.request("plugin.settings.set", { id: "moss/voice", key, value, bot });
  };
  try {
    await install(f, join(EXAMPLES, "example-pngtuber"), "example-pngtuber");
    installed.push("example-pngtuber");
    await install(f, resolve(import.meta.dir, "fixtures", "acceptance-voice"), "acceptance-voice");
    installed.push("acceptance-voice");
    await pick(f.rpc, "pack:example-pngtuber#sunny");
    await f.escape();
    const place = await figureBesideCode(f);
    // Every picture the renderer shows, kept as it changes (the whole document watched, so a picture redrawn in a new element
    // still counts); a frame that was replaced is found again and watched from then on, its earlier pictures kept here.
    const WATCH = "(() => { if (window.__seen) return true; const at = () => document.querySelector('[data-pngtuber]')?.getAttribute('data-pngtuber'); window.__seen = [at()].filter(Boolean); new MutationObserver(() => { const v = at(); if (v && window.__seen.at(-1) !== v) window.__seen.push(v); }).observe(document, { attributes: true, subtree: true, childList: true, attributeFilter: ['data-pngtuber'] }); return true; })()";
    let frame = await pictureFrame(f);
    await f.cdp.evaluate(frame, WATCH);
    const earlier: string[] = [];
    let last: string[] = [];
    await f.cdp.evaluate(place.session, "(() => { const e = document.querySelector('.cl-figure[data-place=panel]'); window.__act = [e.getAttribute('data-activity')]; new MutationObserver(() => window.__act.push(e.getAttribute('data-activity'))).observe(e, { attributes: true, attributeFilter: ['data-activity'] }); return true; })()");
    const seen = async (): Promise<string[]> => {
      const got = await f.cdp.evaluate(frame, "window.__seen ? JSON.stringify(window.__seen) : null").catch(() => null);
      if (typeof got === "string") { last = JSON.parse(got) as string[]; return [...earlier, ...last]; }
      earlier.push(...last);
      last = [];
      const again = await pictureFrame(f).catch(() => undefined);
      if (again !== undefined) { frame = again; await f.cdp.evaluate(frame, WATCH).catch(() => undefined); }
      return earlier;
    };
    const acts = async () => JSON.parse(String(await f.cdp.evaluate(place.session, "JSON.stringify(window.__act || [])").catch(() => "[]"))) as string[];

    // The session beside it works a turn and ends it: the figure follows (its activity), and `done` plays its happy picture.
    const tag = `ACCEPTANCE-TAG-${randomBytes(4).toString("hex").toUpperCase()}`;
    await f.rpc.request("session.send", { id: place.code, message: { text: `Say something. ${tag}`, clientMessageId: `figure-${tag}` } }, 30_000);
    const states = await until("the figure following the session's turn to its end", 120_000, async () => {
      const a = (await acts()).filter(Boolean);
      return a.some((s) => s !== "idle") && (a.at(-1) === "done" || a.at(-1) === "idle") && a.length >= 2 ? a : undefined;
    }, async () => `activity ${JSON.stringify(await acts())}; pictures ${JSON.stringify(await seen())}`);
    const happy = await until("the happy picture for the turn's end", 20_000, async () => ((await seen()).includes("happy") ? true : undefined), async () => `pictures ${JSON.stringify(await seen())}; activity ${JSON.stringify(states)}`);
    void happy;

    // Speech: Alpha speaks in the run's fixture voice; MOSS Voice tells the renderer (which fills its speech point).
    // Her `long` voice (2.5 s): long enough to be seen beside the happy picture her turn's end may still be playing.
    await setVoice("alpha", { provider: "acceptance-voice", voice: "long" });
    voiced.push("alpha");
    const before = (await seen()).length;
    const main = (await f.rpc.request<{ bots: { id: string; mainSession: string }[] }>("bot.list", {})).bots.find((b) => b.id === "alpha")?.mainSession ?? fail("no Alpha");
    const tag2 = `ACCEPTANCE-TAG-${randomBytes(4).toString("hex").toUpperCase()}`;
    await f.rpc.request("session.send", { id: main, message: { text: `Say something. ${tag2}`, clientMessageId: `figure-${tag2}` } }, 30_000);
    const talked = await until("the talking picture while Alpha speaks, then rest", 150_000, async () => {
      const s = (await seen()).slice(before);
      return s.includes("talk") && s.at(-1) !== "talk" ? s : undefined;
    }, async () => `pictures ${JSON.stringify(await seen())}`);
    return `beside the coding session ${place.code} the figure followed the session's turn (${states.join(" → ")}) and played its happy picture as it ended; while Alpha spoke in the fixture voice, the renderer showed ${talked.join(" → ")}, from MOSS Voice's moss.voice.speech`;
  } finally {
    await backToBots(f).catch(() => undefined);
    for (const id of voiced) await setVoice(id, null).catch(() => undefined);
    await pick(f.rpc, "").catch(() => undefined);
    await removeAll(f.rpc, installed);
  }
}
