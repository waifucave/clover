// The avatar plugin's own clause (spec revision 19, G7: there is no avatar in the platform; the owner's ruling of 2026-11-15:
// the stage is a plugin that takes renderer plugins, and nothing in the app or the core knows it by id). A copy of the bundled
// avatar plugin (moss/character), folder-installed under another id behind its OK card, is an avatar plugin like it: its points
// are its own (`mirror-avatar.renderer`, `.formats`, `.packs`, `.figure`, as a third party's must be named), and a renderer, a
// pack and a controller fill them as they fill the bundled one's:
//   * its OK card says what it holds, in the catalog's plain lines (the activity feed, the overlay), and the renderer's card
//     says the copy's own line for its renderer spot;
//   * with the bundled avatar plugin switched off, the copy's figure stands beside a CODE session in MOSS Code's window (its
//     own panel), drawn by the picture-swap renderer filling the copy's spot, and a controller filling the copy's `.figure`
//     cues `happy`: the copy answers ok and the renderer's frame swaps picture sets;
//   * the bundled avatar plugin comes back when switched on again (and the copy off): its own figure stands beside the session;
//   * the app logged no refusal of the copy's calls (by id or by want of a capability).
// Nothing here names the bundled plugin's id but to switch it off and on: the copy is the avatar plugin's own source, built into
// a client module, given another id and name and its points renamed to that id.
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CLIENT_BARE_IMPORTS, capabilityOkText } from "../../packages/plugin-sdk/src/index";
import { EXAMPLES, fail, layerDocs, sleep, treeDocs, until, type ExampleCtx } from "./example-steps";
import { RENDERER_PROBE, backToBots, command, controller, figureBesideCode, install, pick, pictureFrame, removeAll, type FigureCtx } from "./figure-steps";
import { ensureCodingSession, toCodingSession } from "./ui-steps";

export const STAGE_COPY_STEP = "a folder-installed copy of the avatar plugin, under another id with its own points and behind its OK card, is an avatar plugin like the bundled one: a renderer, a pack and a controller fill its points; with the bundled one off, its figure stands beside a coding session drawn by that renderer and its controller's cue is answered ok; the bundled one comes back when switched on again; the app logs no refusal by id";

const PLUGINS = resolve(import.meta.dir, "..", "..", "plugins", "moss", "plugins");
export const COPY_ID = "mirror-avatar";
const COPY_NAME = "Mirror avatar";
export const RENDERER_ID = "mirror-pngtuber";
/** The bundled plugin the copy stands beside (switched off while the copy shows, on again after). */
const BUNDLED = "moss/character";

/** The copy's own names for what the bundled plugin calls `moss.character.*` (a third party's points start with its id). */
const renamed = (text: string): string => text.split("moss.character.").join(`${COPY_ID}.`).split('"moss/character"').join(JSON.stringify(COPY_ID)).split("moss%2Fcharacter").join(COPY_ID);

/** The OK card's plain lines for what the copy holds: the catalog's own `ok` words for each capability. */
export function copyOkLines(): string[] {
  return (copyManifest().capabilities as string[]).map((c) => capabilityOkText(c) ?? c);
}

/** The copy's manifest: the bundled avatar plugin's, with an id and a name of its own, its points renamed to its id, and its
 *  client built to one module. Its capabilities are the bundled plugin's own, so what it may do is what its OK card says. */
export function copyManifest(): Record<string, unknown> {
  const src = JSON.parse(renamed(readFileSync(join(PLUGINS, "character", "moss.json"), "utf8"))) as Record<string, unknown> & { contributes: Record<string, unknown>; client: Record<string, unknown> };
  // Its client only: the bundled plugin's host half (its tools, its own models' import) is not what this clause copies.
  const { locales: _locales, mcpServers: _servers, ...contributes } = src.contributes;
  const { host: _host, ...rest } = src;
  return { ...rest, id: COPY_ID, name: COPY_NAME, client: { ...src.client, entry: "client/index.js" }, contributes };
}

/** One client entry built to a module (everything bundled in but the layers' bare imports), with the copy's names. */
async function buildClient(entry: string, outDir: string): Promise<void> {
  mkdirSync(outDir, { recursive: true });
  const result = await Bun.build({
    entrypoints: [entry], outdir: outDir, target: "browser", format: "esm", splitting: false, minify: false,
    naming: { entry: "index.[ext]" }, external: [...CLIENT_BARE_IMPORTS], define: { "process.env.NODE_ENV": JSON.stringify("production") }, throw: false,
    ...{ macros: false },
  });
  const out = join(outDir, "index.js");
  if (!result.success || !existsSync(out)) throw new Error(`${entry} wasn't built: ${result.logs.map((l) => String(l)).join("; ").slice(0, 400)}`);
  writeFileSync(out, renamed(readFileSync(out, "utf8")));
}

/** Writes the copy's folder under `root` and returns its path: the avatar plugin's own source, its names the copy's. */
export async function buildCopy(root: string): Promise<string> {
  const dir = join(root, COPY_ID);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "client"), { recursive: true });
  const manifest = copyManifest() as { client: { css?: string[] } };
  writeFileSync(join(dir, "moss.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const css of manifest.client.css ?? []) copyFileSync(join(PLUGINS, "character", css), join(dir, css));
  await buildClient(join(PLUGINS, "character", "client", "index.tsx"), join(dir, "client"));
  return dir;
}

/** The SDK's picture-swap renderer and its pack, filling the copy's points instead of the bundled plugin's. */
export async function buildRenderer(root: string): Promise<string> {
  const from = join(EXAMPLES, "example-pngtuber");
  const dir = join(root, RENDERER_ID);
  rmSync(dir, { recursive: true, force: true });
  cpSync(join(from, "sample-model"), join(dir, "sample-model"), { recursive: true });
  if (existsSync(join(from, "locales"))) cpSync(join(from, "locales"), join(dir, "locales"), { recursive: true });
  const m = JSON.parse(renamed(readFileSync(join(from, "moss.json"), "utf8"))) as Record<string, unknown> & { client: Record<string, unknown> };
  const client = { ...m.client, entry: "client/index.js" };
  for (const css of (m.client.css as string[] | undefined) ?? []) { mkdirSync(join(dir, css, ".."), { recursive: true }); copyFileSync(join(from, css), join(dir, css)); }
  writeFileSync(join(dir, "moss.json"), `${JSON.stringify({ ...m, id: RENDERER_ID, name: "Mirror picture-swap", client }, null, 2)}\n`);
  await buildClient(join(from, "client", "index.tsx"), join(dir, "client"));
  return dir;
}

export async function stageCopyStep(ctx: ExampleCtx, _session: string): Promise<string> {
  const { rpc, cdp } = ctx;
  const said: string[] = [];
  const parent = mkdtempSync(join(tmpdir(), "moss-avatar-copy-"));
  const installed: string[] = [];
  let switchedOff = false;
  const refusals = () => ctx.appLog().split("\n").filter((l) => l.includes(`tree: ${COPY_ID}:`) && l.includes("refused"));
  const f: FigureCtx = {
    cdp, rpc, pressCard: ctx.pressCard,
    toCodingSession: async () => {
      const id = await ensureCodingSession(ctx) ?? fail("this run could not start a coding session");
      await toCodingSession(cdp, id, async (what, selector, text, ms = 20_000) => {
        const at = await until(what, ms, async () => {
          for (const d of await treeDocs(cdp)) {
            const c = await cdp.centerOf(d.session, selector, text).catch(() => undefined);
            if (c !== undefined) return { session: d.session, c };
          }
          return undefined;
        });
        await cdp.click(at.session, at.c.x, at.c.y);
        await sleep(700);
      });
      return id;
    },
    escape: async () => { for (const type of ["keyDown", "keyUp"]) for (const d of await treeDocs(cdp)) await cdp.send("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, d.session).catch(() => undefined); await sleep(300); },
  };
  try {
    // 1. The copy, then a renderer and a controller filling its points, each behind its OK card.
    const copy = await buildCopy(ctx.root);
    await install(f, copy, COPY_ID, copyOkLines());
    installed.push(COPY_ID);
    const renderer = await buildRenderer(parent);
    await install(f, renderer, RENDERER_ID, ["it draws the figure the avatar plugin shows"]);
    installed.push(RENDERER_ID);
    const moves = controller(join(parent, "mirror-moves"), `${COPY_ID}.figure`, COPY_ID, "mirror-moves");
    await install(f, moves, "mirror-moves", ["moves the figure"]);
    installed.push("mirror-moves");
    said.push(`the copy installed behind an OK card that carries its capabilities' lines, and its renderer's and controller's cards carried the copy's own lines for its points`);

    // 2. The copy shows: the bundled one off (as a user would in the Plugins page), the copy's figure beside a coding session.
    await rpc.request("plugin.setEnabled", { id: BUNDLED, enabled: false }, 30_000);
    switchedOff = true;
    await pick(rpc, `pack:${RENDERER_ID}#sunny`, COPY_ID);
    await f.escape();
    const place = await figureBesideCode(f, () => layerDocs(cdp, COPY_ID));
    const frame = await pictureFrame(f, RENDERER_ID);
    const answered = await until("the controller's cue answered ok by the copy", 30_000, async () => {
      const t = await command(rpc, "mirror-moves.happy");
      return t.includes('"ok":true') ? t : undefined;
    }, async () => command(rpc, "mirror-moves.happy"));
    await until("the renderer's frame showing the cued picture set", 20_000, async () => ((await cdp.evaluate(frame, RENDERER_PROBE).catch(() => undefined)) as { state?: string } | null | undefined)?.state === "happy" ? true : undefined,
      async () => `the renderer says ${JSON.stringify(await cdp.evaluate(frame, RENDERER_PROBE).catch(() => "?"))}`);
    said.push(`with the bundled avatar plugin off, the copy's figure stood beside the coding session ${place.code} (its own panel, in its own layer), drawn by the renderer filling the copy's spot; the controller's cue was answered ${answered.slice(5)} and the renderer swapped to the cued set`);

    // 3. The bundled one comes back when switched on again (the copy off): its figure stands beside the session.
    await rpc.request("plugin.setEnabled", { id: COPY_ID, enabled: false }, 30_000);
    await rpc.request("plugin.setEnabled", { id: BUNDLED, enabled: true }, 30_000);
    switchedOff = false;
    await until("the copy's documents gone", 30_000, async () => ((await layerDocs(cdp, COPY_ID)).length === 0 ? true : undefined));
    await figureBesideCode(f);
    said.push("the copy off and the bundled avatar plugin on again: its own figure stood beside the session");

    // The app logged no refusal of the copy's calls: not by its id, not for want of a capability.
    const refused = refusals();
    if (refused.length > 0) fail(`the app refused the copy's calls: ${refused.slice(-3).join(" | ")}`);
    said.push("the app logged no refusal of the copy's calls");
    return said.join("; ");
  } finally {
    await backToBots(f).catch(() => undefined);
    if (switchedOff) await rpc.request("plugin.setEnabled", { id: BUNDLED, enabled: true }, 30_000).catch(() => undefined);
    await removeAll(rpc, installed);
    for (let i = 0; i < 30 && (await layerDocs(cdp, COPY_ID)).length > 0; i++) await sleep(300);
    rmSync(join(ctx.root, COPY_ID), { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
}
