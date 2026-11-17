// A MOSS Browser tab's pictures inside the engine (spec revision 19, §3.6, §12.1, item 111; the controller's ruling on
// `host.tab.frame`; lane HS, read by lane AF too).
//
// `TabFrames` is the one interface the engine's readers of a tab's pictures use: `browser.view.open` (a window's view of
// a tab, `door.ts`) and lane AF's live picture (the picture of the tab the browser's tool drives). Subscribe to a tab,
// get its latest frame at once and every one after it. `FixtureTabFrames` is the stand-in a test or a lane builds
// against; `EngineTabFrames` is the real one, fed by `host.tab.frame` from the program that runs the pages.
//
// * One owner of the pages: `pagesOwner` picks the connection the engine sends its tab requests to (`app.tab.*`,
//   `browser/app-port.ts`) and the only one whose frames it takes: the background host once one is connected with the
//   browser, else today's app (MOSS Code's window, `code`), and never MOSS's window, a layer or a plugin connection.
// * A frame is refused if it isn't a jpeg, png or webp by its own header, if its header's size isn't what it says, or if
//   it is larger than the stream's declared size (the tab's viewport when the stream started, at most the picture
//   limits). Frames over `PICTURE_MAX_FPS` per stream are dropped, never queued; a reader with a lower `maxFps` skips
//   frames to keep to it.
// * The stream runs while anyone subscribes: started on the first reader (`app.tab.command` `stream` with `codecs:
//   ["jpeg"]`), stopped after the last, and ended for everyone when the owner's connection goes.
import { randomUUID } from "node:crypto";
import { PICTURE_MAX_FPS, PICTURE_MAX_HEIGHT, PICTURE_MAX_WIDTH, type PictureFormat, type PictureFrame, type Viewport } from "@waifucave/moss-protocol";
import { decodeStrictBase64, imageDimensions, sniffImageMediaType } from "../agent/stage-image";
import type { Unsubscribe } from "../contracts/common";
import type { MossConn } from "../ipc/moss";

/** One picture of a tab, as the engine holds it: the image base64, as it travels on to a window. */
export interface TabFrame {
  tab: string;
  seq: number;
  format: PictureFormat;
  width: number;
  height: number;
  data: string;
  at: number;
}

export interface TabFrames {
  /** The tab's frames for `fn`: the latest at once if there is one, then each new one, at most `maxFps` a second. */
  subscribe(tab: string, fn: (frame: TabFrame) => void, opts?: { maxFps?: number }): Unsubscribe;
  /** The tab's newest frame while anyone subscribes to it. */
  latest(tab: string): TabFrame | undefined;
}

/** The feature an app lists in its hello when it runs the browser's pages (`browser/app-port.ts`'s). */
const BROWSER_FEATURE = "browser";

/** The connection that runs the browser's pages: the host when one is connected with the browser, else today's app
 *  (`code`); never MOSS's window. The one place that decides it, for the tab requests and for whose frames count. */
export function pagesOwner(conns: readonly MossConn[], opts: { hostOwnsScreen?: boolean } = {}): MossConn | undefined {
  const runs = (c: MossConn) => c.role === "app" && c.features.includes(BROWSER_FEATURE);
  const host = conns.find((c) => runs(c) && c.program === "host");
  // While a host owns the screen (starting, restarting) the window has no pages to give: none until the host is back.
  if (host !== undefined || opts.hostOwnsScreen === true) return host;
  return conns.find((c) => runs(c) && c.program === "code");
}

interface Reader { fn: (frame: TabFrame) => void; minGapMs: number; last: number }

/** A stand-in: a test pushes frames, and it hands them to its readers by the same rules. */
export class FixtureTabFrames implements TabFrames {
  readonly #readers = new Map<string, Set<Reader>>();
  readonly #latest = new Map<string, TabFrame>();
  readonly subscribed: string[] = [];
  constructor(private readonly now: () => number = Date.now) {}
  push(frame: TabFrame): void {
    this.#latest.set(frame.tab, frame);
    deliver(this.#readers.get(frame.tab), frame, this.now());
  }
  subscribe(tab: string, fn: (frame: TabFrame) => void, opts: { maxFps?: number } = {}): Unsubscribe {
    this.subscribed.push(tab);
    return addReader(this.#readers, tab, fn, opts, this.#latest.get(tab), this.now(), () => {});
  }
  latest(tab: string): TabFrame | undefined {
    return this.#latest.get(tab);
  }
}

function deliver(readers: Set<Reader> | undefined, frame: TabFrame, now: number): void {
  for (const r of readers ?? []) {
    if (now - r.last < r.minGapMs) continue;
    r.last = now;
    try { r.fn(frame); } catch { /* a reader's own failure is its own */ }
  }
}

function addReader(map: Map<string, Set<Reader>>, tab: string, fn: (frame: TabFrame) => void, opts: { maxFps?: number }, latest: TabFrame | undefined, now: number, empty: () => void): Unsubscribe {
  const fps = Math.max(1, Math.min(opts.maxFps ?? PICTURE_MAX_FPS, PICTURE_MAX_FPS));
  const r: Reader = { fn, minGapMs: 1000 / fps, last: -Infinity };
  let set = map.get(tab);
  if (!set) { set = new Set(); map.set(tab, set); }
  set.add(r);
  if (latest !== undefined) { r.last = now; try { fn(latest); } catch { /* its own */ } }
  return () => {
    const s = map.get(tab);
    if (!s?.delete(r)) return;
    if (s.size === 0) { map.delete(tab); empty(); }
  };
}

export interface EngineTabFramesDeps {
  /** The connections, for `pagesOwner`. */
  connections(): readonly MossConn[];
  /** Whether a background host owns the screen (`pagesOwner`'s rule). */
  hostOwnsScreen?(): boolean;
  ask(conn: MossConn, method: string, params: unknown, timeoutMs: number): Promise<unknown>;
  /** The tab's viewport now (its stream's declared size), or undefined when the browser doesn't know it. */
  viewport(tab: string): Viewport | undefined;
  now?(): number;
  log?(line: string): void;
}

interface TabStream { id: string; tab: string; owner: number; width: number; height: number; lastAccepted: number; seq: number; latest?: TabFrame }

export type FrameVerdict = "taken" | "dropped" | "refused";

export class EngineTabFrames implements TabFrames {
  readonly #readers = new Map<string, Set<Reader>>();
  readonly #streams = new Map<string, TabStream>(); // by stream id
  readonly #byTab = new Map<string, TabStream>();
  readonly #now: () => number;
  readonly #log: (line: string) => void;

  constructor(private readonly deps: EngineTabFramesDeps) {
    this.#now = deps.now ?? Date.now;
    this.#log = deps.log ?? (() => {});
  }

  subscribe(tab: string, fn: (frame: TabFrame) => void, opts: { maxFps?: number } = {}): Unsubscribe {
    const off = addReader(this.#readers, tab, fn, opts, this.#byTab.get(tab)?.latest, this.#now(), () => this.#stop(tab));
    if (!this.#byTab.has(tab)) this.#start(tab);
    return off;
  }

  latest(tab: string): TabFrame | undefined {
    return this.#byTab.get(tab)?.latest;
  }

  /** `host.tab.frame`: one frame from `conn`. */
  accept(conn: MossConn, frame: PictureFrame): FrameVerdict {
    const s = this.#streams.get(frame.stream);
    if (s === undefined || s.owner !== conn.connId || this.#owner()?.connId !== conn.connId) return "refused";
    const bytes = decodeStrictBase64(frame.data);
    if (bytes === undefined) return "refused";
    const sniffed = sniffImageMediaType(bytes);
    const format = sniffed === "image/jpeg" ? "jpeg" : sniffed === "image/png" ? "png" : sniffed === "image/webp" ? "webp" : undefined;
    if (format === undefined || format !== frame.format) return "refused";
    const size = imageDimensions(bytes);
    if (size === undefined || size.width !== frame.width || size.height !== frame.height) return "refused";
    if (size.width > s.width || size.height > s.height) { this.#log(`[host] a tab's picture refused: ${size.width}x${size.height} over its stream's ${s.width}x${s.height}`); return "refused"; }
    const now = this.#now();
    if (now - s.lastAccepted < 1000 / PICTURE_MAX_FPS) return "dropped";
    s.lastAccepted = now;
    const f: TabFrame = { tab: s.tab, seq: ++s.seq, format, width: size.width, height: size.height, data: frame.data, at: frame.at };
    s.latest = f;
    deliver(this.#readers.get(s.tab), f, now);
    return "taken";
  }

  /** The owner's connection closed: every stream it ran ends (readers keep their subscription and get frames again
   *  once a new owner's stream starts on the next subscribe). */
  ownerGone(connId: number): void {
    for (const s of [...this.#streams.values()]) {
      if (s.owner !== connId) continue;
      this.#streams.delete(s.id);
      this.#byTab.delete(s.tab);
    }
  }

  /** The pages' owner may have changed (a host said ready, a connection closed): each stream a reader still wants whose
   *  owner is no longer the owner is ended there and started again with the new one, so a view never freezes. */
  reown(): void {
    const owner = this.#owner();
    for (const [tab, s] of [...this.#byTab]) {
      if (owner !== undefined && s.owner === owner.connId) continue;
      this.#stop(tab);
      if ((this.#readers.get(tab)?.size ?? 0) > 0) this.#start(tab);
    }
    // A tab with readers and no stream (its owner went before anyone took over) starts on the new owner.
    for (const tab of this.#readers.keys()) if (!this.#byTab.has(tab)) this.#start(tab);
  }

  #owner(): MossConn | undefined {
    return pagesOwner(this.deps.connections(), { hostOwnsScreen: this.deps.hostOwnsScreen?.() ?? false });
  }

  #start(tab: string): void {
    const owner = this.#owner();
    if (owner === undefined) return;
    const vp = this.deps.viewport(tab) ?? { width: PICTURE_MAX_WIDTH, height: PICTURE_MAX_HEIGHT };
    const s: TabStream = { id: `frames-${randomUUID()}`, tab, owner: owner.connId, width: Math.min(vp.width, PICTURE_MAX_WIDTH), height: Math.min(vp.height, PICTURE_MAX_HEIGHT), lastAccepted: -Infinity, seq: 0 };
    this.#streams.set(s.id, s);
    this.#byTab.set(tab, s);
    this.#log(`[host] a tab's pictures asked of the ${owner.program ?? "app"} program (${s.width}x${s.height})`);
    this.deps.ask(owner, "app.tab.command", { id: tab, command: { kind: "stream", stream: s.id, on: true, codecs: ["jpeg"] } }, 30_000)
      .catch((e: unknown) => this.#log(`[host] a tab's pictures did not start: ${(e as Error).message}`));
  }

  #stop(tab: string): void {
    const s = this.#byTab.get(tab);
    if (s === undefined) return;
    this.#byTab.delete(tab);
    this.#streams.delete(s.id);
    const owner = this.deps.connections().find((c) => c.connId === s.owner);
    if (owner !== undefined) {
      this.deps.ask(owner, "app.tab.command", { id: tab, command: { kind: "stream", stream: s.id, on: false } }, 30_000).catch(() => undefined);
    }
  }
}
