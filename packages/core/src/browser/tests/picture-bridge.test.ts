// The browser tool's picture (spec revision 19, §3.6, G5) over a fixture frame source (lane HS's `TabFrames`): published
// from inside the tool call of a session, only by a server that declares one; it is the session's, and it goes when the
// session does: the tab's subscription is let go, so a frame that comes later makes no picture.
import { describe, expect, test } from "bun:test";
import { browserPictureBridge, type TabFrame, type TabFrames } from "../picture-bridge";
import { EngineLivePictures } from "../../pictures/live-pictures";
import type { ApiCallContext } from "../../plugin-host/api/router";

const jpeg = (w = 64, h = 48): Uint8Array => Uint8Array.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 0xff, w >> 8, w & 0xff, 0x03, ...new Array(40).fill(1)]);
const frame = (w = 64, h = 48): TabFrame => ({ format: "jpeg", width: w, height: h, bytes: jpeg(w, h) });

class Source implements TabFrames {
  readonly subs = new Map<string, { fn: (f: TabFrame) => void; end?: () => void }[]>();
  subscribe(tabId: string, fn: (f: TabFrame) => void, end?: () => void) {
    const entry = { fn, ...(end ? { end } : {}) };
    this.subs.set(tabId, [...(this.subs.get(tabId) ?? []), entry]);
    return () => this.subs.set(tabId, (this.subs.get(tabId) ?? []).filter((e) => e !== entry));
  }
  emit(tabId: string, f: TabFrame) { for (const e of [...(this.subs.get(tabId) ?? [])]) e.fn(f); }
  count(tabId: string) { return (this.subs.get(tabId) ?? []).length; }
}

const manifest = (picture: boolean) => ({ contributes: { mcpServers: { browser: { type: "host", tools: { Browser: "preload" }, picture } } } });
const ctx = (session: string, picture = true): ApiCallContext =>
  ({ pluginId: "moss/browser", process: "shared", caller: { kind: "session", sessionId: session, sessionKind: "agent" }, record: { manifest: manifest(picture) }, invocation: { id: `call_${session}`, server: "browser", tool: "Browser" } }) as unknown as ApiCallContext;

function world(withSource = true) {
  const frames = new Source();
  const pictures = new EngineLivePictures({ clock: { now: () => 1 } });
  const sessions = { get: (id: string) => (id === "s_a" || id === "s_b" ? { kind: "bots" as const, bot: "alpha" } : id === "s_code" ? { kind: "sessions" as const } : undefined) };
  const drives = browserPictureBridge({ pictures, sessions, frames: withSource ? frames : undefined });
  const list = () => pictures.list("bots", { kind: "user" });
  return { frames, pictures, drives, list };
}

describe("the browser tool's picture", () => {
  test("a frame from the tab the tool drives is the session's picture, shown with its publisher; the picture's size follows the tab", () => {
    const w = world();
    w.drives(ctx("s_a"), "tab_1");
    expect(w.list()).toEqual([]);
    w.frames.emit("tab_1", frame());
    expect(w.list()).toEqual([expect.objectContaining({ session: "s_a", bot: "alpha", publisher: "moss/browser", tool: "Browser", width: 64, height: 48, screen: false })]);
    // Driving the same tab again doesn't subscribe twice; a resized tab makes a new picture, the old one ends.
    w.drives(ctx("s_a"), "tab_1");
    expect(w.frames.count("tab_1")).toBe(1);
    const first = w.list()[0]!.id;
    w.frames.emit("tab_1", frame(80, 60));
    expect(w.list().map((p) => [p.width, p.height])).toEqual([[80, 60]]);
    expect(w.list()[0]!.id).not.toBe(first);
  });

  test("no source, a server that declares no picture, an unknown session: no picture, and the tool call goes on", () => {
    const none = world(false);
    expect(() => none.drives(ctx("s_a"), "tab_1")).not.toThrow();
    const w = world();
    w.drives(ctx("s_a", false), "tab_1");
    w.drives(ctx("s_unknown"), "tab_2");
    expect(w.frames.count("tab_1") + w.frames.count("tab_2")).toBe(0);
    expect(w.list()).toEqual([]);
  });

  test("when its session ends the tab is let go: a later frame makes no picture for the ended session", () => {
    const w = world();
    w.drives(ctx("s_a"), "tab_1");
    w.drives(ctx("s_b"), "tab_1");
    w.frames.emit("tab_1", frame());
    expect(w.list().map((p) => p.session).sort()).toEqual(["s_a", "s_b"]);
    w.drives.sessionEnded("s_a");
    w.pictures.sessionEnded("s_a");
    expect(w.frames.count("tab_1")).toBe(1);
    w.frames.emit("tab_1", frame(90, 70));
    expect(w.list().map((p) => p.session)).toEqual(["s_b"]);
    // Driving the tab again from a session that is running makes its subscription once more.
    w.drives(ctx("s_a"), "tab_1");
    expect(w.frames.count("tab_1")).toBe(2);
  });

  test("the tab closing ends the picture", () => {
    const w = world();
    w.drives(ctx("s_a"), "tab_1");
    w.frames.emit("tab_1", frame());
    for (const e of w.frames.subs.get("tab_1")!) e.end?.();
    expect(w.list()).toEqual([]);
  });
});
