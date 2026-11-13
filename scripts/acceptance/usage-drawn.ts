// Row 4.19's drawing: the usage plugin's island tab and its Settings section, read as drawn on the real app (offscreen).
// What a turn counted shows as "Today … N tokens" with a Clover row; an empty section says "No usage yet" or "Nothing used today".
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
      const v = await cdp.evaluate(d.session, `(() => { const t = document.body ? document.body.innerText : ''; return /Group by/.test(t) && /Period/.test(t) && /Plans/.test(t) && !/Reading usage/.test(t) ? t : null; })()`).catch(() => null);
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
export async function islandUsageText(cdp: Cdp): Promise<string> {
  const here = async () => (await cdp.documents()).filter((d) => d.url.startsWith("clover-plugin://clover/island") || d.url.startsWith("clover-plugin://clover/usage"));
  await clickIn(cdp, "the island's Usage tab dot", '[role=tab][aria-label="Usage"]', undefined, 20_000).catch(async (err: unknown) => {
    const seen: string[] = [];
    for (const d of await here()) seen.push(`${d.url.slice(0, 60)}: ${String(await cdp.evaluate(d.session, "document.body ? document.body.innerText.replace(/\\s+/g, ' ').slice(0, 120) : ''").catch(() => "")).slice(0, 120)}`);
    throw new Error(`${(err as Error).message} (the island's documents: ${seen.join(" | ") || "none"})`);
  });
  return until("the Usage tab's drawn text", 20_000, async () => {
    for (const d of await here()) {
      const v = await cdp.evaluate(d.session, `(() => { const b = document.querySelector('[role=tabpanel][aria-label="Usage"]'); return b ? b.innerText : null; })()`).catch(() => null);
      if (typeof v === "string" && v.trim() !== "") return v;
    }
    return undefined;
  });
}
