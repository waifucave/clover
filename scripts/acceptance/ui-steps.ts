// The acceptance run's UI steps: what a person does in the window, driven over the Chrome DevTools protocol against the
// headless, offscreen app (cdp.ts): type in the composer and send, read the bot's reply in the conversation, pick a
// model, open Settings, change a setting and see it stay, and drag the window by its title area. Each step reads the
// real DOM of the real layer frames and the daemon's own state; none of them calls the core's methods for the app.
// The inputs are trusted input events (`Input.dispatchKeyEvent`/`dispatchMouseEvent`), which the main process sees
// as the person's key presses and clicks: if one doesn't register with the send gate, it is this driver that is wrong,
// never the gate.
import type { Cdp } from "./cdp";
import type { CloverClient } from "./client";

export type UiStatus = "PASS" | "FAIL" | "BLOCKED";
export interface UiRow { name: string; status: UiStatus; detail: string }

export const UI_STEPS = [
  "the window drags by its title area",
  "a message typed in the composer is sent, and the bot's reply is shown",
  "the model picker lists models and a pick takes",
  "Settings opens with no part stopped",
  "a setting changed in Settings is still there when it is opened again",
] as const;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
class Failed extends Error {}
const fail = (m: string): never => { throw new Failed(m); };

interface Ctx { cdp: Cdp; rpc: CloverClient; reply: string; /** The app's own log file, <home>/logs/app.log, as text. */ appLog(): string }

/** The clover layer's documents (the shell, the sidebar and every part of the bundled tree share one). */
async function treeDocs(cdp: Cdp): Promise<{ session: string; url: string; text: string }[]> {
  return (await cdp.documents()).filter((d) => d.url.startsWith("clover-plugin://clover/"));
}

async function inTree<T>(cdp: Cdp, expr: string): Promise<{ session: string; value: T } | undefined> {
  for (const d of await treeDocs(cdp)) {
    try {
      const value = (await cdp.evaluate(d.session, expr)) as T;
      if (value !== null && value !== undefined && value !== false) return { session: d.session, value };
    } catch { /* a frame that is going */ }
  }
  return undefined;
}

async function until<T>(what: string, ms: number, probe: () => Promise<T | undefined>): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await probe();
    if (v !== undefined) return v;
    if (Date.now() > end) fail(`${what}: not within ${Math.round(ms / 1000)} s`);
    await sleep(400);
  }
}

/** Text on screen of any tree document. */
async function treeText(cdp: Cdp): Promise<string> {
  return (await Promise.all((await treeDocs(cdp)).map((d) => cdp.evaluate(d.session, "document.body ? document.body.innerText : ''").catch(() => "")))).join("\n");
}

const STOPPED = "This part stopped.";
const stoppedAnywhere = async (cdp: Cdp): Promise<boolean> => (await Promise.all((await cdp.documents()).map((d) => cdp.evaluate(d.session, "document.body ? document.body.innerText : ''").catch(() => "")))).some((t) => String(t).includes(STOPPED));

export async function uiSteps(ctx: Ctx, record: (index: number, status: UiStatus, detail: string) => void): Promise<void> {
  const { cdp, rpc } = ctx;
  const step = async (n: number, run: () => Promise<string>) => {
    try { record(n, "PASS", await run()); } catch (err) { record(n, err instanceof Failed ? "FAIL" : "FAIL", err instanceof Error ? err.message : String(err)); }
  };

  // The shell is up when the composer is.
  const shellUp = await until("the shell to draw its composer", 90_000, () => inTree<boolean>(cdp, "!!document.querySelector('textarea')").then((r) => r ?? undefined)).catch((e: Error) => e);
  if (shellUp instanceof Error) {
    for (let n = 0; n < UI_STEPS.length; n++) record(n, "BLOCKED", `the window never drew its composer (${shellUp.message})`);
    return;
  }

  // 0: drag. A real press in the sidebar's top row (a title area: its CSS says `-webkit-app-region: drag`), a move and a
  // release, as the frame sees them. The window is offscreen, so its place isn't read from the page: the app's own log
  // (<home>/logs/app.log) says where the window went, from the position the window itself reports.
  await step(0, async () => {
    const side = await until("the sidebar's title row", 20_000, () => inTree<boolean>(cdp, "!!document.querySelector('.cl-sidebar__top')"));
    const area = await cdp.evaluate(side.session, "getComputedStyle(document.querySelector('.cl-sidebar__top')).getPropertyValue('-webkit-app-region')");
    if (area !== "drag") fail(`the sidebar's title row declares no drag region (${String(area)})`);
    const moved = () => ctx.appLog().split("\n").filter((l) => l.includes("window: moved by its title area"));
    const was = moved().length;
    const at = { x: 160, y: 20 };
    const press = (type: string, x: number, y: number, buttons: number) => cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons, clickCount: 1 }, side.session);
    await press("mouseMoved", at.x, at.y, 0);
    await press("mousePressed", at.x, at.y, 1);
    for (let i = 1; i <= 6; i++) { await press("mouseMoved", at.x + i * 20, at.y + i * 10, 1); await sleep(40); }
    await press("mouseReleased", at.x + 120, at.y + 60, 0);
    const line = await until("the app's log of the window's move", 8_000, async () => (moved().length > was ? moved()[moved().length - 1] : undefined)).catch(() => undefined);
    if (line === undefined) fail(`dragging the title row (${at.x},${at.y}) by (120, 60) moved the window nowhere: the app logged no move`);
    return `a drag of (120, 60) on the title row: ${line!.replace(/^\S+ /, "")}`;
  });

  // 1: send.
  await step(1, async () => {
    const box = await until("the composer's text box", 20_000, () => inTree<boolean>(cdp, "!!document.querySelector('textarea')"));
    const s = box.session;
    await cdp.evaluate(s, "(() => { const t = document.querySelector('textarea'); t.focus(); return true; })()");
    await cdp.send("Input.insertText", { text: `ACCEPTANCE-REPLY: say hello from the window` }, s);
    await sleep(300);
    const typed = await cdp.evaluate(s, "document.querySelector('textarea').value");
    if (!String(typed).includes("say hello from the window")) fail(`the text box shows "${String(typed).slice(0, 60)}" after typing`);
    // The send button, pressed as a person would.
    const btn = await cdp.centerOf(s, "button[aria-label=Send]");
    if (btn === undefined) fail("the composer has no Send button");
    await cdp.click(s, btn!.x, btn!.y);
    await until("the bot's reply on screen", 150_000, async () => ((await treeText(cdp)).includes(ctx.reply) ? true : undefined));
    const left = await cdp.evaluate(s, "document.querySelector('textarea') ? document.querySelector('textarea').value : ''");
    if (String(left).length > 0) fail(`the draft is still in the text box after the send ("${String(left).slice(0, 40)}")`);
    return `the message was sent from the composer and "${ctx.reply}" is on screen`;
  });

  // 2: the model picker.
  await step(2, async () => {
    const pill = await until("the model pill", 20_000, async () => {
      for (const d of await treeDocs(cdp)) {
        const c = await cdp.centerOf(d.session, "button[aria-label^=\"Model:\"]").catch(() => undefined);
        if (c !== undefined) return { session: d.session, c };
      }
      return undefined;
    });
    const before = await rpc.request<{ bots: { id: string; model?: string }[] }>("bot.list", {});
    const was = before.bots[0]?.model;
    await cdp.click(pill.session, pill.c.x, pill.c.y);
    const items = await until("the picker's models", 15_000, async () => {
      const r = await cdp.evaluate(pill.session, "JSON.stringify([...document.querySelectorAll('[role=menuitemradio]')].map((e) => ({ t: (e.innerText || '').trim(), c: e.getAttribute('aria-checked') })))");
      const list = JSON.parse(String(r)) as { t: string; c: string }[];
      return list.length > 0 ? list : undefined;
    });
    if (items.length < 2) fail(`the picker lists ${items.length} model(s): ${items.map((i) => i.t).join(", ")}`);
    const other = items.findIndex((i) => i.c !== "true");
    const pick = await cdp.evaluate(pill.session, `(() => { const e = [...document.querySelectorAll('[role=menuitemradio]')][${other}]; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`) as { x: number; y: number };
    await cdp.click(pill.session, pick.x, pick.y);
    const now = await until("the bot's model to change", 15_000, async () => {
      const m = (await rpc.request<{ bots: { model?: string }[] }>("bot.list", {})).bots[0]?.model;
      return m !== undefined && m !== was ? m : undefined;
    });
    return `${items.length} models listed; picked "${items[other]!.t.split("\n")[0]}": the bot's model went from ${was} to ${now}`;
  });

  // 3: Settings opens.
  const settingsOpen = async (): Promise<{ session: string }> => {
    const before = cdp.console.length;
    const button = await until("the Settings button", 20_000, async () => {
      for (const d of await treeDocs(cdp)) {
        const c = await cdp.centerOf(d.session, "button[aria-label=Settings]").catch(() => undefined);
        if (c !== undefined) return { session: d.session, c };
      }
      return undefined;
    });
    await cdp.click(button.session, button.c.x, button.c.y);
    const page = await until("the Settings page", 20_000, async () => {
      for (const d of await treeDocs(cdp)) {
        const has = await cdp.evaluate(d.session, "document.body.innerText.includes('Notifications') && document.body.innerText.includes('Appearance')").catch(() => false);
        if (has === true) return { session: d.session };
      }
      return undefined;
    });
    await sleep(800);
    if (await stoppedAnywhere(cdp)) fail(`"${STOPPED}" is on screen after opening Settings (${cdp.console.slice(before).filter((e) => e.level === "exception").map((e) => e.text.slice(0, 160)).join(" | ") || "no exception logged"})`);
    return page;
  };
  await step(3, async () => {
    const page = await settingsOpen();
    void page;
    return "Settings drew its sections and no part shows \"This part stopped.\"";
  });

  // 4: a setting sticks.
  await step(4, async () => {
    const readSwitch = async (): Promise<{ session: string; on: boolean }> => {
      const s = await until("the notifications switches", 20_000, async () => {
        for (const d of await treeDocs(cdp)) {
          const r = await cdp.evaluate(d.session, "(() => { const el = [...document.querySelectorAll('[role=switch]')].find((e) => (e.getAttribute('aria-label') || '').includes('needs you')); return el ? el.getAttribute('aria-checked') : null; })()").catch(() => null);
          if (r !== null && r !== undefined) return { session: d.session, on: r === "true" };
        }
        return undefined;
      });
      return s;
    };
    // The Notifications section.
    const section = async (): Promise<void> => {
      const nav = await until("the Notifications entry", 20_000, async () => {
        for (const d of await treeDocs(cdp)) {
          const c = await cdp.centerOf(d.session, "button, a, [role=tab], [role=link]", "Notifications").catch(() => undefined);
          if (c !== undefined) return { session: d.session, c };
        }
        return undefined;
      });
      await cdp.click(nav.session, nav.c.x, nav.c.y);
    };
    await section();
    const first = await readSwitch();
    const sw = await cdp.centerOf(first.session, "[role=switch]", "needs you");
    if (sw === undefined) fail("no \"needs you\" switch in Notifications");
    await cdp.click(first.session, sw!.x, sw!.y);
    await sleep(1_500);
    const flipped = await readSwitch();
    if (flipped.on === first.on) fail(`the switch didn't flip (still ${first.on})`);
    // The daemon has it.
    const stored = await rpc.request<{ settings: { key: string; value?: unknown }[] }>("plugin.settings.get", { id: "clover/settings" });
    const kept = stored.settings.find((s) => s.key === "notifications.needsYou")?.value;
    if (kept !== flipped.on) fail(`the daemon keeps notifications.needsYou = ${String(kept)}, the switch shows ${flipped.on}`);
    // Leave Settings (the first sidebar item) and open it again.
    await settingsOpen();
    await section();
    const again = await readSwitch();
    if (again.on !== flipped.on) fail(`after opening Settings again the switch shows ${again.on}, not ${flipped.on}`);
    return `"When a bot needs you" went ${first.on} -> ${flipped.on}, the daemon keeps it, and it is ${again.on} after Settings is opened again`;
  });
}
