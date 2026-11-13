// A bot builds a plugin that takes plugins (checklist 5.12: points and add-ons, the video editor's shape). Alpha, in her
// own conversation at the default level, through the scripted fake model and the workshop's own pattern (workshop-step.ts):
// 1. The first plugin, `ws-board`, the builder's `point` template (PluginNew, the files Written into her scratch,
//    PluginValidate, PluginInstall): a Settings section that declares a point, `ws-board.items`, and lists what other
//    plugins add to it. Its OK card, pressed in the window, and it runs; its section in the Settings dialog is drawn with
//    no item.
// 2. The second plugin, `ws-board-item`, which Alpha writes by hand (a manifest filling the point with one entry, a title):
//    validated, installed; while its OK card waits, the first plugin's section still shows nothing (a plugin that isn't
//    OK'd adds nothing). Pressed, the section shows the second plugin's entry, drawn by the first plugin's own layer.
// Both are removed afterwards (the second first), whatever happened.
import { escape, fail, leave, until, type ExampleCtx } from "./example-steps";
import { cardsOf, ok, pluginOf, stepOf } from "./workshop-step";
import { drawnInSettings, isLayerOf, openSettingsSection, reloadsSettled } from "./window-open";
import { templateFiles } from "../../packages/plugin-sdk/src/templates/index";

export const WORKSHOP_POINTS_STEP = "a bot builds a plugin that takes plugins: Alpha builds a plugin with a point (PluginNew, Write, PluginValidate, PluginInstall) and a second plugin that fills it; the first one's Settings section in the window shows nothing until the second's OK card is pressed, then its entry";

export const BOARD_ID = "ws-board";
export const BOARD_NAME = "Workshop board";
export const ITEM_ID = "ws-board-item";
export const ITEM_NAME = "Workshop board item";
export const ITEM_TITLE = "Hello from Alpha's second plugin";
export const BOARD_POINT = `${BOARD_ID}.items`;

/** The first plugin's files: the `point` template's (what PluginNew gives). */
export function boardFiles(): Record<string, string> {
  const made = templateFiles("point", { id: BOARD_ID, name: BOARD_NAME });
  if ("error" in made) throw new Error(made.error);
  return { ...made.files };
}

/** The second plugin's files: a manifest that adds one entry to the first one's point, and nothing else. */
export function itemFiles(): Record<string, string> {
  return {
    "clover.json": `${JSON.stringify({
      manifest: 1,
      id: ITEM_ID,
      name: ITEM_NAME,
      description: "An item on Workshop board, added by Alpha.",
      engines: { clover: "^1.0.0" },
      contributes: { [BOARD_POINT]: [{ id: "hello", title: ITEM_TITLE }] },
    }, null, 2)}\n`,
  };
}

async function pressOk(ctx: ExampleCtx, id: string, card: { id: string }): Promise<void> {
  await ctx.pressCard(`${id}'s OK card`, (c) => c.id === card.id);
  await until(`${id} running after its OK`, 60_000, async () => {
    const s = (await pluginOf(ctx, id))?.state;
    return s === "running" || s === "enabled" ? true : undefined;
  }, async () => `it is ${(await pluginOf(ctx, id))?.state ?? "gone"}`);
  // A plugin with UI loads the window's document again to frame its layer: what the row opens next waits for that.
  await reloadsSettled(ctx);
}

export async function workshopPointsStep(ctx: ExampleCtx, session: string): Promise<string> {
  try {
    return await run(ctx, session);
  } finally {
    for (const c of await cardsOf(ctx).catch(() => [])) if (c.pluginId === ITEM_ID || c.pluginId === BOARD_ID) await ctx.denyCard(c.id).catch(() => undefined);
    await escape(ctx.cdp).catch(() => undefined);
    await leave(ctx, ITEM_ID);
    await leave(ctx, BOARD_ID);
  }
}

async function run(ctx: ExampleCtx, session: string): Promise<string> {
  const { home } = ctx;
  const done: string[] = [];
  const scratch = (id: string) => `${home}/scratch/alpha/${id}`;
  const built = async (id: string, files: Record<string, string>, template?: { template: string; name: string }) => {
    if (template !== undefined) {
      const made = await ok(ctx, session, "PluginNew", { template: template.template, id, name: template.name });
      if (!made.called!.endsWith("__PluginNew")) fail(`the scaffold call was ${made.called}, not the builder's PluginNew`);
      if (!made.result.text.startsWith(`Made a ${template.template} plugin, ${id}:`)) fail(`PluginNew answered "${made.result.text.slice(0, 160)}"`);
    }
    for (const [path, content] of Object.entries(files)) await ok(ctx, session, "Write", { file_path: `${scratch(id)}/${path}`, content });
    const checked = await ok(ctx, session, "PluginValidate", { folder: id });
    if (!/\bvalid\b/.test(checked.result.text) || /invalid/.test(checked.result.text)) fail(`PluginValidate of ${id} said "${checked.result.text.slice(0, 300)}"`);
    const inst = await ok(ctx, session, "PluginInstall", { folder: id });
    const card = inst.raised.find((c) => c.kind === "plugin-ok" && c.pluginId === id)
      ?? await until(`${id}'s OK card`, 30_000, async () => (await cardsOf(ctx)).find((c) => c.kind === "plugin-ok" && c.pluginId === id));
    const state = (await pluginOf(ctx, id))?.state;
    if (state !== "found") fail(`before the OK ${id} is ${state ?? "not installed"}, not found`);
    return card;
  };

  // 1. The plugin with a point.
  const boardCard = await stepOf("1. Alpha builds the plugin with the point (PluginNew, Write, PluginValidate, PluginInstall) and its OK card is pressed", async () => {
    const card = await built(BOARD_ID, boardFiles(), { template: "point", name: BOARD_NAME });
    await pressOk(ctx, BOARD_ID, card);
    return card;
  });
  done.push(`1 ${BOARD_ID} built by Alpha (the point template: PluginNew, 3 Writes, PluginValidate, PluginInstall), OK card ${boardCard.id} pressed, running`);

  const items = (d: { session: string }) => ctx.cdp.evaluate(d.session, "JSON.stringify([...document.querySelectorAll('li')].map((e) => e.textContent))").then((v) => JSON.parse(String(v)) as string[]);
  // Its section in Settings is drawn (a list with no item yet).
  await stepOf("1b. its Settings section is drawn in the window with no item", async () => {
    const d = await drawnInSettings(ctx, BOARD_NAME, BOARD_ID, "", `${BOARD_ID}'s section`, "!!document.querySelector('ul')");
    const now = await items(d);
    if (now.length > 0) fail(`its section lists ${JSON.stringify(now)} before any plugin fills the point`);
    done.push("1b its Settings section drawn by its own layer, a list with no item");
  });

  // 2. The plugin that fills it: found, waiting for its OK, adds nothing yet.
  const itemCard = await stepOf("2. Alpha writes the second plugin, validates and installs it", async () => {
    const card = await built(ITEM_ID, itemFiles());
    return card;
  });
  await stepOf("2b. while its OK card waits, the first plugin's section shows nothing", async () => {
    await openSettingsSection(ctx, BOARD_NAME);
    await new Promise((r) => setTimeout(r, 2_000));
    for (const x of await ctx.cdp.documents()) {
      if (!isLayerOf(x.url, BOARD_ID)) continue;
      if ((await ctx.cdp.evaluate(x.session, "!!document.querySelector('ul')").catch(() => false)) !== true) continue;
      const now = await items(x);
      if (now.length > 0) fail(`its section lists ${JSON.stringify(now)} while ${ITEM_ID} waits for its OK`);
    }
    done.push(`2 ${ITEM_ID} written by Alpha (a manifest filling ${BOARD_POINT}), validated, installed found; its OK card ${itemCard.id} waiting, the section shows nothing`);
  });

  // 3. Pressed: the entry is in the first plugin's section.
  await stepOf("3. its OK card pressed, the first plugin's section shows its entry", async () => {
    await escape(ctx.cdp);
    await pressOk(ctx, ITEM_ID, itemCard);
    await drawnInSettings(ctx, BOARD_NAME, BOARD_ID, ITEM_TITLE, `${BOARD_ID}'s section listing ${ITEM_ID}'s entry`);
    done.push(`3 ${ITEM_ID}'s OK card pressed: ${BOARD_ID}'s section lists "${ITEM_TITLE}", drawn by its own layer`);
  });
  return done.join("; ");
}
