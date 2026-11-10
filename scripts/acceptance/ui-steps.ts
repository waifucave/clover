// The acceptance run's UI steps: what a person does in the window, driven over the Chrome DevTools protocol against the
// headless, offscreen app (cdp.ts): type in the composer and send, read the bot's reply in the conversation, pick a
// model, open Settings, change a setting and see it stay, and drag the window by its title area. Each step reads the
// real DOM of the real layer frames and the daemon's own state; none of them calls the core's methods for the app.
// The inputs are trusted input events (`Input.dispatchKeyEvent`/`dispatchMouseEvent`), which the main process sees
// as the person's key presses and clicks: if one doesn't register with the send gate, it is this driver that is wrong,
// never the gate.
import { randomBytes } from "node:crypto";
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
  "the Dispatch pill sends: a message typed in the pill goes to its bot, and the bot's reply is shown",
  "a send that is refused says so by the composer, and the draft stays",
  "Alpha's tab is drawn by Alpha's own layout (its talk column)",
] as const;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
class Failed extends Error {}
const fail = (m: string): never => { throw new Failed(m); };

interface Ctx {
  cdp: Cdp; rpc: CloverClient; reply: string; /** What the fake model provider has been asked, in order. */ requests(): { model?: string; lastUserText: string }[]; /** The app's own log file, <home>/logs/app.log, as text. */ appLog(): string;
  /** What the Settings step set, as the daemon keeps it (the upgrade's first half records it). */
  onSetting?(key: string, value: unknown): void;
}

/** The clover layer's documents (the shell, the sidebar and every part of the bundled tree share one). */
export async function treeDocs(cdp: Cdp): Promise<{ session: string; url: string; text: string }[]> {
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

/** The composer's own document: the one that holds `.cl-composer` with its text box (the Dispatch pill has a text box too, so
 *  "the first text box" can be the pill's, depending on the order the frames attached). On a miss, what each tree document
 *  holds is dumped so the failure names the frame and buttons it saw. */
const COMPOSER_BOX = ".cl-composer textarea";
export async function composerDoc(cdp: Cdp): Promise<{ session: string; value: true } | undefined> {
  return inTree<boolean>(cdp, `!!document.querySelector('${COMPOSER_BOX}')`) as Promise<{ session: string; value: true } | undefined>;
}
/** The shell is drawing: its sidebar's title row is in a tree document (no bot or session needed, unlike the composer). */
export async function shellDoc(cdp: Cdp): Promise<{ session: string; value: boolean } | undefined> {
  return inTree<boolean>(cdp, "!!document.querySelector('.cl-sidebar__top')");
}
export async function dumpFrames(cdp: Cdp): Promise<string> {
  const out: string[] = [];
  for (const d of await treeDocs(cdp)) {
    const seen = await cdp.evaluate(d.session, "JSON.stringify({ composer: !!document.querySelector('.cl-composer'), boxes: document.querySelectorAll('textarea').length, buttons: [...document.querySelectorAll('button')].slice(0, 12).map((b) => b.getAttribute('aria-label') || (b.innerText || '').trim().slice(0, 20)) })").catch(() => "gone");
    out.push(`${d.url.slice(0, 60)} ${String(seen).slice(0, 300)}`);
  }
  return out.join(" || ");
}

async function until<T>(what: string, ms: number, probe: () => Promise<T | undefined>, dump?: () => Promise<string>): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await probe();
    if (v !== undefined) return v;
    if (Date.now() > end) fail(`${what}: not within ${Math.round(ms / 1000)} s${dump === undefined ? "" : ` (frames: ${await dump().catch(() => "?")})`}`);
    await sleep(400);
  }
}

/** Text on screen of any tree document. */
export async function treeText(cdp: Cdp): Promise<string> {
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
  const shellUp = await until("the shell to draw its composer", 90_000, () => composerDoc(cdp), () => dumpFrames(cdp)).catch((e: Error) => e);
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
    // The line is the window's own position before and after (win.getPosition), so this is its bounds, moved by the drag.
    const m = /from \((-?\d+), (-?\d+)\) to \((-?\d+), (-?\d+)\)/.exec(line!);
    if (m === null) fail(`the app's log of the move is unreadable: ${line}`);
    const dx = Number(m![3]) - Number(m![1]), dy = Number(m![4]) - Number(m![2]);
    if (Math.abs(dx - 120) > 4 || Math.abs(dy - 60) > 4) fail(`the window moved by (${dx}, ${dy}), not the (120, 60) the cursor moved`);
    return `a drag of (120, 60) on the title row moved the window by (${dx}, ${dy}): ${line!.replace(/^\S+ /, "")}`;
  });

  // 1: send. A tag of this turn's own: the fake provider's reply carries it, so a reply from an earlier turn (step 3's) can't
  // pass, and the reply bubbles on screen are counted before and after.
  await step(1, async () => {
    const tag = `ACCEPTANCE-TAG-${randomBytes(4).toString("hex").toUpperCase()}`;
    const replies = async () => ((await treeText(cdp)).match(/ACCEPTANCE-REPLY-OK/g) ?? []).length;
    const box = await until("the composer's text box", 20_000, () => composerDoc(cdp), () => dumpFrames(cdp));
    const s = box.session;
    const before = await replies();
    await cdp.evaluate(s, `(() => { const t = document.querySelector('${COMPOSER_BOX}'); t.focus(); return true; })()`);
    await cdp.send("Input.insertText", { text: `${tag} say hello from the window` }, s);
    await sleep(300);
    const typed = await cdp.evaluate(s, `document.querySelector('${COMPOSER_BOX}').value`);
    if (!String(typed).includes(tag)) fail(`the text box shows "${String(typed).slice(0, 60)}" after typing`);
    // The send button, pressed as a person would.
    const btn = await cdp.centerOf(s, "button.cl-composer__send");
    if (btn === undefined) fail(`the composer has no Send button (frames: ${await dumpFrames(cdp)})`);
    await cdp.click(s, btn!.x, btn!.y);
    await until("this turn's own reply on screen", 150_000, async () => ((await treeText(cdp)).includes(`${ctx.reply} ${tag}`) ? true : undefined), () => dumpFrames(cdp));
    const after = await replies();
    if (after !== before + 1) fail(`the reply bubbles went from ${before} to ${after}, not by one`);
    const left = await cdp.evaluate(s, `document.querySelector('${COMPOSER_BOX}') ? document.querySelector('${COMPOSER_BOX}').value : ''`);
    if (String(left).length > 0) fail(`the draft is still in the text box after the send ("${String(left).slice(0, 40)}")`);
    return `the message ${tag} was sent from the composer and its own reply is on screen (reply bubbles ${before} -> ${after})`;
  });

  // 2: the model picker.
  await step(2, async () => {
    const pill = await until("the model pill", 20_000, async () => {
      for (const d of await treeDocs(cdp)) {
        const c = await cdp.centerOf(d.session, ".cl-composer button[aria-label^=\"Model:\"]").catch(() => undefined);
        if (c !== undefined) return { session: d.session, c };
      }
      return undefined;
    }, () => dumpFrames(cdp));
    const before = await rpc.request<{ bots: { id: string; model?: string }[] }>("bot.list", {});
    const was = before.bots[0]?.model;
    await cdp.click(pill.session, pill.c.x, pill.c.y);
    const items = await until("the picker's models", 15_000, async () => {
      const r = await cdp.evaluate(pill.session, "JSON.stringify([...document.querySelectorAll('[role=menuitemradio]')].map((e) => ({ t: (e.innerText || '').trim(), c: e.getAttribute('aria-checked') })))");
      const list = JSON.parse(String(r)) as { t: string; c: string }[];
      return list.length > 0 ? list : undefined;
    }, async () => `pill: ${String(await cdp.evaluate(pill.session, "(() => { const b = document.querySelector('.cl-composer button[aria-label^=Model]'); return b ? 'expanded=' + b.getAttribute('aria-expanded') + ' menus=' + document.querySelectorAll('[role=menu]').length + ' radios=' + document.querySelectorAll('[role=menuitemradio]').length + ' items=' + document.querySelectorAll('[role=menuitem]').length + ' text=' + [...document.querySelectorAll('[role=menu]')].map((e) => e.innerText.slice(0, 80)).join('|') : 'gone'; })()").catch(() => "gone"))}`);
    if (items.length < 2) fail(`the picker lists ${items.length} model(s): ${items.map((i) => i.t).join(", ")}`);
    // Only the signed-in provider's models are listed first: the run's one stored key is Anthropic's.
    if (items.length > 100) fail(`the picker lists ${items.length} models up front: every provider's, signed in or not`);
    const other = items.findIndex((i) => i.c !== "true");
    // The menu scrolls inside its own box (the catalog is more than a thousand models): bring the row into view as a person would.
    const pick = await cdp.evaluate(pill.session, `(() => { const e = [...document.querySelectorAll('[role=menuitemradio]')][${other}]; e.scrollIntoView({ block: "center" }); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`) as { x: number; y: number };
    const room = await cdp.evaluate(pill.session, "innerHeight") as number;
    if (pick.y < 0 || pick.y > room) fail(`the picker's row can't be brought on screen (y ${Math.round(pick.y)} of ${room}): the menu doesn't scroll`);
    await cdp.click(pill.session, pick.x, pick.y);
    const now = await until("the bot's model to change", 15_000, async () => {
      const m = (await rpc.request<{ bots: { model?: string }[] }>("bot.list", {})).bots[0]?.model;
      return m !== undefined && m !== was ? m : undefined;
    });
    if (!now.startsWith("anthropic/")) fail(`the pick landed on ${now}, a provider with no key stored (the run's only key is Anthropic's)`);
    // The label says it at once, and the NEXT turn runs on the picked model (the fake provider's own request says which).
    const picked = items[other]!.t.split("\n")[0]!;
    const label = await until("the composer's label to say the pick", 10_000, async () => {
      const l = String(await cdp.evaluate(pill.session, "(document.querySelector('.cl-composer button[aria-label^=\"Model:\"]') || {}).ariaLabel || ''"));
      return l.includes(picked) ? l : undefined;
    }, async () => `label now: ${String(await cdp.evaluate(pill.session, "(document.querySelector('.cl-composer button[aria-label^=\"Model:\"]') || {}).ariaLabel || 'gone'").catch(() => "gone"))}; picked "${picked}"`);
    const tag = `MODEL-TAG-${randomBytes(4).toString("hex").toUpperCase()}`;
    const box = await until("the composer's text box", 20_000, () => composerDoc(cdp), () => dumpFrames(cdp));
    await cdp.evaluate(box.session, `document.querySelector('${COMPOSER_BOX}').focus()`);
    await cdp.send("Input.insertText", { text: `${tag} which model` }, box.session);
    await sleep(300);
    const send = await until("the send button", 10_000, () => cdp.centerOf(box.session, "button.cl-composer__send").catch(() => undefined));
    await cdp.click(box.session, send.x, send.y);
    const req = await until("the model request of this turn", 60_000, async () => ctx.requests().find((r) => r.lastUserText.includes(tag)));
    const wire = now.slice(now.indexOf("/") + 1);
    if (req.model !== wire) fail(`the pick (${now}) was not what the next turn ran on: the provider was asked for ${String(req.model)}`);
    return `${items.length} models listed; picked "${picked}": the bot's model went from ${was} to ${now}; the label reads "${label}" and the next turn's request asked the provider for ${req.model}`;
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
    ctx.onSetting?.("notifications.needsYou", kept);
    // Leave Settings (the first sidebar item) and open it again.
    await settingsOpen();
    await section();
    const again = await readSwitch();
    if (again.on !== flipped.on) fail(`after opening Settings again the switch shows ${again.on}, not ${flipped.on}`);
    return `"When a bot needs you" went ${first.on} -> ${flipped.on}, the daemon keeps it, and it is ${again.on} after Settings is opened again`;
  });
  // 5: the Dispatch pill's own send, apart from the composer's. The pill is its own window with its own text box and its
  // own Send circle; a person types there and presses the circle. The same fake reply, with this turn's own tag.
  await step(5, async () => {
    const tag = `ACCEPTANCE-TAG-${randomBytes(4).toString("hex").toUpperCase()}`;
    const PILL_BOX = "textarea.clp-input";
    const replies = async () => ((await treeText(cdp)).match(/ACCEPTANCE-REPLY-OK/g) ?? []).length;
    const box = await until("the pill's text box", 30_000, () => inTree<boolean>(cdp, `!!document.querySelector('${PILL_BOX}')`), () => dumpFrames(cdp));
    const s = box.session;
    const before = await replies();
    await cdp.evaluate(s, `(() => { const t = document.querySelector('${PILL_BOX}'); t.focus(); return true; })()`);
    await cdp.send("Input.insertText", { text: `${tag} say hello from the pill` }, s);
    await sleep(400);
    const typed = await cdp.evaluate(s, `document.querySelector('${PILL_BOX}').value`);
    if (!String(typed).includes(tag)) fail(`the pill's text box shows "${String(typed).slice(0, 60)}" after typing`);
    // The pill grows as the first words are typed (a spring), and the Send circle moves with it: it is pressed where it has
    // come to rest, as a person waits for it.
    let btn = await until("the pill's Send circle", 10_000, async () => cdp.centerOf(s, "button.clp-circle[data-role=send]").catch(() => undefined), () => dumpFrames(cdp));
    for (let i = 0; i < 20; i++) {
      await sleep(300);
      const now = await cdp.centerOf(s, "button.clp-circle[data-role=send]").catch(() => undefined);
      if (now !== undefined && Math.abs(now.x - btn.x) < 0.5 && Math.abs(now.y - btn.y) < 0.5) { btn = now; break; }
      if (now !== undefined) btn = now;
    }
    // The pill's window is sized by the pill itself as it grows: until it is wide enough, the circle's point is outside the page
    // and a press there reaches nothing. Pressed once the point holds the circle.
    const holdsCircle = async (): Promise<string> => String(await cdp.evaluate(s, `(() => { const c = document.querySelector("button.clp-circle[data-role=send]"); if (!c) return "no circle"; const r = c.getBoundingClientRect(); const e = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return e && c.contains(e) ? "circle" : (e ? e.tagName : "outside the page (" + innerWidth + "x" + innerHeight + ")"); })()`).catch(() => "?"));
    let under = await holdsCircle();
    // A pill's window is resized by the pill as it grows, which waits for an animation frame; a hidden (headless) window has
    // none, so it stays at its resting size and the circle lies outside it. The page is given room to lay the circle in (the
    // press then lands on it, in the frame, as a person's would).
    if (under !== "circle") {
      const widen = { width: 720, height: 160, deviceScaleFactor: 1, mobile: false };
      // The pill's document may be a frame of the surface's own page (the command runs only on a top-level target).
      await cdp.send("Emulation.setDeviceMetricsOverride", widen, s).catch(async () => {
        const top = (await cdp.documents()).find((d) => d.url.includes("surface=pill"));
        if (top === undefined) fail("the pill's window has no page of its own to give room");
        await cdp.send("Emulation.setDeviceMetricsOverride", widen, top!.session);
      });
      await sleep(500);
      for (let i = 0; i < 20 && under !== "circle"; i++) {
        under = await holdsCircle();
        const now = await cdp.centerOf(s, "button.clp-circle[data-role=send]").catch(() => undefined);
        if (now !== undefined) btn = now;
        if (under !== "circle") await sleep(300);
      }
    }
    if (under !== "circle") fail(`the pill's Send circle (${btn.x}, ${btn.y}) never came to a point of the page: it holds ${under}`);
    const route = "the Send circle";
    const consoleFrom = cdp.console.length;
    await cdp.click(s, btn.x, btn.y);
    const sent = () => cdp.console.slice(consoleFrom).filter((e) => e.level === "exception" || e.level === "error" || e.level === "warning").map((e) => e.text.slice(0, 160)).join(" | ");
    await until("this turn's own reply on screen, from the pill's message", 40_000, async () => ((await treeText(cdp)).includes(`${ctx.reply} ${tag}`) ? true : undefined), async () => `${(await dumpFrames(cdp)).slice(0, 120)}; pill box now "${String(await cdp.evaluate(s, `document.querySelector('${PILL_BOX}').value`).catch(() => "?")).slice(0, 50)}"; console: ${sent()}; click at ${btn.x},${btn.y} over ${String(under)}`);
    const after = await replies();
    if (after !== before + 1) fail(`the reply bubbles went from ${before} to ${after}, not by one`);
    return `the pill sent ${tag} by ${route} and its own reply is on screen (reply bubbles ${before} -> ${after})`;
  });
  // 6: a refused send is not silent. A click the page makes itself (no key press or click of a person's behind it) is refused:
  // the composer keeps the draft and says so in a few words.
  await step(6, async () => {
    const box = await until("the composer's text box", 20_000, () => composerDoc(cdp), () => dumpFrames(cdp));
    const s = box.session;
    // The frame's own activation from the earlier steps has run out.
    await until("the composer frame to have no user activation", 15_000, async () => ((await cdp.evaluate(s, "navigator.userActivation.isActive")) === false ? true : undefined));
    const words = "ACCEPTANCE-REFUSED-DRAFT";
    await cdp.evaluate(s, `(() => { const t = document.querySelector('${COMPOSER_BOX}'); t.focus(); return true; })()`);
    await cdp.send("Input.insertText", { text: words }, s);
    await sleep(300);
    // Pressed by the page, not by a person.
    await cdp.evaluate(s, "document.querySelector('button.cl-composer__send').click()");
    const notice = await until("the composer's notice", 10_000, async () => {
      const t = await cdp.evaluate(s, "(document.querySelector('.cl-composer [data-notice=send]') || {}).textContent || ''");
      return String(t) !== "" ? String(t) : undefined;
    }, () => dumpFrames(cdp));
    const kept = String(await cdp.evaluate(s, `document.querySelector('${COMPOSER_BOX}').value`));
    if (!kept.includes(words)) fail(`the draft is "${kept.slice(0, 40)}" after the refused send, not kept`);
    // Typing again takes the notice away; the draft is cleared so nothing is left to be sent by mistake.
    await cdp.send("Input.insertText", { text: "!" }, s);
    await sleep(300);
    const gone = String(await cdp.evaluate(s, "(document.querySelector('.cl-composer [data-notice=send]') || {}).textContent || ''"));
    if (gone !== "") fail(`the notice stays after typing ("${gone.slice(0, 40)}")`);
    await cdp.evaluate(s, `(() => { const t = document.querySelector('${COMPOSER_BOX}'); t.select(); return true; })()`);
    await cdp.send("Input.insertText", { text: "" }, s);
    return `a send the page made by itself was refused; the composer said "${notice.slice(0, 80)}", kept the draft, and the notice went on typing`;
  });
  // 7: the bot's own tab layout. Alpha ships tab/layout.json (a `.alpha-talk` column holding the conversation and the composer);
  // the daemon's plugin view says it as `bot: { layout }`, and the app draws the tab from it.
  await step(7, async () => {
    const talk = await until("Alpha's own talk column", 20_000, () => inTree<boolean>(cdp, "!!document.querySelector('[class*=\"alpha-talk\"]')"), () => dumpFrames(cdp));
    const inside = await cdp.evaluate(talk.session, "!!document.querySelector('[class*=\"alpha-talk\"] .cl-composer')");
    if (inside !== true) fail("Alpha's talk column holds no composer");
    // The composer stays on screen under a conversation that has grown (the layout fills the window; the composer keeps its height).
    const box = await cdp.evaluate(talk.session, "(() => { const r = document.querySelector('[class*=\"alpha-talk\"] .cl-composer').getBoundingClientRect(); return { bottom: Math.round(r.bottom), room: innerHeight, h: Math.round(r.height) }; })()") as { bottom: number; room: number; h: number };
    if (box.bottom > box.room || box.h < 40) fail(`Alpha's composer is off screen or squashed: bottom ${box.bottom} of ${box.room}, ${box.h} high`);
    return "Alpha's talk column is drawn, with the composer in it, on screen";
  });
}
