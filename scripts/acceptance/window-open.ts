// Opening a plugin's part in the app's window the user's way, and seeing it drawn: a Settings section, a sidebar entry,
// a part that is always there (the status bar), a part inside another's page. Shared by the rows that install plugins
// with UI (the builder's examples, a bot's two plugins and their point); each part is a document of the plugin's own
// layer (`clover-plugin://<id>/…`) that must hold the words its component draws.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SIDEBAR_ITEMS, escape, fail, frames, sleep, treeDocs, until, type ExampleCtx } from "./example-steps";

export interface Drawn { session: string; url: string; text: string }

/** Whether a document's address is plugin `id`'s layer or a child's (`--` stands for `/` in a layer's name): never another
 *  plugin whose id merely starts with it (`ex-board` and `ex-board-widget`). */
export const isLayerOf = (url: string, id: string): boolean => url.startsWith(`clover-plugin://${id}/`) || url.startsWith(`clover-plugin://${id}--`);

/** A document of plugin `id`'s layer (its id or a child's, `clover-plugin://<id>…`) whose own text holds `text`, once it is drawn
 *  with a size: the words its component renders, in a document that has a place on the screen. */
export async function drawn(ctx: ExampleCtx, id: string, text: string, what: string, ms = 40_000, expr?: string): Promise<Drawn> {
  const { cdp } = ctx;
  return until(`${what} (${id}'s layer drawing "${text}")`, ms, async () => {
    for (const d of await cdp.documents()) {
      if (!isLayerOf(d.url, id) || !d.text.includes(text)) continue;
      if (expr !== undefined && (await cdp.evaluate(d.session, expr).catch(() => false)) !== true) continue;
      const sized = await cdp.evaluate(d.session, "(() => { const e = document.body && document.body.firstElementChild; if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; })()").catch(() => false);
      if (sized === true) return d;
    }
    return undefined;
  }, async () => { await shot(ctx, `drawn-${id}`); return frames(cdp); });
}

/** A picture of the main window in the folder CLOVER_ACCEPT_SHOTS names (a failure's evidence); nothing when it names none. */
export async function shot(ctx: ExampleCtx, label: string): Promise<void> {
  const shots = process.env.CLOVER_ACCEPT_SHOTS;
  if (shots === undefined || shots === "") return;
  try {
    mkdirSync(shots, { recursive: true });
    writeFileSync(join(shots, `${label.replace(/[^a-z0-9-]+/gi, "-")}.png`), await ctx.cdp.screenshot());
  } catch { /* no picture */ }
}

/** What the window is doing about the Settings button, for a failure: each tree document's button (its place, and the element
 *  at that place), the dialog's parts, the cards waiting, and a picture of the window when CLOVER_ACCEPT_SHOTS names a folder. */
export async function settingsDiagnosis(ctx: ExampleCtx, label: string): Promise<string> {
  const { cdp } = ctx;
  const out: string[] = [];
  for (const d of await treeDocs(cdp)) {
    const v = await cdp.evaluate(d.session, `(() => {
      const b = document.querySelector('button[aria-label=Settings]');
      let at = null;
      if (b) { const r = b.getBoundingClientRect(); const e = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); at = { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), top: e ? (e.tagName + '.' + String(e.className).slice(0, 40)) : null }; }
      return JSON.stringify({ btn: at, dialog: !!document.querySelector('.cl-settings'), sections: !!document.querySelector('.cl-settings__sections'), win: window.innerWidth + 'x' + window.innerHeight });
    })()`).catch(() => "?");
    out.push(`${d.url.slice(0, 48)} ${String(v).slice(0, 220)}`);
  }
  const cards = await ctx.rpc.request<{ cards: { kind: string; pluginId?: string }[] }>("card.list").then((r) => r.cards.map((c) => `${c.kind}${c.pluginId !== undefined ? `:${c.pluginId}` : ""}`).join(", ") || "none").catch(() => "?");
  await shot(ctx, label);
  return `cards waiting: ${cards}; ${out.join(" || ")}`;
}

/** A trusted click on the first element of the tree's documents that matches `selector` (and, when `text` is given, has a line
 *  or an accessible name exactly that) AND is on the screen: a size, and its centre inside the document's own viewport. A bot's
 *  own layout holds a button off its frame's edge: a click there lands nowhere. (The stock sidebar is drawn beside every tab,
 *  Alpha's too, so its entries always have a size.) */
export async function clickShown(ctx: ExampleCtx, what: string, selector: string, text?: string, ms = 20_000): Promise<void> {
  const { cdp } = ctx;
  const at = await until(what, ms, async () => {
    for (const d of await treeDocs(cdp)) {
      const c = await cdp.evaluate(d.session, `(() => {
        const want = ${JSON.stringify(text ?? null)};
        const els = [...document.querySelectorAll(${JSON.stringify(selector)})].filter((e) => {
          const r = e.getBoundingClientRect();
          const x = r.left + r.width / 2, y = r.top + r.height / 2;
          if (!(r.width > 0 && r.height > 0 && x >= 0 && y >= 0 && x < window.innerWidth && y < window.innerHeight)) return false;
          return want === null || (e.innerText || '').split('\\n').some((l) => l.trim() === want) || e.getAttribute('aria-label') === want;
        });
        const el = els[0];
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`).catch(() => null) as { x: number; y: number } | null;
      if (c !== null && c !== undefined) return { session: d.session, c };
    }
    return undefined;
  }, () => frames(cdp));
  await cdp.click(at.session, at.c.x, at.c.y);
}

/** Opens Settings (the sidebar's gear, when the dialog isn't open already) and chooses the section titled `title`. */
export async function openSettingsSection(ctx: ExampleCtx, title: string): Promise<void> {
  const { cdp } = ctx;
  const open = async (): Promise<boolean> => {
    for (const d of await treeDocs(cdp)) if ((await cdp.evaluate(d.session, "!!document.querySelector('.cl-settings__sections')").catch(() => false)) === true) return true;
    return false;
  };
  if (!(await open())) {
    await escape(cdp);
    // A layer installed a moment ago loads the window's document again, which closes a dialog opened before it: pressed again.
    for (let attempt = 0; attempt < 3; attempt++) {
      // The gear where the tab's layout draws it on the screen; on a tab whose layout keeps it off its frame (a bot's own), the
      // user's other way, `clover-core app open settings` in a terminal (the app's own route to the dialog, as the sidebar's).
      const pressed = await clickShown(ctx, "the Settings button", "button[aria-label=Settings]", undefined, 4_000).then(() => true, () => false);
      if (!pressed) {
        if (ctx.appCli === undefined) fail(`no Settings button is on the screen (${await settingsDiagnosis(ctx, `settings-${title}`)})`);
        await ctx.appCli!(["open", "settings"]);
      }
      const up = await until("the Settings dialog", 8_000, async () => ((await open()) ? true : undefined)).catch(() => undefined);
      if (up === true) break;
      if (attempt === 2) fail(`the Settings dialog didn't open from its button (${await settingsDiagnosis(ctx, `settings-${title}`)})`);
    }
  }
  await clickShown(ctx, `the Settings section "${title}"`, "button.cl-settings__section", title);
  await sleep(500);
}

/** A Settings section drawn: the dialog opened and the section chosen, and the plugin's part in it drawn; a dialog the window's
 *  document closed by loading again for a layer installed a moment ago is opened again (up to three tries). */
export async function drawnInSettings(ctx: ExampleCtx, title: string, id: string, text: string, what: string, expr?: string): Promise<Drawn> {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await openSettingsSection(ctx, title);
      return await drawn(ctx, id, text, what, attempt === 2 ? 40_000 : 20_000, expr);
    } catch (err) {
      last = err;
      await escape(ctx.cdp);
      await sleep(1_000);
    }
  }
  throw last;
}

/** Chooses the sidebar entry `title` (a page's app button, or a bot's row), leaving any dialog first. */
export async function openSidebarEntry(ctx: ExampleCtx, title: string): Promise<void> {
  await escape(ctx.cdp);
  await clickShown(ctx, `the sidebar's ${title} entry`, SIDEBAR_ITEMS, title);
  await sleep(500);
}

/** Waits until the window's documents have stopped loading again: for a layer installed after they were served, and for a
 *  plugin's client the registry built after its OK (its TSX is built then, and its frames load again with the module).
 *  The count of those lines in the app's log the same for `quietMs`. */
export async function reloadsSettled(ctx: ExampleCtx, quietMs = 6_000, ms = 120_000): Promise<number> {
  const count = () => (ctx.appLog().match(/layers: \S+ loads again/g) ?? []).length;
  let last = count();
  let since = Date.now();
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await sleep(500);
    const now = count();
    if (now !== last) { last = now; since = Date.now(); }
    else if (Date.now() - since >= quietMs) return now;
  }
  return fail(`the window's document kept loading again for new layers for ${Math.round(ms / 1000)} s (${last} reloads)`);
}
