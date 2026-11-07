// The Clover Browser where no app runs (spec §12.1, "[P] Where no app runs"; plan §4 L, M2): Chrome for Testing's
// headless shell, pinned (`plugins/clover/plugins/browser/headless-shell.pins.json`, with `integrity.json`), installed failing closed (`install.ts`), one process per profile, driven over
// the DevTools pipe. `HeadlessBrowser` is an `AppTabPort`, so the core's `BrowserService` drives it exactly as it
// drives the app's Electron, and it reports back the same way (`changed`, `closed`, `cdp`, `stalled`).
//
// What it holds itself, since the pipe is a browser-level connection (`Target`, `Browser`, `Storage` for every tab):
// * the API's DevTools calls pass the core's allow list again here (`checkCdpMethod`), on the tab's own session only;
// * the URL rule for every request however it starts (a page's link or redirect, a frame, a worker, a DevTools
//   `Page.navigate`): the `Fetch` domain at the browser level pauses every request in every tab of the profile and
//   lets through only what `isBrowserUrlAllowed` allows, never by reading DevTools parameters;
// * the owner's address policy (R13): every profile's traffic goes through the network filter as a fixed proxy, with
//   loopback through it too (`flags.ts`);
// * no permission is granted, downloads are refused, dialogs are answered at once, file choosers never open, and a
//   window a page opens becomes a tab of the same owner.
//
// Differences from the app's tabs, by design: a headless computer has no view, so `place: "shown"` is refused; and
// `resting` only records the place (the shell draws on demand; it has no `stopPainting`). Streams are JPEG frames from
// `Page.startScreencast` (no WebCodecs here).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  AGENT_VIEWPORT, isBrowserUrlAllowed, isCdpMethodAllowed, type AppTabCommand, type AppTabEvent, type Screenshot, type ScreenshotFormat,
  type StreamChunk, type StreamCodec, type TabOwner, type TabPlace, type TabView, type Viewport,
} from "../contract";
import { policyFor as defaultPolicyFor, type AddressPolicy, type NetworkFilter } from "../network";
import { checkProxySetting, proxyRoutes, readSystemProxy, type RunCommand } from "../proxy";
import type { BrowserNetworkConfig } from "../contract";
import { BrowserError, checkCdpMethod, checkViewport, partitionFor } from "../policy";
import type { AppTabPort } from "../service";
import { CdpError, type CdpConnection, type CdpEvent } from "./cdp";
import { browserEnv, headlessArgs, profileDir, profileName, windowsBrowserDirs } from "./flags";
import { imageSize } from "./image";
import { installHeadlessShell, type HeadlessPin } from "./install";
import { launchHeadlessShell, type Launcher } from "./launch";

export interface HeadlessBrowserOptions {
  /** The folder the browser keeps everything in (the daemon's `<home>/browser/`): installs in `cft/`, profiles in
   *  `profiles/`. */
  dir: string;
  /** This computer's name, for the tabs' views. */
  computer: string;
  /** To the core's `BrowserService.report`, batched. */
  report(events: AppTabEvent[]): void;
  /** A stream's chunks (`stream` commands), tagged with the stream's name. */
  streamData?(stream: string, chunk: StreamChunk): void;
  /** The filter every profile's traffic goes through (R13). */
  network: NetworkFilter;
  /** Which addresses an owner's tabs may reach (default: the network filter's `policyFor`, with the bots whose LAN
   *  setting is on from `configure`). */
  policyFor?(owner: TabOwner, lanBots: ReadonlySet<string>): AddressPolicy;
  /** Runs the OS's tools for the system's proxy setting (`proxy.ts`); default `Bun.spawn` (S7's Linux rule). */
  run?: RunCommand;
  /** The pinned build (default `HEADLESS_PIN`, from the pin file). */
  pin?: HeadlessPin;
  /** For the install's download (default: `fetch`). */
  fetch?(url: string): Promise<Response>;
  log?(line: string): void;
  /** For tests: what starts a browser, and what installs (or checks) it before each start. */
  launch?: Launcher;
  install?(): Promise<{ bin: string }>;
  newId?(): string;
  /** How long a profile's browser keeps running once its last tab closed (default 60 s). */
  idleMs?: number;
  /** Each DevTools call's limit (default 15 s; a screenshot's is 10 s). */
  callMs?: number;
}

/** Permissions denied for every origin, on top of the shell's own defaults (it shows no prompt). Names this build
 *  doesn't know are skipped. */
export const DENIED_PERMISSIONS: readonly string[] = [
  "geolocation", "notifications", "midi", "camera", "microphone", "clipboard-read", "clipboard-write", "display-capture",
  "background-sync", "persistent-storage", "idle-detection", "storage-access", "top-level-storage-access",
  "window-management", "local-fonts", "captured-surface-control", "speaker-selection", "keyboard-lock", "pointer-lock",
  "local-network-access", "web-app-installation",
];

/** DevTools calls the port keeps for itself while it streams a tab: a bot's own would stop or steal its frames. */
const STREAM_METHODS = ["Page.startScreencast", "Page.stopScreencast", "Page.screencastFrameAck"];

/** A stream's JPEG quality and how many drawn frames it skips, for a target bitrate. Measured by S7 on a fully animated
 *  1280×800 page: q70 at every frame is 30-67 Mbit/s, and a still page sends next to nothing (frames come only when
 *  something drew), so a budget mostly buys smoothness on moving pages. No budget: q70, every frame. */
export function screencastSettings(kbps: number | undefined): { quality: number; everyNthFrame: number } {
  if (kbps === undefined) return { quality: 70, everyNthFrame: 1 };
  if (kbps >= 8000) return { quality: 80, everyNthFrame: 1 };
  if (kbps >= 4000) return { quality: 70, everyNthFrame: 1 };
  if (kbps >= 2000) return { quality: 60, everyNthFrame: 2 };
  if (kbps >= 1000) return { quality: 50, everyNthFrame: 3 };
  if (kbps >= 500) return { quality: 40, everyNthFrame: 4 };
  return { quality: 30, everyNthFrame: 6 };
}

interface Profile {
  name: string;
  owner: TabOwner;
  /** The proxy rules it was started with. */
  proxy: string;
  conn: CdpConnection;
  tabs: Set<string>;
  /** Targets attached that no `open` has claimed yet. */
  unclaimed: Map<string, Attached>;
  claims: Map<string, (a: Attached) => void>;
  /** `Target.createTarget` calls in flight: a target attached meanwhile may be one of theirs. */
  creating: number;
  idle?: ReturnType<typeof setTimeout>;
  /** Being restarted or shut down on purpose: its going is no crash. */
  leaving: boolean;
}

interface Attached {
  targetId: string;
  sessionId: string;
  url: string;
  title: string;
  openerId?: string;
}

interface Stream {
  name: string;
  kbps?: number;
  last?: Uint8Array;
}

interface Tab {
  id: string;
  owner: TabOwner;
  profile: Profile;
  targetId: string;
  sessionId: string;
  url: string;
  title: string;
  loading: boolean;
  place: TabPlace;
  viewport: Viewport;
  closed: boolean;
  closing: boolean;
  stream?: Stream;
}

const SHOWN_REFUSED = "a headless computer's browser has no view to show a tab in, so a tab here is only ever headless (or resting)";

export class HeadlessBrowser implements AppTabPort {
  private readonly tabs = new Map<string, Tab>();
  private readonly profiles = new Map<string, Profile>();
  private readonly starting = new Map<string, Promise<Profile>>();
  private pending: AppTabEvent[] = [];
  private flushing = false;
  private down = false;
  private readonly callMs: number;

  constructor(private readonly opts: HeadlessBrowserOptions) {
    this.callMs = opts.callMs ?? 15_000;
  }

  // -----------------------------------------------------------------------------------------------
  // AppTabPort
  // -----------------------------------------------------------------------------------------------

  async open(args: { id: string; owner: TabOwner; url?: string; place: TabPlace }): Promise<TabView> {
    if (this.down) throw new Error("the headless browser is shut down");
    if (this.tabs.has(args.id)) throw new Error(`there's already a tab ${args.id}`);
    profileName(args.owner); // refuses a bad owner before anything starts
    if (args.url !== undefined && !isBrowserUrlAllowed(args.url)) throw new Error(`the browser doesn't open ${args.url}`);
    if (args.place === "shown") throw new Error(SHOWN_REFUSED);
    const profile = await this.profile(args.owner);
    if (this.tabs.has(args.id)) throw new Error(`there's already a tab ${args.id}`);
    const tab = await this.newTarget(profile, args.id);
    if (args.url !== undefined) this.navigate(tab, args.url);
    if (args.place === "resting") tab.place = "resting";
    return this.view(tab);
  }

  async command(id: string, command: AppTabCommand): Promise<unknown> {
    const tab = this.tabs.get(id);
    if (tab === undefined || tab.closed) throw new Error(`there's no tab ${id}`);
    switch (command.kind) {
      case "close":
        await this.closeTab(tab);
        return null;
      case "navigate":
        if (!isBrowserUrlAllowed(command.url)) throw new Error(`the browser doesn't open ${command.url}`);
        this.navigate(tab, command.url);
        return null;
      case "place":
        await this.place(tab, command.place, command.viewport);
        return null;
      case "screenshot":
        return this.screenshot(tab, command.format, command.quality);
      case "cdp":
        return this.cdp(tab, command.method, command.params);
      case "stream":
        if (command.on) await this.startStream(tab, command.stream, command.maxKbps, command.codecs);
        else await this.stopStream(tab, command.stream);
        return null;
      case "stream-control":
        await this.controlStream(tab, command.stream, command.keyframe, command.kbps);
        return null;
    }
  }

  async list(): Promise<TabView[]> {
    return [...this.tabs.values()].filter((t) => !t.closed).map((t) => this.view(t));
  }

  // -----------------------------------------------------------------------------------------------
  // For the daemon
  // -----------------------------------------------------------------------------------------------

  /** The owners' address policies may have changed (a per-bot setting, R13): a running profile whose proxy would now
   *  differ is started again with the new one, and its tabs reopen at their addresses (reported as `changed`; a tab
   *  that can't reopen as `closed` by `crash`). Returns the ids reopened. */
  /** `app.browser.configure`'s counterpart (R13's per-bot LAN, R14's proxy): the proxy takes effect for each new
   *  connection at once; a bot whose LAN setting changed has its browser started again on its new policy. A server
   *  has no PAC evaluator, so a system setting that names a PAC file refuses connections rather than go round it. */
  async configure(config: BrowserNetworkConfig): Promise<void> {
    const proxy = checkProxySetting(config.proxy);
    const run = this.opts.run ?? bunRun;
    this.opts.network.setUpstream(proxyRoutes(proxy, {
      readSystem: () => readSystemProxy({ platform: process.platform, run, env: process.env }),
      log: (line) => this.log(line),
    }));
    this.lanBots = new Set(config.lanBots);
    await this.refreshPolicies();
  }

  /** The browsers' own process ids, for the network filter's check of who connects (`peer-owner.ts`, with their
   *  children: the network process is a child of each). */
  browserPids(): number[] {
    return [...this.profiles.values()].filter((p) => !p.conn.closed).flatMap((p) => (p.conn.pid !== undefined ? [p.conn.pid] : []));
  }

  async refreshPolicies(): Promise<string[]> {
    const reopened: string[] = [];
    for (const profile of [...this.profiles.values()]) {
      if (profile.leaving || profile.conn.closed) continue;
      const proxy = await this.opts.network.proxyFor(this.policyFor(profile.owner));
      if (proxy === profile.proxy) continue;
      this.log(`the network policy of ${profile.name} changed: restarting its browser`);
      const tabs = [...profile.tabs].map((id) => this.tabs.get(id)).filter((t): t is Tab => t !== undefined && !t.closed);
      profile.leaving = true;
      for (const tab of tabs) this.endStream(tab, "failed", "the browser restarted with a new network policy");
      this.profiles.delete(profile.name);
      clearTimeout(profile.idle);
      await profile.conn.close();
      let next: Profile | undefined;
      try {
        next = await this.profile(profile.owner);
      } catch (e) {
        this.log(`restarting ${profile.name} failed: ${errorText(e)}`);
      }
      for (const tab of tabs) {
        this.tabs.delete(tab.id);
        if (next === undefined) {
          this.queue({ kind: "closed", id: tab.id, by: "crash" });
          continue;
        }
        try {
          const fresh = await this.newTarget(next, tab.id, { place: tab.place, viewport: tab.viewport });
          if (isBrowserUrlAllowed(tab.url) && tab.url !== "about:blank") this.navigate(fresh, tab.url);
          reopened.push(tab.id);
        } catch (e) {
          this.log(`reopening ${tab.id} failed: ${errorText(e)}`);
          this.queue({ kind: "closed", id: tab.id, by: "crash" });
        }
      }
    }
    return reopened;
  }

  /** Stops every profile's browser. Nothing is reported: the core is going too. */
  async shutdown(): Promise<void> {
    this.down = true;
    for (const tab of this.tabs.values()) {
      this.endStream(tab, "closed");
      tab.closed = true;
    }
    this.tabs.clear();
    const all = [...this.profiles.values()];
    this.profiles.clear();
    await Promise.all(all.map(async (p) => {
      p.leaving = true;
      clearTimeout(p.idle);
      await p.conn.close().catch(() => undefined);
    }));
  }

  // -----------------------------------------------------------------------------------------------
  // Profiles: one browser process each
  // -----------------------------------------------------------------------------------------------

  private lanBots: ReadonlySet<string> = new Set();

  private policyFor(owner: TabOwner): AddressPolicy {
    return this.opts.policyFor?.(owner, this.lanBots) ?? defaultPolicyFor(owner, this.lanBots);
  }

  private async profile(owner: TabOwner): Promise<Profile> {
    const name = profileName(owner);
    const running = this.profiles.get(name);
    if (running !== undefined && !running.conn.closed && !running.leaving) {
      clearTimeout(running.idle);
      running.idle = undefined;
      return running;
    }
    let starting = this.starting.get(name);
    if (starting === undefined) {
      starting = this.start(name, owner).finally(() => this.starting.delete(name));
      this.starting.set(name, starting);
    }
    return starting;
  }

  private async start(name: string, owner: TabOwner): Promise<Profile> {
    // Checked again before every start: no pin, no browser; a changed install is never run (install.ts).
    const { bin } = this.opts.install !== undefined
      ? await this.opts.install()
      : await installHeadlessShell({ dir: this.opts.dir, ...(this.opts.pin ? { pin: this.opts.pin } : {}), ...(this.opts.fetch ? { fetch: this.opts.fetch } : {}), ...(this.opts.log ? { log: this.opts.log } : {}) });
    const proxy = await this.opts.network.proxyFor(this.policyFor(owner));
    const dir = profileDir(this.opts.dir, owner);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    mkdirSync(join(this.opts.dir, "home"), { recursive: true, mode: 0o700 });
    const env = browserEnv(this.opts.dir);
    if (process.platform === "win32") for (const d of windowsBrowserDirs(env)) mkdirSync(d, { recursive: true });
    const conn = await (this.opts.launch ?? launchHeadlessShell)({ bin, args: headlessArgs({ profile: dir, proxy }), env });
    const profile: Profile = { name, owner, proxy, conn, tabs: new Set(), unclaimed: new Map(), claims: new Map(), creating: 0, leaving: false };
    conn.on((e) => this.onEvent(profile, e));
    conn.onClose((why) => this.gone(profile, why));
    try {
      // The URL rule first, before any page exists: every request of every tab, paused and checked.
      await conn.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] }, undefined, this.callMs);
      await conn.send("Browser.setDownloadBehavior", { behavior: "deny" }, undefined, this.callMs);
      for (const permission of DENIED_PERMISSIONS) {
        await conn.send("Browser.setPermission", { permission: { name: permission }, setting: "denied" }, undefined, this.callMs).catch(() => undefined);
      }
      await conn.send("Target.setDiscoverTargets", { discover: true, filter: [{ type: "page" }] }, undefined, this.callMs);
      // Every page, a page's own windows included, is attached paused, so it's set up before it runs.
      await conn.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: "page" }] }, undefined, this.callMs);
    } catch (e) {
      profile.leaving = true;
      await conn.close().catch(() => undefined);
      throw new Error(`the headless browser for ${name} didn't set up: ${errorText(e)}`);
    }
    if (this.down) {
      profile.leaving = true;
      await conn.close().catch(() => undefined);
      throw new Error("the headless browser is shut down");
    }
    this.profiles.set(name, profile);
    this.log(`started the headless browser for ${name}`);
    return profile;
  }

  /** The profile's browser went without being asked to: its tabs are closed by a crash, its streams failed. */
  private gone(profile: Profile, why: string): void {
    if (this.profiles.get(profile.name) === profile) this.profiles.delete(profile.name);
    clearTimeout(profile.idle);
    for (const resolve of profile.claims.values()) resolve(undefined as unknown as Attached);
    profile.claims.clear();
    if (profile.leaving) return;
    this.log(`the headless browser for ${profile.name} went: ${why}`);
    for (const id of profile.tabs) {
      const tab = this.tabs.get(id);
      if (tab === undefined || tab.closed) continue;
      this.endStream(tab, "failed", why);
      tab.closed = true;
      this.tabs.delete(id);
      this.queue({ kind: "closed", id, by: "crash" });
    }
    profile.tabs.clear();
  }

  private maybeIdle(profile: Profile): void {
    if (profile.tabs.size > 0 || profile.leaving) return;
    clearTimeout(profile.idle);
    profile.idle = setTimeout(() => {
      if (profile.tabs.size > 0 || profile.creating > 0) return;
      profile.leaving = true;
      if (this.profiles.get(profile.name) === profile) this.profiles.delete(profile.name);
      void profile.conn.close().catch(() => undefined);
    }, this.opts.idleMs ?? 60_000);
    profile.idle.unref?.();
  }

  // -----------------------------------------------------------------------------------------------
  // Tabs
  // -----------------------------------------------------------------------------------------------

  /** A new page in the profile, set up and running at the agent's size, as the tab `id`. */
  private async newTarget(profile: Profile, id: string, keep?: { place: TabPlace; viewport: Viewport }): Promise<Tab> {
    clearTimeout(profile.idle);
    profile.creating++;
    let targetId: string | undefined;
    try {
      const viewport = keep?.viewport ?? AGENT_VIEWPORT;
      targetId = (await profile.conn.send<{ targetId: string }>("Target.createTarget", { url: "about:blank", width: viewport.width, height: viewport.height }, undefined, this.callMs)).targetId;
      const attached = await this.claim(profile, targetId);
      const tab: Tab = {
        id, owner: profile.owner, profile, targetId, sessionId: attached.sessionId, url: "about:blank", title: "", loading: false,
        place: keep?.place ?? "headless", viewport: { ...viewport }, closed: false, closing: false,
      };
      this.tabs.set(id, tab);
      profile.tabs.add(id);
      await this.setUp(tab);
      this.changed(tab);
      return tab;
    } catch (e) {
      if (targetId !== undefined) void profile.conn.send("Target.closeTarget", { targetId }, undefined, this.callMs).catch(() => undefined);
      const tab = this.tabs.get(id);
      if (tab !== undefined && tab.profile === profile) {
        tab.closed = true;
        this.tabs.delete(id);
        profile.tabs.delete(id);
      }
      this.maybeIdle(profile);
      throw e instanceof CdpError ? new Error(`the headless browser didn't open the tab: ${e.message}`) : e;
    } finally {
      profile.creating--;
      if (profile.creating === 0) this.adoptUnclaimed(profile);
    }
  }

  private claim(profile: Profile, targetId: string): Promise<Attached> {
    const ready = profile.unclaimed.get(targetId);
    if (ready !== undefined) {
      profile.unclaimed.delete(targetId);
      return Promise.resolve(ready);
    }
    return new Promise<Attached>((resolve, reject) => {
      const timer = setTimeout(() => {
        profile.claims.delete(targetId);
        reject(new Error("the new tab never attached"));
      }, this.callMs);
      profile.claims.set(targetId, (a) => {
        clearTimeout(timer);
        profile.claims.delete(targetId);
        if (a === undefined) reject(new Error("the browser went before the tab opened"));
        else resolve(a);
      });
    });
  }

  /** A page, paused at its start: its events on, file choosers kept from opening, then let run. */
  private async setUp(tab: Tab): Promise<void> {
    const c = tab.profile.conn;
    await c.send("Page.enable", {}, tab.sessionId, this.callMs);
    await c.send("Page.setInterceptFileChooserDialog", { enabled: true }, tab.sessionId, this.callMs).catch(() => undefined);
    await c.send("Runtime.runIfWaitingForDebugger", {}, tab.sessionId, this.callMs);
  }

  /** Targets attached while no `open` was creating one: a page's own windows (`window.open`, a link with a target),
   *  which become tabs of the profile's owner (every page in a profile is its owner's). */
  private adoptUnclaimed(profile: Profile): void {
    for (const a of [...profile.unclaimed.values()]) {
      profile.unclaimed.delete(a.targetId);
      void this.adoptPopup(profile, a);
    }
  }

  private async adoptPopup(profile: Profile, a: Attached): Promise<void> {
    if (profile.leaving || profile.conn.closed) return;
    const id = this.opts.newId?.() ?? `tab_${randomBytes(9).toString("base64url")}`;
    const tab: Tab = {
      id, owner: profile.owner, profile, targetId: a.targetId, sessionId: a.sessionId, url: a.url || "about:blank", title: a.title,
      loading: false, place: "headless", viewport: { ...AGENT_VIEWPORT }, closed: false, closing: false,
    };
    this.tabs.set(id, tab);
    profile.tabs.add(id);
    clearTimeout(profile.idle);
    try {
      await this.setUp(tab);
      this.changed(tab);
    } catch (e) {
      this.log(`a page's window in ${profile.name} couldn't be set up: ${errorText(e)}`);
      await this.closeTab(tab).catch(() => undefined);
    }
  }

  /** The tab's address and title as the browser has them now (`Target.targetInfoChanged` doesn't announce every title
   *  a page sets), reported if they changed. */
  private refreshInfo(tab: Tab): void {
    void tab.profile.conn.send<{ targetInfo: { url?: string; title?: string } }>("Target.getTargetInfo", { targetId: tab.targetId }, undefined, this.callMs).then(
      ({ targetInfo }) => this.setInfo(tab, targetInfo.url, targetInfo.title, true),
      () => this.changed(tab),
    );
  }

  private setInfo(tab: Tab, url: string | undefined, title: string | undefined, always = false): void {
    if (tab.closed) return;
    const nextUrl = url || tab.url;
    const nextTitle = title ?? tab.title;
    if (always || nextUrl !== tab.url || nextTitle !== tab.title) {
      tab.url = nextUrl;
      tab.title = nextTitle;
      this.changed(tab);
    }
  }

  private navigate(tab: Tab, url: string): void {
    // Not awaited to the load's end, as in the app: a slow page shouldn't hold the call.
    tab.loading = true;
    tab.url = url;
    void tab.profile.conn.send("Page.navigate", { url }, tab.sessionId, 60_000).catch(() => undefined);
    this.changed(tab);
  }

  private async closeTab(tab: Tab): Promise<void> {
    if (tab.closed) return;
    tab.closing = true;
    this.endStream(tab, "closed");
    await tab.profile.conn.send("Target.closeTarget", { targetId: tab.targetId }, undefined, this.callMs).catch(() => undefined);
    this.forget(tab, "user");
  }

  private forget(tab: Tab, by: "user" | "page" | "crash"): void {
    if (tab.closed) return;
    tab.closed = true;
    this.endStream(tab, by === "crash" ? "failed" : "closed");
    if (this.tabs.get(tab.id) === tab) this.tabs.delete(tab.id);
    tab.profile.tabs.delete(tab.id);
    this.queue({ kind: "closed", id: tab.id, by });
    this.maybeIdle(tab.profile);
  }

  private async place(tab: Tab, place: TabPlace, viewport: Viewport | undefined): Promise<void> {
    if (place === "shown") throw new Error(SHOWN_REFUSED);
    const size = viewport ?? AGENT_VIEWPORT;
    checkViewport(size);
    if (size.width !== tab.viewport.width || size.height !== tab.viewport.height) {
      const c = tab.profile.conn;
      const { windowId } = await c.send<{ windowId: number }>("Browser.getWindowForTarget", { targetId: tab.targetId }, undefined, this.callMs);
      await c.send("Browser.setWindowBounds", { windowId, bounds: { width: size.width, height: size.height } }, undefined, this.callMs);
      tab.viewport = { width: size.width, height: size.height };
    }
    // `resting` only records the place: the shell has no way to stop a page painting, and its timers keep running, as
    // a resting tab's do in the app.
    tab.place = place;
    this.changed(tab);
  }

  private async screenshot(tab: Tab, format: ScreenshotFormat, quality: number | undefined): Promise<Screenshot> {
    const takenAt = Date.now();
    let r: { data: string };
    try {
      r = await tab.profile.conn.send<{ data: string }>("Page.captureScreenshot", {
        format, ...(quality !== undefined && format !== "png" ? { quality } : {}), fromSurface: true, captureBeyondViewport: false,
      }, tab.sessionId, Math.min(this.callMs, 10_000));
    } catch (e) {
      if (e instanceof CdpError && e.kind === "timeout") this.queue({ kind: "stalled", id: tab.id, sinceMs: Date.now() - takenAt });
      throw new Error(`the tab gave no picture: ${errorText(e)}`);
    }
    const size = imageSize(Buffer.from(r.data, "base64"));
    // A picture is only ever of the tab at its current size: a point taken from it must land where it says.
    if (size === undefined || size.width !== tab.viewport.width || size.height !== tab.viewport.height) {
      throw new Error(`the tab's picture is ${size ? `${size.width}×${size.height}` : "unreadable"}, not the tab's ${tab.viewport.width}×${tab.viewport.height}`);
    }
    return { format, data: r.data, width: size.width, height: size.height, takenAt, contentAgeMs: 0 };
  }

  private async cdp(tab: Tab, method: string, params: Record<string, unknown> | undefined): Promise<unknown> {
    // The core refused these already; the pipe reaches every tab and the browser itself, so this side refuses again.
    checkCdpMethod(method);
    if (tab.stream !== undefined && STREAM_METHODS.includes(method)) {
      throw new BrowserError("method_refused", `${method} isn't available while the tab is streaming to another device`);
    }
    // Defense in depth only (the browser-level interception is the rule): a bot's own interception can't send a
    // request on to a refused address.
    if ((method === "Fetch.continueRequest" || method === "Fetch.continueResponse") && typeof params?.url === "string" && !isBrowserUrlAllowed(params.url)) {
      throw new BrowserError("url_refused", `the browser doesn't load ${params.url.slice(0, 200)}`);
    }
    try {
      return await tab.profile.conn.send(method, params ?? {}, tab.sessionId, this.callMs);
    } catch (e) {
      throw new Error(errorText(e));
    }
  }

  // -----------------------------------------------------------------------------------------------
  // Streams: JPEG frames from the screencast
  // -----------------------------------------------------------------------------------------------

  private async startStream(tab: Tab, name: string, maxKbps: number | undefined, codecs: StreamCodec[] | undefined): Promise<void> {
    if (codecs !== undefined && !codecs.includes("jpeg")) {
      throw new Error("a headless computer's browser streams JPEG frames only (no video encoder runs here)");
    }
    if (tab.stream !== undefined) {
      if (tab.stream.name === name) return;
      await this.stopStream(tab, tab.stream.name);
    }
    const stream: Stream = { name, ...(maxKbps !== undefined ? { kbps: maxKbps } : {}) };
    tab.stream = stream;
    this.emitChunk(name, { kind: "config", codec: "jpeg", width: tab.viewport.width, height: tab.viewport.height, codecString: "jpeg" });
    try {
      await this.screencast(tab, stream);
    } catch (e) {
      this.endStream(tab, "failed", errorText(e));
      throw new Error(`the tab's stream didn't start: ${errorText(e)}`);
    }
  }

  private async screencast(tab: Tab, stream: Stream): Promise<void> {
    const { quality, everyNthFrame } = screencastSettings(stream.kbps);
    await tab.profile.conn.send("Page.startScreencast", {
      format: "jpeg", quality, everyNthFrame, maxWidth: tab.viewport.width, maxHeight: tab.viewport.height,
    }, tab.sessionId, this.callMs);
  }

  private async stopStream(tab: Tab, name: string): Promise<void> {
    if (tab.stream?.name !== name) return;
    await tab.profile.conn.send("Page.stopScreencast", {}, tab.sessionId, this.callMs).catch(() => undefined);
    this.endStream(tab, "stopped");
  }

  private async controlStream(tab: Tab, name: string, keyframe: boolean | undefined, kbps: number | undefined): Promise<void> {
    const stream = tab.stream;
    if (stream?.name !== name) throw new Error(`the tab isn't streaming ${name}`);
    if (kbps !== undefined && kbps !== stream.kbps) {
      stream.kbps = kbps;
      await tab.profile.conn.send("Page.stopScreencast", {}, tab.sessionId, this.callMs).catch(() => undefined);
      await this.screencast(tab, stream);
    }
    // Every JPEG frame is a key frame; a still page draws none, so the newest one goes again.
    if (keyframe === true && stream.last !== undefined) {
      this.emitChunk(name, { kind: "frame", key: true, timestamp: Date.now() * 1000, data: stream.last });
    }
  }

  private endStream(tab: Tab, reason: "stopped" | "closed" | "failed", message?: string): void {
    const stream = tab.stream;
    if (stream === undefined) return;
    tab.stream = undefined;
    this.emitChunk(stream.name, { kind: "ended", reason, ...(message !== undefined ? { message } : {}) });
  }

  private onFrame(tab: Tab, params: Record<string, unknown>): void {
    // One frame in flight: Chromium sends the next only once this one is acked, and drops what drew meanwhile, so the
    // next to come is always the newest.
    void tab.profile.conn.send("Page.screencastFrameAck", { sessionId: params.sessionId }, tab.sessionId, this.callMs).catch(() => undefined);
    const stream = tab.stream;
    if (stream === undefined || typeof params.data !== "string") return;
    const data = new Uint8Array(Buffer.from(params.data, "base64"));
    stream.last = data;
    const seconds = (params.metadata as { timestamp?: number } | undefined)?.timestamp;
    this.emitChunk(stream.name, { kind: "frame", key: true, timestamp: Math.round((seconds ?? Date.now() / 1000) * 1_000_000), data });
  }

  private emitChunk(stream: string, chunk: StreamChunk): void {
    try {
      this.opts.streamData?.(stream, chunk);
    } catch {
      // The receiver's mistake never stops the browser.
    }
  }

  // -----------------------------------------------------------------------------------------------
  // The browser's events
  // -----------------------------------------------------------------------------------------------

  private onEvent(profile: Profile, e: CdpEvent): void {
    if (e.sessionId === undefined) {
      this.onBrowserEvent(profile, e);
      return;
    }
    const tab = this.tabBySession(profile, e.sessionId);
    if (tab === undefined) return;
    const p = e.params;
    switch (e.method) {
      case "Page.javascriptDialogOpening":
        // Answered at once (the app's `disableDialogs`); the bot still sees what the page asked, as a Page event.
        void profile.conn.send("Page.handleJavaScriptDialog", { accept: p.type === "beforeunload" }, tab.sessionId, this.callMs).catch(() => undefined);
        break;
      case "Page.frameStartedLoading":
        if (p.frameId === tab.targetId && !tab.loading) {
          tab.loading = true;
          this.changed(tab);
        }
        break;
      case "Page.frameStoppedLoading":
        if (p.frameId === tab.targetId) {
          tab.loading = false;
          this.refreshInfo(tab);
        }
        break;
      case "Page.domContentEventFired":
      case "Page.loadEventFired":
      case "Page.navigatedWithinDocument":
        // The target's title isn't always announced when the page sets it: asked for here.
        this.refreshInfo(tab);
        break;
      case "Page.screencastFrame":
        if (tab.stream !== undefined) {
          this.onFrame(tab, p);
          return;
        }
        break;
      case "Page.screencastVisibilityChanged":
        if (tab.stream !== undefined) return;
        break;
      case "Inspector.targetCrashed":
        void profile.conn.send("Target.closeTarget", { targetId: tab.targetId }, undefined, this.callMs).catch(() => undefined);
        this.forget(tab, "crash");
        return;
    }
    // Only the allow list's events reach the API, as in the app.
    if (isAllowedEvent(e.method)) this.queue({ kind: "cdp", id: tab.id, method: e.method, params: p });
  }

  private onBrowserEvent(profile: Profile, e: CdpEvent): void {
    const p = e.params;
    switch (e.method) {
      case "Fetch.requestPaused": {
        // The URL rule, for every request in the profile however it started.
        const request = p.request as { url?: string; urlFragment?: string } | undefined;
        const url = `${request?.url ?? ""}${request?.urlFragment ?? ""}`;
        const allowed = isBrowserUrlAllowed(url);
        void profile.conn.send(allowed ? "Fetch.continueRequest" : "Fetch.failRequest", allowed ? { requestId: p.requestId } : { requestId: p.requestId, errorReason: "BlockedByClient" }, undefined, this.callMs).catch(() => undefined);
        if (!allowed) this.log(`refused a ${url.split(":")[0]?.slice(0, 32) ?? "?"}: request in ${profile.name}`);
        return;
      }
      case "Target.attachedToTarget": {
        const info = p.targetInfo as { targetId: string; type: string; url?: string; title?: string; openerId?: string };
        const sessionId = String(p.sessionId);
        if (info.type !== "page") {
          void profile.conn.send("Runtime.runIfWaitingForDebugger", {}, sessionId, this.callMs).catch(() => undefined);
          void profile.conn.send("Target.detachFromTarget", { sessionId }, undefined, this.callMs).catch(() => undefined);
          return;
        }
        const a: Attached = { targetId: info.targetId, sessionId, url: info.url ?? "", title: info.title ?? "", ...(info.openerId ? { openerId: info.openerId } : {}) };
        const claim = profile.claims.get(info.targetId);
        if (claim !== undefined) claim(a);
        else if (profile.creating > 0 && a.openerId === undefined) profile.unclaimed.set(a.targetId, a); // maybe an `open`'s
        else void this.adoptPopup(profile, a);
        return;
      }
      case "Target.targetInfoChanged": {
        const info = p.targetInfo as { targetId: string; url?: string; title?: string };
        const tab = this.tabByTarget(profile, info.targetId);
        if (tab !== undefined) this.setInfo(tab, info.url, info.title);
        return;
      }
      case "Target.targetCrashed": {
        const tab = this.tabByTarget(profile, String(p.targetId));
        if (tab === undefined) return;
        void profile.conn.send("Target.closeTarget", { targetId: tab.targetId }, undefined, this.callMs).catch(() => undefined);
        this.forget(tab, "crash");
        return;
      }
      case "Target.targetDestroyed": {
        const targetId = String(p.targetId);
        profile.unclaimed.delete(targetId);
        const tab = this.tabByTarget(profile, targetId);
        if (tab !== undefined) this.forget(tab, tab.closing ? "user" : "page");
        return;
      }
      case "Target.detachedFromTarget": {
        // A page's session can't detach on its own (`Target` never passes the API); if it did, the tab is unusable.
        const tab = this.tabBySession(profile, String(p.sessionId));
        if (tab !== undefined && !tab.closing) {
          void profile.conn.send("Target.closeTarget", { targetId: tab.targetId }, undefined, this.callMs).catch(() => undefined);
          this.forget(tab, "page");
        }
        return;
      }
    }
  }

  private tabBySession(profile: Profile, sessionId: string): Tab | undefined {
    for (const id of profile.tabs) {
      const tab = this.tabs.get(id);
      if (tab !== undefined && tab.sessionId === sessionId) return tab;
    }
    return undefined;
  }

  private tabByTarget(profile: Profile, targetId: string): Tab | undefined {
    for (const id of profile.tabs) {
      const tab = this.tabs.get(id);
      if (tab !== undefined && tab.targetId === targetId) return tab;
    }
    return undefined;
  }

  // -----------------------------------------------------------------------------------------------
  // Reports
  // -----------------------------------------------------------------------------------------------

  private view(tab: Tab): TabView {
    return {
      id: tab.id,
      computer: this.opts.computer,
      owner: tab.owner,
      partition: partitionFor(tab.owner),
      url: tab.url || "about:blank",
      title: tab.title,
      place: tab.place,
      viewport: { ...tab.viewport },
      loading: tab.loading,
      heldByUser: false,
    };
  }

  private changed(tab: Tab): void {
    if (!tab.closed) this.queue({ kind: "changed", tab: this.view(tab) });
  }

  private queue(event: AppTabEvent): void {
    if (this.down) return;
    this.pending.push(event);
    if (this.flushing) return;
    this.flushing = true;
    setImmediate(() => {
      this.flushing = false;
      const events = this.pending;
      this.pending = [];
      // Only the newest change of each tab matters (as the app batches).
      const newest = new Map<string, number>();
      events.forEach((e, i) => { if (e.kind === "changed") newest.set(e.tab.id, i); });
      const batch = events.filter((e, i) => e.kind !== "changed" || newest.get(e.tab.id) === i);
      for (let i = 0; i < batch.length; i += 1000) {
        try {
          this.opts.report(batch.slice(i, i + 1000));
        } catch {
          // The core asks for `list` when it comes back.
        }
      }
    });
  }

  private log(line: string): void {
    try {
      this.opts.log?.(`browser: ${line}`);
    } catch {
      // Logging never breaks the browser.
    }
  }
}

/** An event the API may see: the allow list's domains, as the app forwards them. */
function isAllowedEvent(method: string): boolean {
  return isCdpMethodAllowed(method);
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The OS's proxy tools, through `Bun.spawn` (never `node:child_process` on Linux, S7). */
const bunRun: RunCommand = async (cmd, args) => {
  const proc = Bun.spawn([cmd, ...args], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const timer = setTimeout(() => proc.kill(), 5_000);
  try {
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code !== 0) throw Object.assign(new Error(`${cmd} exited ${code}`), { stdout: out });
    return out;
  } finally {
    clearTimeout(timer);
  }
};
export { bunRun };
