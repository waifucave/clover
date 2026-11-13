// Row 4.19's drawing: the usage plugin's island tab and its Settings section, read as drawn on the real app (offscreen).
// What a turn counted shows as "Today … N tokens" with a Clover row; an empty section says "No usage yet" or "Nothing used today".
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Cdp } from "./cdp";

/** What is wrong with a drawn usage view's text, or undefined when it shows a day's tokens under Clover. */
export function usageDrawnProblem(text: string): string | undefined {
  if (/Nothing used today|No usage yet/.test(text)) return `it says it has no usage: ${JSON.stringify(text.replace(/\s+/g, " ").slice(0, 160))}`;
  if (!/Today/.test(text)) return `it has no Today group: ${JSON.stringify(text.replace(/\s+/g, " ").slice(0, 160))}`;
  if (!/Clover/.test(text)) return `it has no Clover row: ${JSON.stringify(text.replace(/\s+/g, " ").slice(0, 160))}`;
  if (!/\d[\d.,]*[kKmM]? tokens/.test(text)) return `it shows no token count: ${JSON.stringify(text.replace(/\s+/g, " ").slice(0, 160))}`;
  return undefined;
}

/** The same for the Settings section's own vocabulary (a period, a total "N in · M out", a table by source): no Today group. */
export function settingsDrawnProblem(text: string): string | undefined {
  const flat = JSON.stringify(text.replace(/\s+/g, " ").slice(0, 200));
  if (/No usage yet/.test(text)) return `it says it has no usage: ${flat}`;
  if (!/Clover/.test(text)) return `it has no Clover row: ${flat}`;
  if (!/\d[\d.,]*[kKmM]? in · \d[\d.,]*[kKmM]? out/.test(text)) return `it shows no "N in · M out" total: ${flat}`;
  return undefined;
}

const treeDocs = async (cdp: Cdp) => (await cdp.documents()).filter((d) => d.url.startsWith("clover-plugin://clover/") || d.url.startsWith("clover-plugin://alpha"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(what: string, ms: number, probe: () => Promise<T | undefined>, hint?: () => Promise<string>): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await probe().catch(() => undefined);
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error(`${what} didn't show within ${ms} ms${hint === undefined ? "" : `: ${await hint().catch(() => "")}`}`);
    await sleep(300);
  }
}

async function clickIn(cdp: Cdp, what: string, selector: string, text: string | undefined, ms = 20_000): Promise<void> {
  const at = await until(what, ms, async () => {
    for (const d of await treeDocs(cdp)) {
      const c = await cdp.centerOf(d.session, selector, text).catch(() => undefined);
      if (c !== undefined) return { session: d.session, c };
    }
    return undefined;
  });
  await cdp.click(at.session, at.c.x, at.c.y);
}

/** The Settings window's Usage section, opened the user's way (the sidebar's gear, then the section), and its drawn text. */
export async function settingsUsageText(cdp: Cdp): Promise<string> {
  await clickIn(cdp, "the Settings button", "button[aria-label=Settings]", undefined);
  await clickIn(cdp, "the Settings window's Usage section", "button.cl-settings__section", "Usage");
  const text = await until("the Usage section's drawn text", 20_000, async () => {
    for (const d of await treeDocs(cdp)) {
      const v = await cdp.evaluate(d.session, `(() => { const t = document.body ? document.body.innerText : ''; return /Plans/.test(t) && /\\d[\\d.,]*[kKmM]? in · \\d[\\d.,]*[kKmM]? out|No usage yet/.test(t) && !/Reading usage/.test(t) ? t : null; })()`).catch(() => null);
      if (typeof v === "string" && v !== "") return v;
    }
    return undefined;
  }, async () => {
    const seen: string[] = [];
    for (const d of await treeDocs(cdp)) seen.push(`${d.url.slice(0, 50)}: ${String(await cdp.evaluate(d.session, "document.body ? document.body.innerText.replace(/\\s+/g, ' ').slice(0, 90) : ''").catch(() => "")).slice(0, 90)}`);
    const dialogs: string[] = [];
    for (const d of await treeDocs(cdp)) {
      const v = await cdp.evaluate(d.session, "(() => { const s = document.querySelector('[class*=cl-settings]'); return s ? s.innerText.replace(/\\s+/g, ' ').slice(0, 500) : null; })()").catch(() => null);
      if (typeof v === "string") dialogs.push(v);
    }
    const errors = cdp.console.filter((c) => /error|warn/i.test(c.level)).slice(-8).map((c) => `${c.level}: ${c.text.replace(/\s+/g, " ").slice(0, 200)}`);
    return `settings text: ${dialogs.join(" || ") || "no settings element"}; console: ${errors.join(" | ") || "none"}; documents: ${seen.join(" | ")}`;
  });
  // Closed again the user's way, so no later step meets the dialog.
  for (const type of ["keyDown", "keyUp"]) for (const d of await treeDocs(cdp)) await cdp.send("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, d.session).catch(() => undefined);
  return text;
}

/** The island's Usage tab, chosen on its tab dots while the island is open (a card is pending), and its drawn text. */
/** A picture of the island's own page, offscreen, in dark and light: `island-<name>-<scheme>.png` in `dir`. The overlay is
 *  transparent, so the capture lays a flat ground under it (the picture's, not the app's). */
export function islandShooter(cdp: Cdp, dir: string, setAppearance?: (scheme: "dark" | "light" | "system") => void): { shoot: (name: string) => Promise<string[]>; done: () => Promise<void> } {
  const ground = { dark: { r: 0x20, g: 0x20, b: 0x20, a: 255 }, light: { r: 0xf5, g: 0xf5, b: 0xf5, a: 255 } } as const;
  const page = async () => (await cdp.documents()).find((d) => /[?&]surface=island/.test(d.url));
  return {
    async shoot(name) {
      const doc = await page();
      if (doc === undefined) return [];
      const out: string[] = [];
      for (const scheme of ["dark", "light"] as const) {
        setAppearance?.(scheme);
        for (const d of await cdp.documents()) await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] }, d.session).catch(() => undefined);
        await cdp.send("Emulation.setDefaultBackgroundColorOverride", { color: ground[scheme] }, doc.session).catch(() => undefined);
        await sleep(1_200);
        const shot = await cdp.send("Page.captureScreenshot", { format: "png" }, doc.session) as { data: string };
        writeFileSync(join(dir, `island-${name}-${scheme}.png`), Buffer.from(shot.data, "base64"));
        out.push(`island-${name}-${scheme}.png`);
      }
      return out;
    },
    async done() {
      setAppearance?.("system");
      const doc = await page();
      if (doc !== undefined) await cdp.send("Emulation.setDefaultBackgroundColorOverride", {}, doc.session).catch(() => undefined);
      for (const d of await cdp.documents()) await cdp.send("Emulation.setEmulatedMedia", { features: [] }, d.session).catch(() => undefined);
    },
  };
}

export async function islandUsageText(cdp: Cdp, shoot?: (name: string) => Promise<unknown>, thirdParty?: { label: string; words: string }): Promise<string> {
  const here = async () => (await cdp.documents()).filter((d) => /[?&]surface=island/.test(d.url) || d.url.startsWith("clover-plugin://clover/"));
  // A card on top rests small; the strip at the top opens the island (its tab dots live there).
  await shoot?.("1-closed-strip");
  await clickIn(cdp, "the island's strip", ".clv-strip[role=button]", undefined, 20_000);
  /** Chooses a tab on the dots by its label, clicking again until it reads as selected (a dot takes a click once the island rests). */
  /** The pointer over the open island (it puts itself away a moment after the pointer leaves, and a click alone doesn't move it);
   *  an island that has put itself away is opened again from its strip. */
  const hold = async (): Promise<void> => {
    for (const d of await here()) {
      const c = await cdp.centerOf(d.session, ".clv-open", undefined).catch(() => undefined);
      if (c !== undefined) { await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: c.x, y: c.y }, d.session).catch(() => undefined); return; }
    }
    await clickIn(cdp, "the island's strip", ".clv-strip[role=button]", undefined, 10_000).catch(() => undefined);
    await sleep(1_200);
  };
  const choose = async (label: string): Promise<void> => {
    const selector = `[role=tab][aria-label=${JSON.stringify(label)}]`;
    for (let attempt = 0; attempt < 5; attempt++) {
      await hold();
      await sleep(600);
      await clickIn(cdp, `the island's ${label} tab dot`, selector, undefined, 20_000).catch(async (err: unknown) => {
        const seen: string[] = [];
        for (const d of await here()) seen.push(String(await cdp.evaluate(d.session, "[...document.querySelectorAll('[role=tab]')].map((x) => x.getAttribute('aria-label') + ':' + x.getAttribute('aria-selected')).join(',') || (document.body ? 'no dots; ' + document.body.innerText.replace(/\\s+/g, ' ').slice(0, 80) : '')").catch(() => "")));
        throw new Error(`${(err as Error).message} (attempt ${attempt + 1}; dots: ${seen.filter((x) => x !== "").join(" | ")})`);
      });
      await sleep(400);
      for (const d of await here()) {
        const v = await cdp.evaluate(d.session, `(() => { const t = document.querySelector(${JSON.stringify(selector)}); return t ? t.getAttribute('aria-selected') === 'true' : null; })()`).catch(() => null);
        if (v === true) return;
      }
    }
    throw new Error(`the ${label} tab dot never read as selected`);
  };
  // The island morphs open first: its dots only take a click once it rests, so the click is repeated until the tab is chosen.
  const chosen = async (): Promise<boolean> => {
    for (const d of await here()) {
      const v = await cdp.evaluate(d.session, `(() => { const t = document.querySelector('[role=tab][aria-label="Usage"]'); return t ? t.getAttribute('aria-selected') === 'true' : null; })()`).catch(() => null);
      if (typeof v === "boolean") return v;
    }
    return false;
  };
  await sleep(1_000);
  await shoot?.("2-open-default");
  await (async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      await sleep(700);
      await clickIn(cdp, "the island's Usage tab dot", '[role=tab][aria-label="Usage"]', undefined, 20_000);
      await sleep(400);
      if (await chosen()) return;
    }
  })().catch(async (err: unknown) => {
    const seen: string[] = [];
    for (const d of await here()) seen.push(`${d.url.slice(0, 60)}: ${String(await cdp.evaluate(d.session, "document.body ? document.body.innerText.replace(/\\s+/g, ' ').slice(0, 300) : ''").catch(() => "")).slice(0, 700)}`);
    throw new Error(`${(err as Error).message} (the island's documents: ${seen.join(" | ") || "none"})`);
  });
  const text = await until("the Usage tab's drawn text", 20_000, async () => {
    for (const d of await here()) {
      // The tab's entry is its own frame inside the panel: the text is read where it is drawn.
      const v = await cdp.evaluate(d.session, `(() => { const t = document.body ? document.body.innerText : ''; return /Today/.test(t) && /Clover/.test(t) && /\\d[\\d.,]*[kKmM]? tokens|No usage yet/.test(t) && !/Waiting to use/.test(t) ? t : null; })()`).catch(() => null);
      if (typeof v === "string" && v.trim() !== "") return v;
    }
    return undefined;
  }).catch(async (err: unknown) => {
    const seen: string[] = [];
    for (const d of await here()) seen.push(`${d.url.slice(0, 50)}: ${String(await cdp.evaluate(d.session, "(() => { const p = document.querySelector('[role=tabpanel]'); const tabs = [...document.querySelectorAll('[role=tab]')].map((x) => x.getAttribute('aria-label') + ':' + x.getAttribute('aria-selected')).join(','); return p ? 'PANEL[' + tabs + '] ' + p.outerHTML.replace(/\\s+/g, ' ').slice(0, 600) : ''; })()").catch(() => "")).slice(0, 700)}`);
    throw new Error(`${(err as Error).message} (documents: ${seen.join(" | ")})`);
  });
  if (shoot !== undefined) {
    await shoot("3-open-usage");
    await choose("Devices");
    await sleep(1_000);
    await shoot("4-open-devices");
  }
  // A third-party plugin's tab, on the same dots (labelled with its plugin's name), drawn by that plugin's own frame.
  if (thirdParty !== undefined) {
    await choose(thirdParty.label);
    await until("the third-party tab's own words", 20_000, async () => {
      // Its own plugin's layer draws it: a document of its own, not the island's or the clover tree's.
      for (const d of (await cdp.documents()).filter((x) => x.url.startsWith("clover-plugin://acceptance-tab/"))) {
        const v = await cdp.evaluate(d.session, "document.body ? document.body.innerText : ''").catch(() => "");
        if (typeof v === "string" && v.includes(thirdParty.words)) return true;
      }
      return undefined;
    }, async () => {
      const seen: string[] = [];
      for (const d of await cdp.documents()) if (/surface=island|clover-plugin:\/\/(acceptance-tab|clover)\//.test(d.url)) seen.push(`${d.url.slice(0, 55)}: ${String(await cdp.evaluate(d.session, "(() => { const p = document.querySelector('[role=tabpanel]'); return p ? 'PANEL ' + p.getAttribute('aria-label') + ' ' + p.innerHTML.replace(/\\s+/g, ' ').slice(0, 260) : (document.body ? document.body.innerText.replace(/\\s+/g, ' ').slice(0, 80) : ''); })()").catch(() => "")).slice(0, 320)}`);
      return seen.join(" | ");
    });
    await shoot?.("5-open-third-party");
  }
  return text;
}
