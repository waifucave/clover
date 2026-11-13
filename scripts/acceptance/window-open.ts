// Opening a plugin's part in the app's window the user's way, and seeing it drawn: a Settings section, a sidebar entry,
// a part that is always there (the status bar), a part inside another's page. Shared by the rows that install plugins
// with UI (the builder's examples, a bot's two plugins and their point); each part is a document of the plugin's own
// layer (`clover-plugin://<id>/…`) that must hold the words its component draws.
import { SIDEBAR_ITEMS, clickExact, clickTree, escape, fail, frames, sleep, treeDocs, until, type ExampleCtx } from "./example-steps";

export interface Drawn { session: string; url: string; text: string }

/** A document of plugin `id`'s layer (its id or a child's, `clover-plugin://<id>…`) whose own text holds `text`, once it is drawn
 *  with a size: the words its component renders, in a document that has a place on the screen. */
export async function drawn(ctx: ExampleCtx, id: string, text: string, what: string, ms = 40_000): Promise<Drawn> {
  const { cdp } = ctx;
  return until(`${what} (${id}'s layer drawing "${text}")`, ms, async () => {
    for (const d of await cdp.documents()) {
      if (!d.url.startsWith(`clover-plugin://${id}`) || !d.text.includes(text)) continue;
      const sized = await cdp.evaluate(d.session, "(() => { const e = document.body && document.body.firstElementChild; if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; })()").catch(() => false);
      if (sized === true) return d;
    }
    return undefined;
  }, () => frames(cdp));
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
      await clickTree(cdp, "the Settings button", "button[aria-label=Settings]");
      const up = await until("the Settings dialog", 8_000, async () => ((await open()) ? true : undefined)).catch(() => undefined);
      if (up === true) break;
      if (attempt === 2) fail(`the Settings dialog didn't open from its button (${await frames(cdp)})`);
    }
  }
  await clickExact(cdp, `the Settings section "${title}"`, "button.cl-settings__section", title);
  await sleep(500);
}

/** Chooses the sidebar entry `title` (a page's app button, or a bot's row), leaving any dialog first. */
export async function openSidebarEntry(ctx: ExampleCtx, title: string): Promise<void> {
  await escape(ctx.cdp);
  await clickExact(ctx.cdp, `the sidebar's ${title} entry`, SIDEBAR_ITEMS, title);
  await sleep(500);
}

/** Waits until the window's document has stopped loading again for newly installed layers: the count of its reload lines
 *  in the app's log the same for `quietMs`. */
export async function reloadsSettled(ctx: ExampleCtx, quietMs = 5_000, ms = 90_000): Promise<number> {
  const count = () => (ctx.appLog().match(/layers: \S+ loads again to frame a layer installed after it was served/g) ?? []).length;
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
