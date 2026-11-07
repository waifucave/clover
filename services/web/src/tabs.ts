// A computer's browser tabs in the web companion (spec §12.1, "[P] From another device"): the list (`browser.tabs`,
// kept current by the `browser` area's `tab_changed` and `tab_closed` events) and watching one live
// (`browser.stream`, decoded by tab-stream.ts). Viewing only: nothing the person does here reaches the tab; input
// waits for the spec's remote-control rules.

import { readStreamMeta, STREAM_LINK_LABEL, type StreamCodec } from "../protocol/browser-stream";
import type { LinkStream } from "../protocol/rtc-link";
import { decodableCodecs, type TabPicture, type TabStreamDecoders, TabStreamView } from "./tab-stream";

/** What the tabs need of the link (RtcLink has it; tests fake it). */
export interface BrowserLink {
  request<R = unknown>(method: string, params: unknown, opts?: { timeoutMs?: number }): Promise<R>;
  onNotify(method: string, fn: (params: unknown) => void): () => void;
  onStream(label: string, fn: (stream: LinkStream, meta: unknown) => void): () => void;
}

export type TabOwner = { kind: "bot"; bot: string } | { kind: "session"; session: string } | { kind: "plugin"; plugin: string } | { kind: "user" };

/** The protocol's `TabView`, as much of it as the list shows. */
export interface BrowserTab {
  id: string;
  computer: string;
  owner: TabOwner;
  url: string;
  title: string;
  place: "headless" | "shown" | "resting";
  loading: boolean;
  heldByUser: boolean;
}

const PLACES = ["headless", "shown", "resting"] as const;

export function readTab(v: unknown): BrowserTab | null {
  if (v === null || typeof v !== "object") return null;
  const t = v as Record<string, unknown>;
  const owner = readOwner(t.owner);
  if (typeof t.id !== "string" || typeof t.computer !== "string" || owner === null) return null;
  return {
    id: t.id,
    computer: t.computer,
    owner,
    url: typeof t.url === "string" ? t.url : "",
    title: typeof t.title === "string" ? t.title : "",
    place: PLACES.includes(t.place as BrowserTab["place"]) ? (t.place as BrowserTab["place"]) : "headless",
    loading: t.loading === true,
    heldByUser: t.heldByUser === true,
  };
}

function readOwner(v: unknown): TabOwner | null {
  if (v === null || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  switch (o.kind) {
    case "bot":
      return typeof o.bot === "string" ? { kind: "bot", bot: o.bot } : null;
    case "session":
      return typeof o.session === "string" ? { kind: "session", session: o.session } : null;
    case "plugin":
      return typeof o.plugin === "string" ? { kind: "plugin", plugin: o.plugin } : null;
    case "user":
      return { kind: "user" };
    default:
      return null;
  }
}

/** Whose tab it is, as the list says it: a bot by its name where the page knows it. */
export function ownerLabel(owner: TabOwner, botNames: ReadonlyMap<string, string> = new Map()): string {
  switch (owner.kind) {
    case "bot":
      return botNames.get(owner.bot) ?? owner.bot;
    case "session":
      return "A coding session";
    case "plugin":
      return `Plugin ${owner.plugin}`;
    case "user":
      return "You";
  }
}

/** The list's title for a tab: its title, else its address, else "New tab". */
export function tabTitle(tab: BrowserTab): string {
  return tab.title.trim() || tab.url || "New tab";
}

const OWNER_ORDER: Record<TabOwner["kind"], number> = { user: 0, bot: 1, session: 2, plugin: 3 };

function sorted(tabs: Iterable<BrowserTab>): BrowserTab[] {
  return [...tabs].sort((a, b) => OWNER_ORDER[a.owner.kind] - OWNER_ORDER[b.owner.kind] || tabTitle(a).localeCompare(tabTitle(b)) || a.id.localeCompare(b.id));
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** A computer's open tabs, kept current while open. */
export class TabList {
  readonly #link: BrowserLink;
  readonly #onChange: (tabs: BrowserTab[]) => void;
  #tabs = new Map<string, BrowserTab>();
  #off: (() => void) | undefined;
  #subscribed = false;
  #closed = false;

  constructor(link: BrowserLink, onChange: (tabs: BrowserTab[]) => void) {
    this.#link = link;
    this.#onChange = onChange;
  }

  get tabs(): BrowserTab[] {
    return sorted(this.#tabs.values());
  }

  /** Follows the `browser` area and reads the list. Throws when the computer won't list its tabs. */
  async open(): Promise<void> {
    this.#closed = false;
    this.#off ??= this.#link.onNotify("core.event", (e) => this.apply(e));
    // The events keep the list current; a computer that won't send them still lists its tabs.
    const subscribed = await this.#link.request("events.subscribe", { areas: ["browser"] }).then(() => true, () => false);
    if (this.#closed) {
      // Closed while the subscribe was in flight: undo it now that it has answered.
      if (subscribed) await this.#unsubscribe();
      return;
    }
    this.#subscribed = subscribed;
    await this.refresh();
  }

  async refresh(): Promise<void> {
    const r = await this.#link.request<{ tabs?: unknown[] }>("browser.tabs", {});
    this.#tabs = new Map((r.tabs ?? []).map(readTab).filter((t): t is BrowserTab => t !== null).map((t) => [t.id, t]));
    this.#onChange(this.tabs);
  }

  apply(event: unknown): void {
    if (event === null || typeof event !== "object") return;
    const e = event as Record<string, unknown>;
    if (e.type === "tab_changed") {
      const tab = readTab(e.tab);
      if (tab === null) return;
      this.#tabs.set(tab.id, tab);
    } else if (e.type === "tab_closed" && typeof e.id === "string") {
      if (!this.#tabs.delete(e.id)) return;
    } else {
      return;
    }
    this.#onChange(this.tabs);
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#off?.();
    this.#off = undefined;
    if (this.#subscribed) {
      this.#subscribed = false;
      await this.#unsubscribe();
    }
  }

  async #unsubscribe(): Promise<void> {
    await this.#link.request("events.unsubscribe", { areas: ["browser"] }).catch(() => undefined);
  }
}

/** A watch's state, for the screen to say. */
export type WatchState =
  | { kind: "starting" }
  | { kind: "live" }
  | { kind: "ended"; reason: "stopped" | "closed" | "failed"; message?: string }
  /** This side couldn't go on (refused, a codec it can't decode), or the link stream broke. */
  | { kind: "failed"; message: string };

/** A link stream held, before `browser.stream` has said which stream is the watch's: what came on it so far. */
interface Held {
  stream: LinkStream;
  id: string;
  bytes: Uint8Array[];
  ended: { error?: Error } | undefined;
  off: () => void;
}

interface Expected {
  view: TabStreamView;
  /** The stream `browser.stream` answered; until then, streams for the tab are held. */
  stream: string | undefined;
  claimed: boolean;
  held: Held[];
}

/** One watch's place in the inbox. */
export interface InboxTicket {
  /** `browser.stream` answered with this stream: a held one that matches is shown, every other is refused. */
  answered(stream: string): void;
  release(): void;
}

/** The link's `browser.stream` streams, each to the watch whose `browser.stream` answered its id (`meta.stream`). One
 *  per link: a link has one handler per label. A stream for a tab nobody watches, one that isn't the answered stream (a
 *  late one from an earlier watch of the same tab), or a second copy is refused; one that comes before the answer is
 *  held until it does. */
export class TabStreamInbox {
  readonly #watches = new Map<string, Expected>();
  readonly #off: () => void;

  constructor(link: BrowserLink) {
    this.#off = link.onStream(STREAM_LINK_LABEL, (stream, raw) => {
      const meta = readStreamMeta(raw);
      if (meta === null) return stream.abort("not a stream this reads");
      const w = this.#watches.get(meta.tab);
      if (w === undefined || w.view.closed || w.claimed) return stream.abort("not wanted");
      if (w.stream === undefined) return this.#hold(w, stream, meta.stream);
      if (w.stream !== meta.stream) return stream.abort("not wanted");
      w.claimed = true;
      attach(stream, w.view);
    });
  }

  /** Streams for `tab` go to `view` once `answered` names one. */
  expect(tab: string, view: TabStreamView): InboxTicket {
    const old = this.#watches.get(tab);
    if (old !== undefined) dropHeld(old);
    const entry: Expected = { view, stream: undefined, claimed: false, held: [] };
    this.#watches.set(tab, entry);
    return {
      answered: (stream) => {
        if (this.#watches.get(tab) !== entry || entry.stream !== undefined) return;
        entry.stream = stream;
        const held = entry.held;
        entry.held = [];
        for (const h of held) {
          h.off();
          if (h.id !== stream || entry.claimed || view.closed) {
            if (h.ended === undefined) h.stream.abort("not wanted");
            continue;
          }
          entry.claimed = true;
          for (const b of h.bytes) view.push(b);
          if (h.ended !== undefined) view.lose(h.ended.error);
          else attach(h.stream, view);
        }
      },
      release: () => {
        if (this.#watches.get(tab) !== entry) return;
        this.#watches.delete(tab);
        dropHeld(entry);
      },
    };
  }

  close(): void {
    this.#off();
    for (const w of this.#watches.values()) dropHeld(w);
    this.#watches.clear();
  }

  #hold(w: Expected, stream: LinkStream, id: string): void {
    const h: Held = { stream, id, bytes: [], ended: undefined, off: () => {} };
    const offData = stream.onData((b) => h.bytes.push(b.slice()));
    const offEnd = stream.onEnd((error) => (h.ended = error !== undefined ? { error } : {}));
    h.off = () => {
      offData();
      offEnd();
    };
    w.held.push(h);
  }
}

function dropHeld(w: Expected): void {
  for (const h of w.held) {
    h.off();
    if (h.ended === undefined) h.stream.abort("not wanted");
  }
  w.held = [];
}

/** The stream's bytes go to the view until either side ends: this side giving up aborts it; the computer's `ended`
 *  frame needs nothing more; the stream finishing or breaking first is said by the view. */
function attach(stream: LinkStream, view: TabStreamView): void {
  const offData = stream.onData((bytes) => {
    view.push(bytes);
    if (view.closed) {
      offData();
      if (!view.ended) stream.abort("can't show it");
    }
  });
  stream.onEnd((error) => {
    offData();
    view.lose(error);
  });
}

export interface TabWatchOptions {
  /** What this browser decodes (`decodableCodecs()`, asked once per page); the watch waits for it before asking. */
  codecs: StreamCodec[] | Promise<StreamCodec[]>;
  decoders?: TabStreamDecoders;
  onPicture(picture: TabPicture): void;
  onState(state: WatchState): void;
}

/** Watching one tab live. Read-only: it only asks for the stream and stops it. */
export class TabWatch {
  readonly #link: BrowserLink;
  readonly #inbox: TabStreamInbox;
  readonly #tab: string;
  readonly #o: TabWatchOptions;
  #view: TabStreamView | undefined;
  #ticket: InboxTicket | undefined;
  #state: WatchState = { kind: "starting" };
  #asked = false;
  #left = false;

  constructor(link: BrowserLink, inbox: TabStreamInbox, tab: string, o: TabWatchOptions) {
    this.#link = link;
    this.#inbox = inbox;
    this.#tab = tab;
    this.#o = o;
  }

  get state(): WatchState {
    return this.#state;
  }

  async start(): Promise<void> {
    if (this.#left || this.#view !== undefined) return;
    this.#o.onState(this.#state);
    const codecs = await this.#o.codecs;
    // Left while the codecs were worked out: nothing was asked, so nothing to stop.
    if (this.#left) return;
    const view = new TabStreamView({
      ...(this.#o.decoders ? { decoders: this.#o.decoders } : {}),
      onPicture: (p) => {
        if (this.#left) return p.close();
        if (this.#state.kind === "starting") this.#set({ kind: "live" });
        this.#o.onPicture(p);
      },
      onEnded: (e) => this.#finish({ kind: "ended", ...e }),
      onError: (message) => this.#finish({ kind: "failed", message }),
    });
    this.#view = view;
    // Expect the stream before asking: it may come before the answer does, and is held until then.
    const ticket = this.#inbox.expect(this.#tab, view);
    this.#ticket = ticket;
    let answer: { stream?: unknown };
    try {
      this.#asked = true;
      answer = await this.#link.request<{ stream?: unknown }>("browser.stream", { id: this.#tab, on: true, codecs });
    } catch (e) {
      this.#asked = false;
      this.#finish({ kind: "failed", message: describe(e) });
      return;
    }
    if (this.#left) return;
    if (typeof answer?.stream !== "string") return this.#finish({ kind: "failed", message: "the computer didn't start a stream" });
    ticket.answered(answer.stream);
  }

  /** Stops the stream and lets go of everything; safe to call more than once. */
  async leave(): Promise<void> {
    if (this.#left) return;
    this.#left = true;
    this.#ticket?.release();
    this.#view?.close();
    if (this.#asked && this.#state.kind !== "ended") {
      this.#asked = false;
      await this.#link.request("browser.stream", { id: this.#tab, on: false }).catch(() => undefined);
    }
  }

  #finish(state: WatchState): void {
    this.#ticket?.release();
    if (this.#state.kind === "ended" || this.#state.kind === "failed") return;
    this.#set(state);
    // A watch this side gave up on (or whose link stream broke) may still have a stream running on the computer.
    if (state.kind === "failed" && this.#asked) {
      this.#asked = false;
      void this.#link.request("browser.stream", { id: this.#tab, on: false }).catch(() => undefined);
    }
  }

  #set(state: WatchState): void {
    this.#state = state;
    if (!this.#left) this.#o.onState(state);
  }
}

export { decodableCodecs };
