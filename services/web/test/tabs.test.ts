// A computer's tabs in the web companion: the list kept current by the `browser` area's events, and watching one live
// over `browser.stream`, read-only, against a fake link that answers as lane L's protocol shapes say.

import { describe, expect, test } from "bun:test";

import type { LinkStream } from "../protocol/rtc-link";
import type { TabPicture, TabStreamDecoders } from "../src/tab-stream";
import { type BrowserTab, ownerLabel, readTab, TabList, TabStreamInbox, tabTitle, TabWatch, type WatchState } from "../src/tabs";

const tabView = (id: string, over: Record<string, unknown> = {}) => ({
  id, computer: "Studio", owner: { kind: "bot", bot: "alpha" }, partition: "persist:bot-alpha", url: `https://example.com/${id}`,
  title: `Page ${id}`, place: "headless", viewport: { width: 1280, height: 800 }, loading: false, heldByUser: false, ...over,
});

function frame(kind: 1 | 2 | 3, payload: Uint8Array, key = false): Uint8Array {
  const out = new Uint8Array(16 + payload.byteLength);
  const v = new DataView(out.buffer);
  v.setUint8(0, 1);
  v.setUint8(1, kind);
  v.setUint8(2, key ? 1 : 0);
  v.setUint32(12, payload.byteLength);
  out.set(payload, 16);
  return out;
}
const json = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
const config = (codec = "jpeg") => frame(1, json({ codec, width: 1280, height: 800, codecString: codec }));
/** A JPEG's start with its frame header (640x400), and `n` last for the fake decoder to report. */
const picture = (n: number) => frame(2, new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 1, 144, 2, 128, 1, 1, 0x11, 0, n]), true);
const ended = (reason: string) => frame(3, json({ reason }));

/** A link that answers by method, and lets the test send notifications and open streams. */
function fakeLink(answers: Record<string, (params: Record<string, unknown>) => unknown> = {}) {
  const calls: [string, Record<string, unknown>][] = [];
  const notes = new Map<string, Set<(p: unknown) => void>>();
  let streamHandler: ((s: LinkStream, meta: unknown) => void) | undefined;
  const link = {
    request: async <R>(method: string, params: unknown): Promise<R> => {
      const p = params as Record<string, unknown>;
      calls.push([method, p]);
      const answer = answers[method];
      if (!answer) throw new Error(`${method} isn't allowed`);
      return (await answer(p)) as R;
    },
    onNotify: (method: string, fn: (p: unknown) => void) => {
      const set = notes.get(method) ?? new Set();
      notes.set(method, set);
      set.add(fn);
      return () => set.delete(fn);
    },
    onStream: (label: string, fn: (s: LinkStream, meta: unknown) => void) => {
      expect(label).toBe("browser.stream");
      streamHandler = fn;
      return () => (streamHandler = undefined);
    },
  };
  const open = (meta: unknown) => {
    let data: ((b: Uint8Array) => void) | undefined;
    let end: ((e?: Error) => void) | undefined;
    const aborted: string[] = [];
    const stream = {
      id: "s", label: "browser.stream", priority: "screenshots", write: async () => {}, end: () => {},
      abort: (r?: string) => aborted.push(r ?? ""),
      onData: (fn: (b: Uint8Array) => void) => ((data = fn), () => (data = undefined)),
      onEnd: (fn: (e?: Error) => void) => ((end = fn), () => (end = undefined)),
    } as unknown as LinkStream;
    streamHandler!(stream, meta);
    return { aborted, send: (b: Uint8Array) => data?.(b), finish: (e?: Error) => end?.(e) };
  };
  const notify = (method: string, p: unknown) => notes.get(method)?.forEach((fn) => fn(p));
  return { link, calls, open, notify, listeners: () => notes.get("core.event")?.size ?? 0 };
}

const images = (): TabStreamDecoders => ({
  decodeImage: async (jpeg) => ({ image: {} as CanvasImageSource, width: 640, height: jpeg[jpeg.byteLength - 1]!, close: () => {} }),
});
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("the tab list", () => {
  test("follows the browser area, lists the tabs (yours first, then by title), and stays current", async () => {
    const f = fakeLink({
      "events.subscribe": () => ({ ok: true }),
      "events.unsubscribe": () => ({ ok: true }),
      "browser.tabs": () => ({ tabs: [tabView("t2", { title: "Zebra" }), tabView("t1", { title: "Apple" }), tabView("t3", { owner: { kind: "user" }, title: "Mine" }), { id: "broken" }] }),
    });
    const seen: string[][] = [];
    const list = new TabList(f.link, (tabs) => seen.push(tabs.map((t) => t.id)));
    await list.open();
    expect(f.calls.slice(0, 2)).toEqual([["events.subscribe", { areas: ["browser"] }], ["browser.tabs", {}]]);
    expect(seen.at(-1)).toEqual(["t3", "t1", "t2"]);

    f.notify("core.event", { type: "tab_changed", tab: tabView("t1", { title: "Banana", url: "https://b.example/" }) });
    expect(list.tabs.find((t) => t.id === "t1")?.title).toBe("Banana");
    f.notify("core.event", { type: "tab_changed", tab: tabView("t4", { title: "Cherry" }) });
    f.notify("core.event", { type: "tab_closed", id: "t2", computer: "Studio" });
    f.notify("core.event", { type: "bot_changed", bot: {} }); // not the list's
    expect(seen.at(-1)).toEqual(["t3", "t1", "t4"]);
    expect(seen).toHaveLength(4);

    await list.close();
    expect(f.calls.at(-1)).toEqual(["events.unsubscribe", { areas: ["browser"] }]);
    expect(f.listeners()).toBe(0);
  });

  test("a computer that refuses the events still lists; one that refuses the list says so", async () => {
    const f = fakeLink({ "browser.tabs": () => ({ tabs: [tabView("t1")] }) });
    const list = new TabList(f.link, () => {});
    await list.open();
    expect(list.tabs.map((t) => t.id)).toEqual(["t1"]);
    await list.close();
    expect(f.calls.map((c) => c[0])).toEqual(["events.subscribe", "browser.tabs"]); // nothing to unsubscribe

    const refused = new TabList(fakeLink().link, () => {});
    expect(refused.open()).rejects.toThrow("browser.tabs isn't allowed");
  });

  test("a list closed while its subscribe is in flight unsubscribes once the subscribe answers", async () => {
    let gate!: () => void;
    const answered = new Promise<void>((r) => (gate = r));
    const f = fakeLink({
      "events.subscribe": async () => (await answered, { ok: true }),
      "events.unsubscribe": () => ({ ok: true }),
      "browser.tabs": () => ({ tabs: [] }),
    });
    const list = new TabList(f.link, () => {});
    const opening = list.open();
    await list.close();
    expect(f.calls.map((c) => c[0])).toEqual(["events.subscribe"]);
    gate();
    await opening;
    expect(f.calls.map((c) => c[0])).toEqual(["events.subscribe", "events.unsubscribe"]);
  });

  test("tabs are read tolerantly; owners and titles are said plainly", () => {
    expect(readTab({ id: "t", computer: "c", owner: { kind: "alien" } })).toBeNull();
    const t = readTab({ id: "t", computer: "c", owner: { kind: "session", session: "s1" }, place: "elsewhere" }) as BrowserTab;
    expect(t.place).toBe("headless");
    expect(tabTitle(t)).toBe("New tab");
    expect(tabTitle({ ...t, url: "https://x.example/" })).toBe("https://x.example/");
    expect(ownerLabel({ kind: "bot", bot: "alpha" }, new Map([["alpha", "Alpha"]]))).toBe("Alpha");
    expect(ownerLabel({ kind: "bot", bot: "beta" })).toBe("beta");
    expect(ownerLabel({ kind: "session", session: "s" })).toBe("A coding session");
    expect(ownerLabel({ kind: "plugin", plugin: "clover/x" })).toBe("Plugin clover/x");
    expect(ownerLabel({ kind: "user" })).toBe("You");
  });
});

function watcher(f: ReturnType<typeof fakeLink>, inbox: TabStreamInbox, tab = "t1") {
  const states: WatchState["kind"][] = [];
  const pictures: number[] = [];
  const w = new TabWatch(f.link, inbox, tab, {
    codecs: ["h264", "jpeg"],
    decoders: images(),
    onState: (s) => states.push(s.kind),
    onPicture: (p: TabPicture) => pictures.push(p.height),
  });
  return { w, states, pictures };
}

describe("watching a tab", () => {
  test("asks for the stream with what it decodes, takes the stream even before the answer, and leaves cleanly", async () => {
    let early: ReturnType<ReturnType<typeof fakeLink>["open"]> | undefined;
    const f = fakeLink({
      "browser.stream": (p) => {
        // The computer opens the link stream before its answer arrives.
        if (p.on === true) early = f.open({ v: 1, stream: "st_1", tab: "t1", computer: "Studio" });
        return p.on === true ? { stream: "st_1" } : {};
      },
    });
    const inbox = new TabStreamInbox(f.link);
    const { w, states, pictures } = watcher(f, inbox);
    await w.start();
    expect(f.calls[0]).toEqual(["browser.stream", { id: "t1", on: true, codecs: ["h264", "jpeg"] }]);
    early!.send(config());
    early!.send(picture(7));
    await tick();
    expect(states).toEqual(["starting", "live"]);
    expect(pictures).toEqual([7]);

    // Another stream for the same tab, or one for a tab nobody watches, is refused.
    expect(f.open({ v: 1, stream: "st_2", tab: "t1", computer: "Studio" }).aborted).toEqual(["not wanted"]);
    expect(f.open({ v: 1, stream: "st_3", tab: "t9", computer: "Studio" }).aborted).toEqual(["not wanted"]);

    await w.leave();
    await w.leave();
    expect(f.calls.filter((c) => c[1].on === false)).toEqual([["browser.stream", { id: "t1", on: false }]]);
    early!.send(picture(8));
    await tick();
    expect(pictures).toEqual([7]); // nothing after leaving
    expect(early!.aborted).toEqual(["can't show it"]);
  });

  test("the tab closing, or its stream finishing unexplained, is said; neither sends a stop", async () => {
    const f = fakeLink({ "browser.stream": () => ({ stream: "st" }) });
    const inbox = new TabStreamInbox(f.link);
    const a = watcher(f, inbox, "t1");
    await a.w.start();
    const sa = f.open({ v: 1, stream: "st", tab: "t1", computer: "Studio" });
    sa.send(new Uint8Array([...config(), ...ended("closed")]));
    expect(a.states.at(-1)).toBe("ended");
    expect(a.w.state).toEqual({ kind: "ended", reason: "closed" });

    const b = watcher(f, inbox, "t2");
    await b.w.start();
    f.open({ v: 1, stream: "st", tab: "t2", computer: "Studio" }).finish();
    expect(b.w.state).toEqual({ kind: "ended", reason: "failed", message: "the stream ended without saying why" });
    await a.w.leave();
    await b.w.leave();
    expect(f.calls.filter((c) => c[1].on === false)).toEqual([]);
  });

  test("a refused stream fails without a stop; a codec this browser can't decode stops the computer's stream", async () => {
    const refused = fakeLink();
    const r = watcher(refused, new TabStreamInbox(refused.link));
    await r.w.start();
    expect(r.w.state).toEqual({ kind: "failed", message: "browser.stream isn't allowed" });
    expect(refused.calls).toHaveLength(1);

    const f = fakeLink({ "browser.stream": () => ({ stream: "st" }) });
    const v = watcher(f, new TabStreamInbox(f.link));
    await v.w.start();
    const s = f.open({ v: 1, stream: "st", tab: "t1", computer: "Studio" });
    s.send(config("vp8"));
    expect(v.w.state).toEqual({ kind: "failed", message: "this browser can't decode vp8 video" });
    expect(s.aborted).toEqual(["can't show it"]);
    await tick();
    expect(f.calls.at(-1)).toEqual(["browser.stream", { id: "t1", on: false }]);
  });

  test("a link stream that breaks is a failure, and the computer's stream is stopped", async () => {
    const f = fakeLink({ "browser.stream": () => ({ stream: "st" }) });
    const w = watcher(f, new TabStreamInbox(f.link));
    await w.w.start();
    f.open({ v: 1, stream: "st", tab: "t1", computer: "Studio" }).finish(new Error("the stream's channel closed"));
    expect(w.w.state).toEqual({ kind: "failed", message: "the stream broke: the stream's channel closed" });
    await tick();
    expect(f.calls.at(-1)).toEqual(["browser.stream", { id: "t1", on: false }]);
  });

  test("streams go by id: an old stream arriving late after leaving and watching again is refused", async () => {
    let n = 0;
    const f = fakeLink({ "browser.stream": (p) => (p.on === true ? { stream: `st_${++n}` } : {}) });
    const inbox = new TabStreamInbox(f.link);
    const first = watcher(f, inbox);
    await first.w.start();
    await first.w.leave();

    // Watch again; the first watch's stream turns up only now, before and after the second answer.
    let gate!: () => void;
    const answered = new Promise<void>((r) => (gate = r));
    const g = fakeLink({ "browser.stream": async (p) => (p.on === true ? (await answered, { stream: "st_2" }) : {}) });
    const inbox2 = new TabStreamInbox(g.link);
    const again = watcher(g, inbox2);
    const starting = again.w.start();
    await tick();
    const lateBefore = g.open({ v: 1, stream: "st_1", tab: "t1", computer: "Studio" });
    const mine = g.open({ v: 1, stream: "st_2", tab: "t1", computer: "Studio" });
    mine.send(config()); // held until the answer
    mine.send(picture(5));
    expect(again.pictures).toEqual([]);
    gate();
    await starting;
    await tick();
    expect(lateBefore.aborted).toEqual(["not wanted"]);
    expect(mine.aborted).toEqual([]);
    expect(again.pictures).toEqual([5]); // what was held is shown once the answer names it
    const lateAfter = g.open({ v: 1, stream: "st_1", tab: "t1", computer: "Studio" });
    expect(lateAfter.aborted).toEqual(["not wanted"]);
    mine.send(picture(6));
    await tick();
    expect(again.pictures).toEqual([5, 6]);

    // And on the first link: the old stream arriving after the second watch there answered is refused too.
    const second = watcher(f, inbox);
    await second.w.start();
    expect(f.open({ v: 1, stream: "st_1", tab: "t1", computer: "Studio" }).aborted).toEqual(["not wanted"]);
    const current = f.open({ v: 1, stream: "st_2", tab: "t1", computer: "Studio" });
    current.send(new Uint8Array([...config(), ...picture(9)]));
    await tick();
    expect(second.pictures).toEqual([9]);
  });

  test("a held stream that ended before the answer is still said; leaving before the answer refuses what was held", async () => {
    let gate!: () => void;
    const answered = new Promise<void>((r) => (gate = r));
    const f = fakeLink({ "browser.stream": async (p) => (p.on === true ? (await answered, { stream: "st" }) : {}) });
    const inbox = new TabStreamInbox(f.link);
    const w = watcher(f, inbox);
    const starting = w.w.start();
    await tick();
    const s = f.open({ v: 1, stream: "st", tab: "t1", computer: "Studio" });
    s.send(new Uint8Array([...config(), ...ended("closed")]));
    s.finish();
    gate();
    await starting;
    expect(w.w.state).toEqual({ kind: "ended", reason: "closed" });

    let gate2!: () => void;
    const answered2 = new Promise<void>((r) => (gate2 = r));
    const g = fakeLink({ "browser.stream": async (p) => (p.on === true ? (await answered2, { stream: "st" }) : {}) });
    const left = watcher(g, new TabStreamInbox(g.link));
    const starting2 = left.w.start();
    await tick();
    const held = g.open({ v: 1, stream: "st", tab: "t1", computer: "Studio" });
    await left.w.leave();
    expect(held.aborted).toEqual(["not wanted"]);
    gate2();
    await starting2;
    expect(g.calls.map((c) => c[1].on)).toEqual([true, false]);
  });

  test("leaving before the codecs are known asks nothing; an answer without a stream fails", async () => {
    const f = fakeLink({ "browser.stream": () => ({}) });
    const inbox = new TabStreamInbox(f.link);
    let resolve!: (c: ("h264" | "jpeg")[]) => void;
    const w = new TabWatch(f.link, inbox, "t1", { codecs: new Promise((r) => (resolve = r)), decoders: images(), onState: () => {}, onPicture: () => {} });
    const starting = w.start();
    await w.leave();
    resolve(["jpeg"]);
    await starting;
    expect(f.calls).toEqual([]);

    const none = watcher(f, inbox);
    await none.w.start();
    expect(none.w.state).toEqual({ kind: "failed", message: "the computer didn't start a stream" });
  });
});
