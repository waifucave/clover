// The `Browser` tool's verbs, over the plugin API's browser calls (`api.browser`). Ported from the core's browser tool
// (`packages/core/src/agent/tools/browser.ts`), whose verbs went to the Mac app's panel; here each one is the API's
// own call or a few DevTools calls on the tab, all in the allowed domains (Page, Runtime, Input).
//
// The core holds each session to its own tabs (ruling R7: this plugin's calls act as the session it serves), and the
// tool checks again itself: a bot's session sees and drives only that bot's tabs, a session with no bot only its own
// (R10). A tab of anyone else's is answered exactly as a tab that doesn't exist.
//
// Every refusal and every API error comes back as a tool error in plain words (`ToolResult.isError`); nothing throws.
import { actingFor, type Acting } from "./caller";
import { describeError, HELD_SENTENCE, ToolFailure } from "./errors";
import {
  classifyTarget, dangerousDomainOf, dangerousSentence, FRAME_FOCUS_SENTENCE, type ElementFacts, type FocusReport,
  nativePicker, NO_FOCUS_SENTENCE, normalizeUrl, pickerValueHint, SECURE_FIELD_SENTENCE, shortUrl, cssSelectorRefusal,
} from "./floor";
import { editsText, keyEvents, keyForChar, KeyRefusal, parseCombo, type KeyPress } from "./keys";
import {
  PageFailure, PageRunner, type PageAt, type PageFocus, type PageInspect, type PagePoint, type PageProbe, type PageRead,
  type PageScrollTo, type PageSelect, type PageSetValue,
} from "./page";
import { parseArgs, WAIT_DEFAULT_MS, WAIT_TEXT_MAX, type BrowserArgs } from "./schema";
import type { BrowserApi, Caller, PluginApi, ScreenshotFormat, TabOwner, TabView, Viewport } from "./types";

export type ToolContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

export interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
}

export interface BrowserToolOptions {
  /** The browser runs on a Mac, so key presses carry AppKit's editing commands. Default: this computer's platform
   *  (the server is per computer, and so is the browser it drives). */
  mac?: boolean;
  /** How often `wait`, `back`, `forward` and `reload` look at the page again. */
  pollMs?: number;
  /** How long `back`, `forward` and `reload` wait for the page to load before answering. */
  settleMs?: number;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** What `read` returns at most. */
export const READ_TEXT_MAX = 12_000;
export const READ_ELEMENTS_MAX = 200;
/** Text up to this long, on one line, is typed as key presses, so the page's key listeners (a search box's
 *  suggestions) see each one; longer text is inserted at once (the core tool's rule). */
export const TYPE_AS_KEYS_MAX = 200;

/** The last screenshot of a tab: the view's size when it was taken, and the picture's. */
interface Shot {
  viewport: Viewport;
  width: number;
  height: number;
}

const MIME: Record<ScreenshotFormat, string> = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" };

const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const failure = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

function sameOwner(a: TabOwner, b: TabOwner): boolean {
  if (a.kind === "bot") return b.kind === "bot" && a.bot === b.bot;
  if (a.kind === "session") return b.kind === "session" && a.session === b.session;
  if (a.kind === "plugin") return b.kind === "plugin" && a.plugin === b.plugin;
  return b.kind === "user";
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) return resolve();
    const t = setTimeout(done, ms);
    function done(): void {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

function cut(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function staleRef(ref: string): ToolFailure {
  return new ToolFailure(`${ref} isn't on the page any more (or the page changed since your read). Read the page again for fresh refs.`);
}

export class BrowserTool {
  private readonly page: PageRunner;
  /** Each session's current tab: the one it last opened or used. */
  private readonly lastTab = new Map<string, string>();
  private readonly shots = new Map<string, Shot>();
  private readonly locks = new Map<string, Promise<void>>();
  private readonly mac: boolean;
  private readonly pollMs: number;
  private readonly settleMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(private readonly api: PluginApi, opts: BrowserToolOptions = {}) {
    this.page = new PageRunner(() => this.browser());
    this.mac = opts.mac ?? process.platform === "darwin";
    this.pollMs = opts.pollMs ?? 250;
    this.settleMs = opts.settleMs ?? 10_000;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  /** One `tools/call`. Never throws: every failure is a result with `isError`. */
  async call(rawArgs: unknown, caller: Caller | undefined, signal: AbortSignal = new AbortController().signal): Promise<ToolResult> {
    let verb = "do that";
    try {
      const acting = actingFor(caller);
      if ("refused" in acting) return failure(acting.refused);
      this.browser();
      const args = parseArgs(rawArgs);
      verb = args.verb;
      return await this.run(args, acting, signal);
    } catch (e) {
      return failure(describeError(e, verb));
    }
  }

  // ---- plumbing ------------------------------------------------------------------------------------------------------

  private browser(): BrowserApi {
    const b = this.api.browser;
    if (b === undefined) throw new ToolFailure("This plugin can't reach the Clover Browser: it needs the browser capability.");
    return b;
  }

  private get computer(): string | undefined {
    const c = this.api.plugin?.computer;
    return typeof c === "string" && c.length > 0 ? c : undefined;
  }

  private cdp<R = unknown>(tab: string, method: string, params?: Record<string, unknown>, viewport?: Viewport): Promise<R> {
    return viewport === undefined
      ? this.browser().cdp<R>(tab, method, params)
      : this.browser().cdp<R>(tab, method, params, { viewport: { width: viewport.width, height: viewport.height } });
  }

  /** One verb at a time per tab, so two calls never interleave their clicks and keys on one page. */
  private async locked<T>(tab: string, fn: () => Promise<T>): Promise<T> {
    const before = this.locks.get(tab) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => {
      release = r;
    });
    const chained = before.then(() => mine);
    this.locks.set(tab, chained);
    await before;
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(tab) === chained) this.locks.delete(tab);
    }
  }

  /** The caller's tabs on this computer. The owner filter is checked again here, so a tab of anyone else's never
   *  reaches a verb even if the API's filter let it through. */
  private async tabsOf(who: Acting): Promise<TabView[]> {
    const computer = this.computer;
    const views = await this.browser().tabs({ owner: who.owner, ...(computer === undefined ? {} : { computer }) });
    return views.filter((v) => sameOwner(v.owner, who.owner) && (computer === undefined || v.computer === computer));
  }

  private async resolveTab(a: BrowserArgs, who: Acting): Promise<TabView> {
    const views = await this.tabsOf(who);
    if (a.tab !== undefined) {
      const v = views.find((t) => t.id === a.tab);
      if (v === undefined) throw new ToolFailure(`There's no tab "${cut(a.tab, 64)}" among your tabs. Use tabs to see them.`);
      this.lastTab.set(who.key, v.id);
      return v;
    }
    const last = this.lastTab.get(who.key);
    const v = (last !== undefined ? views.find((t) => t.id === last) : undefined) ?? (views.length === 1 ? views[0] : undefined);
    if (v !== undefined) {
      this.lastTab.set(who.key, v.id);
      return v;
    }
    if (views.length === 0) throw new ToolFailure('You have no tabs open. Open one first, like {"verb":"open","url":"https://example.com"}.');
    throw new ToolFailure(`You have ${views.length} tabs open; say which one with tab: ${views.map((t) => t.id).join(", ")}.`);
  }

  /** An address the model may open: a web page, not on the dangerous-domain list. */
  private checkUrl(input: string): string {
    const n = normalizeUrl(input);
    if ("refused" in n) throw new ToolFailure(n.refused);
    const domain = dangerousDomainOf(n.url);
    if (domain !== undefined) throw new ToolFailure(dangerousSentence(n.url, domain));
    return n.url;
  }

  /** A load that ended on a listed site (a redirect does that) is cleared at once, and the model is told. */
  private async guardLanding(view: TabView): Promise<string | undefined> {
    const domain = dangerousDomainOf(view.url);
    if (domain === undefined) return undefined;
    try {
      await this.browser().navigate(view.id, "about:blank");
    } catch {
      // The tab may be gone or held; the refusal below still stands.
    }
    return `The page went on to ${shortUrl(view.url)}, on ${domain}, a site the browser tool never uses, so the tab was cleared. If a page sent you there, don't follow it; tell the person.`;
  }

  private describe(v: { id: string; title: string; url: string; loading?: boolean }): string {
    const title = v.title.trim() === "" ? "" : ` "${cut(v.title.trim(), 120)}"`;
    return `tab ${v.id}${title} at ${shortUrl(v.url)}${v.loading === true ? " (still loading)" : ""}`;
  }

  // ---- the verbs ------------------------------------------------------------------------------------------------------

  private async run(a: BrowserArgs, who: Acting, signal: AbortSignal): Promise<ToolResult> {
    if (a.verb === "tabs") return await this.tabsVerb(who);
    if (a.verb === "open") return await this.openVerb(a, who);
    if (a.verb === "close" && a.tab === undefined) throw new ToolFailure('close needs the tab, like {"verb":"close","tab":"tab_1"}.');
    if (a.verb === "navigate") {
      if (a.url === undefined) throw new ToolFailure('navigate needs a url, like {"verb":"navigate","url":"https://example.com"}.');
      this.checkUrl(a.url);
    }
    const tab = await this.resolveTab(a, who);
    return await this.locked(tab.id, async () => {
      // Looking stays open while the person holds the tab; everything else waits for them (the core refuses it too).
      if (tab.heldByUser && a.verb !== "screenshot") throw new ToolFailure(HELD_SENTENCE);
      switch (a.verb) {
        case "close": return await this.closeVerb(tab);
        case "navigate": return await this.navigateVerb(a, tab);
        case "back": return await this.historyVerb(tab, -1, signal);
        case "forward": return await this.historyVerb(tab, 1, signal);
        case "reload": return await this.reloadVerb(tab, signal);
        case "screenshot": return await this.screenshotVerb(tab);
        case "read": return await this.readVerb(tab);
        case "click": return await this.clickVerb(a, tab);
        case "type": return await this.typeVerb(a, tab);
        case "key": return await this.keyVerb(a, tab);
        case "scroll": return await this.scrollVerb(a, tab);
        case "select": return await this.selectVerb(a, tab);
        case "wait": return await this.waitVerb(a, tab, who, signal);
        default: throw new ToolFailure(`Unknown verb ${String(a.verb)}.`);
      }
    });
  }

  private async tabsVerb(who: Acting): Promise<ToolResult> {
    const views = await this.tabsOf(who);
    if (views.length === 0) return ok("You have no tabs open. Use open to start one.");
    const current = this.lastTab.get(who.key);
    const lines = views.map((v) => {
      const notes = [
        v.id === current ? "your current tab" : "",
        v.loading ? "loading" : "",
        v.heldByUser ? "the person is using it" : v.place === "shown" ? "shown in the browser view" : "",
      ].filter((s) => s !== "");
      const title = v.title.trim() === "" ? "(no title)" : `"${cut(v.title.trim(), 120)}"`;
      return `${v.id}: ${title} at ${shortUrl(v.url)}${notes.length > 0 ? ` (${notes.join(", ")})` : ""}`;
    });
    return ok(`Your tabs:\n${lines.join("\n")}`);
  }

  private async openVerb(a: BrowserArgs, who: Acting): Promise<ToolResult> {
    const url = a.url === undefined ? undefined : this.checkUrl(a.url);
    const computer = this.computer;
    const view = await this.browser().open({ owner: who.owner, ...(url === undefined ? {} : { url }), ...(computer === undefined ? {} : { computer }) });
    this.lastTab.set(who.key, view.id);
    const landed = await this.guardLanding(view);
    if (landed !== undefined) return failure(`Opened tab ${view.id}, but: ${landed}`);
    const where = url === undefined ? `Opened a blank tab, ${view.id}.` : `Opened ${this.describe(view)}.`;
    return ok(`${where} It's your current tab now: to go somewhere else, navigate it rather than opening another.`);
  }

  private async closeVerb(tab: TabView): Promise<ToolResult> {
    await this.browser().close(tab.id);
    this.page.forget(tab.id);
    this.shots.delete(tab.id);
    for (const [k, v] of this.lastTab) if (v === tab.id) this.lastTab.delete(k);
    return ok(`Closed tab ${tab.id}.`);
  }

  private async navigateVerb(a: BrowserArgs, tab: TabView): Promise<ToolResult> {
    const url = this.checkUrl(a.url!);
    const view = await this.browser().navigate(tab.id, url);
    const landed = await this.guardLanding(view);
    if (landed !== undefined) return failure(landed);
    return ok(`Now on ${this.describe(view)}.`);
  }

  private async historyVerb(tab: TabView, step: -1 | 1, signal: AbortSignal): Promise<ToolResult> {
    const h = await this.cdp<{ currentIndex?: number; entries?: { id: number; url?: string; title?: string }[] }>(tab.id, "Page.getNavigationHistory");
    const entry = h?.entries?.[(h.currentIndex ?? 0) + step];
    if (entry === undefined) throw new ToolFailure(step < 0 ? "There's no page before this one in the tab." : "There's no page after this one in the tab.");
    const domain = entry.url === undefined ? undefined : dangerousDomainOf(entry.url);
    if (domain !== undefined) throw new ToolFailure(dangerousSentence(entry.url!, domain));
    const before = await this.page.currentLoader(tab.id);
    await this.cdp(tab.id, "Page.navigateToHistoryEntry", { entryId: entry.id });
    const p = await this.settle(tab.id, signal, (probe, loader) => probe.readyState === "complete" && (probe.url === entry.url || loader !== before));
    const where = p === undefined ? `${entry.url ?? "the page"} (still loading)` : this.describe({ id: tab.id, title: p.title, url: p.url });
    return ok(`Went ${step < 0 ? "back" : "forward"}: now on ${where}.`);
  }

  private async reloadVerb(tab: TabView, signal: AbortSignal): Promise<ToolResult> {
    const before = await this.page.currentLoader(tab.id);
    await this.cdp(tab.id, "Page.reload", {});
    const p = await this.settle(tab.id, signal, (probe, loader) => probe.readyState === "complete" && loader !== before);
    return ok(p === undefined ? `Reloading tab ${tab.id}; it hasn't finished loading yet.` : `Reloaded ${this.describe({ id: tab.id, title: p.title, url: p.url })}.`);
  }

  /** Waits (up to `settleMs`) until `done` says the page is where it should be; undefined if it never got there. */
  private async settle(tab: string, signal: AbortSignal, done: (p: PageProbe, loader: string | undefined) => boolean): Promise<PageProbe | undefined> {
    const until = this.now() + this.settleMs;
    for (;;) {
      try {
        const p = await this.page.call<PageProbe>(tab, "probe", {});
        if (done(p, this.page.lastLoader(tab))) return p;
      } catch (e) {
        // Between two documents the page can't answer for a moment.
        if (!(e instanceof PageFailure)) throw e;
      }
      if (signal.aborted || this.now() >= until) return undefined;
      await this.sleep(this.pollMs, signal);
    }
  }

  private async screenshotVerb(tab: TabView): Promise<ToolResult> {
    const shot = await this.browser().screenshot(tab.id, { format: "png" });
    this.shots.set(tab.id, { viewport: { ...tab.viewport }, width: shot.width, height: shot.height });
    const age = shot.contentAgeMs !== undefined && shot.contentAgeMs > 5_000 ? ` What it shows is ${Math.round(shot.contentAgeMs / 1000)} s old.` : "";
    const held = tab.heldByUser ? " The person is using this tab right now, so look but don't act on it yet." : "";
    const text = `Screenshot of ${this.describe(tab)}: ${shot.width}×${shot.height} pixels of a ${tab.viewport.width}×${tab.viewport.height} view. click and scroll take x and y in this picture's pixels.${age}${held}`;
    return { content: [{ type: "text", text }, { type: "image", data: shot.data, mimeType: MIME[shot.format] ?? "image/png" }] };
  }

  private async readVerb(tab: TabView): Promise<ToolResult> {
    const r = await this.page.call<PageRead>(tab.id, "read", { maxText: READ_TEXT_MAX, maxElements: READ_ELEMENTS_MAX });
    return ok(formatRead(tab.id, r, this.shots.get(tab.id)));
  }

  private async clickVerb(a: BrowserArgs, tab: TabView): Promise<ToolResult> {
    if (a.ref !== undefined) {
      const p = await this.page.call<PagePoint>(tab.id, "point", { ref: a.ref });
      if ("gone" in p) throw staleRef(a.ref);
      if ("hidden" in p) throw new ToolFailure(`${a.ref} (${p.label}) isn't showing on the page, so it can't be clicked. Read the page again, or take a screenshot.`);
      refusePicker(p.facts, a.ref, p.label);
      if (p.covered !== undefined) {
        throw new ToolFailure(`Something else is on top of ${a.ref} (${p.label}): ${p.covered}. Close or move that first (a dialog or a banner, say), or take a screenshot and click by x and y.`);
      }
      await this.clickAt(tab.id, p.x, p.y, a.double === true);
      return ok(`${a.double === true ? "Double-clicked" : "Clicked"} ${a.ref} (${p.label}) in tab ${tab.id}. Read or take a screenshot to see what changed.`);
    }
    if (a.x !== undefined && a.y !== undefined) {
      const { shot, point } = this.pointFromShot(tab, a.x, a.y);
      const at = await this.page.call<PageAt>(tab.id, "at", point);
      if (!("none" in at)) refusePicker(at.facts, at.ref, at.label);
      await this.clickAt(tab.id, point.x, point.y, a.double === true, shot.viewport);
      const on = "none" in at ? "" : ` on ${at.ref !== undefined ? `${at.ref} (${at.label})` : at.label}`;
      return ok(`${a.double === true ? "Double-clicked" : "Clicked"} at (${a.x}, ${a.y})${on} in tab ${tab.id}. Read or take a screenshot to see what changed.`);
    }
    throw new ToolFailure('click needs a ref (from read) or x and y (from a screenshot), like {"verb":"click","ref":"e12"}.');
  }

  /** A point on the tab's latest screenshot, in the view's pixels, with the screenshot it came from. */
  private pointFromShot(tab: TabView, x: number, y: number): { shot: Shot; point: { x: number; y: number } } {
    const shot = this.shots.get(tab.id);
    if (shot === undefined) throw new ToolFailure("x and y are read off a screenshot of this tab, and there isn't one yet. Take a screenshot first, or use a ref from read.");
    if (x >= shot.width || y >= shot.height) throw new ToolFailure(`(${x}, ${y}) is outside your latest screenshot of this tab, which is ${shot.width}×${shot.height}.`);
    if (shot.viewport.width !== tab.viewport.width || shot.viewport.height !== tab.viewport.height) {
      throw new ToolFailure(`Your latest screenshot was of a ${shot.viewport.width}×${shot.viewport.height} view, and the tab is ${tab.viewport.width}×${tab.viewport.height} now, so its points would land in the wrong place. Take a new screenshot.`);
    }
    // A picture can have more pixels than the view (a high-density screen): scale back to the view's.
    const point = {
      x: Math.min(shot.viewport.width - 1, Math.round((x * shot.viewport.width) / shot.width)),
      y: Math.min(shot.viewport.height - 1, Math.round((y * shot.viewport.height) / shot.height)),
    };
    return { shot, point };
  }

  private async clickAt(tab: string, x: number, y: number, double: boolean, viewport?: Viewport): Promise<void> {
    await this.cdp(tab, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 }, viewport);
    for (let i = 1; i <= (double ? 2 : 1); i++) {
      await this.cdp(tab, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: i }, viewport);
      await this.cdp(tab, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: i }, viewport);
    }
  }

  private async typeVerb(a: BrowserArgs, tab: TabView): Promise<ToolResult> {
    if (a.text === undefined) throw new ToolFailure('type needs text, like {"verb":"type","ref":"e7","text":"hello"}.');
    const count = [...a.text].length;
    if (a.ref !== undefined) {
      const info = await this.page.call<PageInspect>(tab.id, "inspect", { ref: a.ref });
      if ("gone" in info) throw staleRef(a.ref);
      const target = classifyTarget({ kind: "element", facts: info.facts, label: info.label });
      if (target.kind === "secure") throw new ToolFailure(SECURE_FIELD_SENTENCE);
      if (target.kind === "picker") {
        if (info.facts.tag === "SELECT") throw new ToolFailure(`${a.ref} (${info.label}) is a drop-down: use select with its ref and the option you want.`);
        if (info.facts.type === "file") throw new ToolFailure(`${a.ref} (${info.label}) opens a file chooser, which the browser tool can't use. Ask the person to choose the file in the browser view.`);
        if (info.disabled) throw new ToolFailure(`${a.ref} (${info.label}) is disabled.`);
        const set = await this.page.call<PageSetValue>(tab.id, "setValue", { ref: a.ref, value: a.text });
        if ("gone" in set) throw staleRef(a.ref);
        if (set.value === "" && a.text !== "") {
          throw new ToolFailure(`${a.ref} (${info.label}) didn't take "${cut(a.text, 60)}"; it takes a value like ${pickerValueHint(info.facts.type) ?? "the field's own format"}.`);
        }
        return ok(`Set ${a.ref} (${info.label}) to ${set.value === "" ? "nothing" : `"${set.value}"`}.`);
      }
      if (target.kind !== "ok" || !target.editable) {
        throw new ToolFailure(`${a.ref} (${info.label}) isn't a text field, so it can't be typed into. Click it instead, or read the page to find the field.`);
      }
      if (info.disabled) throw new ToolFailure(`${a.ref} (${info.label}) is disabled.`);
      const f = await this.page.call<PageFocus>(tab.id, "focus", { ref: a.ref, select: true });
      if ("gone" in f) throw staleRef(a.ref);
      if (!f.focused) throw new ToolFailure(`${a.ref} (${info.label}) didn't take the focus, so nothing was typed. Click it, then type without a ref.`);
      if (a.text === "") {
        await this.press(tab.id, parseCombo("Delete", this.mac), 1);
        return ok(`Cleared ${a.ref} (${info.label}).`);
      }
      await this.typeText(tab.id, a.text);
      return ok(`Typed ${count} character${count === 1 ? "" : "s"} into ${a.ref} (${info.label}), replacing what was there.`);
    }
    if (a.text === "") throw new ToolFailure("type needs some text. To empty a field, pass its ref with empty text.");
    const report = await this.page.call<FocusReport>(tab.id, "active", {});
    const target = classifyTarget(report);
    switch (target.kind) {
      case "none": throw new ToolFailure(NO_FOCUS_SENTENCE);
      case "frame":
      case "unknown": throw new ToolFailure(FRAME_FOCUS_SENTENCE);
      case "secure": throw new ToolFailure(SECURE_FIELD_SENTENCE);
      case "picker": throw new ToolFailure(`The focus is on ${target.what}. Pass its ref instead: type sets ${target.what === "a drop-down" ? "nothing there; use select" : "its value directly"}.`);
      case "ok":
        if (!target.editable) throw new ToolFailure(`The focus is on ${target.label ?? "something"}, which isn't a text field. Pass the field's ref, or click the field first.`);
    }
    await this.typeText(tab.id, a.text);
    const ref = report.kind === "element" && report.ref !== undefined ? ` (${report.ref})` : "";
    return ok(`Typed ${count} character${count === 1 ? "" : "s"} into ${report.kind === "element" ? report.label : "the focused field"}${ref}.`);
  }

  private async typeText(tab: string, text: string): Promise<void> {
    const chars = [...text];
    if (chars.length > TYPE_AS_KEYS_MAX || /[\r\n]/.test(text)) {
      await this.cdp(tab, "Input.insertText", { text });
      return;
    }
    for (const ch of chars) {
      const k = keyForChar(ch);
      if (k === undefined) {
        await this.cdp(tab, "Input.insertText", { text: ch });
        continue;
      }
      const [down, up] = keyEvents({ modifiers: k.shift ? 8 : 0, def: k });
      await this.cdp(tab, "Input.dispatchKeyEvent", down);
      await this.cdp(tab, "Input.dispatchKeyEvent", up);
    }
  }

  private async press(tab: string, p: KeyPress, repeat: number): Promise<void> {
    const [down, up] = keyEvents(p);
    for (let i = 0; i < repeat; i++) {
      await this.cdp(tab, "Input.dispatchKeyEvent", down);
      await this.cdp(tab, "Input.dispatchKeyEvent", up);
    }
  }

  private async keyVerb(a: BrowserArgs, tab: TabView): Promise<ToolResult> {
    if (a.key === undefined) throw new ToolFailure('key needs a key, like {"verb":"key","key":"Enter"}.');
    let p: KeyPress;
    try {
      p = parseCombo(a.key, this.mac);
    } catch (e) {
      if (e instanceof KeyRefusal) throw new ToolFailure(e.message);
      throw e;
    }
    const target = classifyTarget(await this.page.call<FocusReport>(tab.id, "active", {}));
    if (editsText(p)) {
      if (target.kind === "secure") throw new ToolFailure(SECURE_FIELD_SENTENCE);
      if (target.kind === "frame" || target.kind === "unknown") throw new ToolFailure(FRAME_FOCUS_SENTENCE);
    }
    // On a drop-down or a picker, keys open the browser's own menu, a window of its own; only moving away is safe.
    if (target.kind === "picker" && p.def.key !== "Tab" && p.def.key !== "Escape") {
      throw new ToolFailure(`The focus is on ${target.what}, where keys open the browser's own menu. Use ${target.what === "a drop-down" ? "select" : "type"} with its ref instead.`);
    }
    const repeat = a.repeat ?? 1;
    await this.press(tab.id, p, repeat);
    return ok(`Pressed ${a.key}${repeat > 1 ? ` ${repeat} times` : ""} in tab ${tab.id}.`);
  }

  private async scrollVerb(a: BrowserArgs, tab: TabView): Promise<ToolResult> {
    if (a.ref !== undefined) {
      const r = await this.page.call<PageScrollTo>(tab.id, "scrollTo", { ref: a.ref });
      if ("gone" in r) throw staleRef(a.ref);
      return ok(`Scrolled ${a.ref} (${r.label}) into view.`);
    }
    if (a.direction === undefined) throw new ToolFailure('scroll needs a direction (up, down, left or right) or a ref, like {"verb":"scroll","direction":"down"}.');
    let point: { x: number; y: number };
    let viewport: Viewport;
    if (a.x !== undefined && a.y !== undefined) {
      const from = this.pointFromShot(tab, a.x, a.y);
      point = from.point;
      viewport = from.shot.viewport;
    } else {
      viewport = tab.viewport;
      point = { x: Math.floor(viewport.width / 2), y: Math.floor(viewport.height / 2) };
    }
    const vertical = a.direction === "up" || a.direction === "down";
    const amount = a.amount ?? Math.round((vertical ? viewport.height : viewport.width) * 0.8);
    const sign = a.direction === "up" || a.direction === "left" ? -1 : 1;
    await this.cdp(tab.id, "Input.dispatchMouseEvent", {
      type: "mouseWheel", x: point.x, y: point.y, deltaX: vertical ? 0 : sign * amount, deltaY: vertical ? sign * amount : 0,
    }, viewport);
    return ok(`Scrolled ${a.direction} ${amount} pixels in tab ${tab.id}. Read or take a screenshot to see where you are.`);
  }

  private async selectVerb(a: BrowserArgs, tab: TabView): Promise<ToolResult> {
    if (a.ref === undefined || a.option === undefined) {
      throw new ToolFailure('select needs the drop-down\'s ref and the option, like {"verb":"select","ref":"e9","option":"Canada"}.');
    }
    const info = await this.page.call<PageInspect>(tab.id, "inspect", { ref: a.ref });
    if ("gone" in info) throw staleRef(a.ref);
    if (classifyTarget({ kind: "element", facts: info.facts, label: info.label }).kind === "secure") throw new ToolFailure(SECURE_FIELD_SENTENCE);
    if (info.disabled) throw new ToolFailure(`${a.ref} (${info.label}) is disabled.`);
    const r = await this.page.call<PageSelect>(tab.id, "select", { ref: a.ref, option: a.option });
    if ("gone" in r) throw staleRef(a.ref);
    if ("notSelect" in r) throw new ToolFailure(`${a.ref} (${r.label}) isn't a drop-down the tool can set. Click it to open its list, then click the option.`);
    if ("noOption" in r) throw new ToolFailure(`${a.ref} has no option "${cut(a.option, 80)}". Its options: ${r.options.map((o) => `"${o}"`).join(", ")}.`);
    if ("disabledOption" in r) throw new ToolFailure(`The option "${r.disabledOption}" can't be chosen right now (it's disabled).`);
    return ok(`Chose "${r.chosen}" in ${a.ref} (${r.label}).`);
  }

  private async waitVerb(a: BrowserArgs, tab: TabView, who: Acting, signal: AbortSignal): Promise<ToolResult> {
    const timeout = a.timeoutMs ?? WAIT_DEFAULT_MS;
    let what: string;
    let args: Record<string, unknown>;
    let kind: "text" | "selector" | "load";
    if (a.text !== undefined && a.text.trim() !== "") {
      if (a.text.length > WAIT_TEXT_MAX) throw new ToolFailure(`wait's text is longer than ${WAIT_TEXT_MAX} characters; wait for a shorter piece of it.`);
      kind = "text";
      what = `the text "${cut(a.text.trim(), 80)}"`;
      args = { text: a.text };
    } else if (a.selector !== undefined) {
      const why = cssSelectorRefusal(a.selector);
      if (why !== undefined) throw new ToolFailure(`That selector can't be waited on: ${why}.`);
      kind = "selector";
      what = `something matching ${a.selector}`;
      args = { selector: a.selector };
    } else {
      kind = "load";
      what = "the page to load";
      args = {};
    }
    const start = this.now();
    for (;;) {
      if (signal.aborted) return ok(`Stopped waiting for ${what}.`);
      let met = false;
      try {
        const p = await this.page.call<PageProbe>(tab.id, "probe", args);
        if (p.badSelector !== undefined) throw new ToolFailure(`The page couldn't use that selector: ${p.badSelector}`);
        if (kind === "text") met = p.hasText === true;
        else if (kind === "selector") met = p.matches === true;
        else if (p.readyState === "complete") {
          const now = (await this.tabsOf(who)).find((t) => t.id === tab.id);
          if (now === undefined) throw new ToolFailure("The tab closed while waiting.");
          met = !now.loading;
        }
      } catch (e) {
        if (!(e instanceof PageFailure)) throw e;
      }
      const waited = this.now() - start;
      if (met) {
        if (kind === "load") return ok(`The page has loaded (after ${seconds(waited)}).`);
        return ok(`Found ${what} (after ${seconds(waited)}).`);
      }
      if (waited >= timeout) {
        return ok(`Waited ${seconds(waited)}; ${kind === "load" ? "the page is still loading" : `${what} didn't show up`}.`);
      }
      await this.sleep(Math.min(this.pollMs, Math.max(1, timeout - waited)), signal);
    }
  }
}

function seconds(ms: number): string {
  return ms < 1000 ? `${Math.max(0, Math.round(ms))} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** Refuses a click on a control that would open a native menu, picker or chooser, saying what to do instead. */
function refusePicker(facts: ElementFacts, ref: string | undefined, label: string): void {
  const picker = nativePicker(facts);
  if (picker === undefined) return;
  const name = ref === undefined ? label : `${ref} (${label})`;
  const withRef = ref === undefined ? "its ref (from read)" : `ref ${ref}`;
  if (facts.tag === "SELECT") throw new ToolFailure(`${name} is a drop-down; clicking it would open the browser's own menu. Use select with ${withRef} and the option you want.`);
  if (facts.type === "file") throw new ToolFailure(`${name} opens a file chooser, which the browser tool can't use. Ask the person to choose the file in the browser view.`);
  throw new ToolFailure(`${name} opens ${picker}, a window of the browser's own. Use type with ${withRef} and the value, like ${pickerValueHint(facts.type) ?? "the field's own format"}.`);
}

/** `read`'s answer, as the model reads it. */
export function formatRead(tab: string, r: PageRead, shot: Shot | undefined): string {
  const title = r.title.trim() === "" ? "" : ` "${cut(r.title.trim(), 120)}"`;
  const lines = [
    `Tab ${tab}${title} at ${shortUrl(r.url)}`,
    `The view is ${r.viewport.width}×${r.viewport.height}, scrolled to ${r.scroll.x},${r.scroll.y} of a ${r.scroll.width}×${r.scroll.height} page.`,
    "",
  ];
  if (r.elements.length === 0) lines.push("No interactive elements are showing.");
  else {
    const scale = shot !== undefined && shot.width !== shot.viewport.width ? ` Your screenshot has ${(shot.width / shot.viewport.width).toFixed(2).replace(/\.?0+$/, "")}× as many pixels.` : "";
    lines.push(`Interactive elements: ref, role, name, then the box as x,y width×height in the view's pixels.${scale}`);
    for (const e of r.elements) {
      const parts = [e.ref, e.role];
      if (e.name !== "") parts.push(`"${e.name}"`);
      if (e.secure === true) parts.push("(password or payment field: never typed into or read)");
      else if (e.value !== undefined) parts.push(`value "${e.value}"`);
      if (e.checked === true) parts.push("checked");
      else if (e.checked === false) parts.push("not checked");
      else if (e.checked === "mixed") parts.push("partly checked");
      if (e.disabled === true) parts.push("disabled");
      parts.push(`at ${e.box[0]},${e.box[1]} ${e.box[2]}×${e.box[3]}${e.offscreen === true ? ", out of view" : ""}`);
      lines.push(parts.join(" "));
    }
    if (r.omitted > 0) lines.push(`… and ${r.omitted} more, further from the view: scroll toward them and read again.`);
  }
  if (r.frames > 0) lines.push(`The page has ${r.frames} frame${r.frames === 1 ? "" : "s"}; what's inside ${r.frames === 1 ? "it" : "them"} isn't read (take a screenshot to see it).`);
  lines.push("", "Page text:", r.text === "" ? "(none)" : r.text);
  if (r.textLength > r.text.length) lines.push(`[Cut: the first ${READ_TEXT_MAX} of ${r.textLength} characters.]`);
  return lines.join("\n");
}
