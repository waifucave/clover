// Clover Voice's hold-to-talk button (`composer.action`, key `voice`): shown only while its host half says the bot's voice
// would hear; held, it takes the device's microphone turn, streams the recording to its host half, and released, sends
// the words its host half heard as the user's message, once; a refusal or nothing heard says why by the button. The
// recording comes from a test source (the build's own would be the generated clip); getUserMedia is never reached.
import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { fakeApi, settle } from "../../shell/runtime/testkit";
import { runtimeWith } from "../../shell/runtime/ui";
import { UiRuntimeProvider } from "../../shell/client/sdk";
import { TalkButton } from "../client";
import { TALK_TEXT_MAX, setTalkLimit, setTalkSource, spokenText } from "../client/talk";
import type { PluginApi } from "@waifucave/clover-plugin-sdk";
import type { BotRef, EntryProps } from "../../shell/runtime/types";

afterEach(() => {
  cleanup();
  setTalkSource(undefined);
  setTalkLimit(undefined);
});

const alpha = { props: { bot: { id: "alpha", name: "Alpha" }, session: "b_alpha" } } as unknown as EntryProps<{ bot: BotRef; session: string }>;

function world(o: { listens?: boolean; heard?: { text?: string; note?: string }; writeFails?: boolean } = {}) {
  const calls: { name: string; args: unknown }[] = [];
  const turns: string[] = [];
  const done: string[] = [];
  const written: number[] = [];
  const streams: { name: string; meta: Record<string, unknown>; closed: boolean }[] = [];
  const sent: { to: unknown; message: unknown }[] = [];
  const a = fakeApi({ pluginId: "clover/voice", settings: {} });
  const api = Object.assign(a, {
    settings: { ...a.settings, watch: () => () => undefined },
    points: { ...a.points, onActive: () => () => undefined, watch: () => () => undefined },
    turns: { ...a.turns, take: async (name: string) => { turns.push(name); return { id: "t1", done: async () => { done.push(name); }, lost: new Promise(() => undefined) }; } },
    streams: {
      open: async (name: string, opts: { meta: Record<string, unknown> }) => {
        const rec = { name, meta: opts.meta, closed: false };
        streams.push(rec);
        return { getWriter: () => ({ write: async (c: Uint8Array) => { if (o.writeFails === true) throw new Error("too long"); written.push(c.length); }, close: async () => { rec.closed = true; }, abort: async () => undefined }) };
      },
    },
    host: {
      call: async (name: string, args: unknown) => {
        calls.push({ name, args });
        if (name === "listens") return o.listens ?? true;
        if (name === "heard") return o.heard ?? { text: "hello from the clip" };
        return { ok: true };
      },
      on: () => () => undefined,
    },
  }) as unknown as PluginApi;
  render(
    <UiRuntimeProvider runtime={runtimeWith({ api: () => api, userSend: () => async (to, message) => { sent.push({ to, message }); } })}>
      <TalkButton {...alpha} />
    </UiRuntimeProvider>,
  );
  return { calls, turns, done, written, streams, sent };
}

/** A test source: two chunks at once, then nothing until stopped. */
function twoChunks(): void {
  setTalkSource(async (sink) => {
    sink.chunk(new Uint8Array(3200));
    sink.chunk(new Uint8Array(3200));
    return { stop: () => undefined };
  });
}

describe("Clover Voice's hold-to-talk button", () => {
  test("none where the bot's voice wouldn't hear; it asks for this bot in this conversation", async () => {
    const w = world({ listens: false });
    await act(() => settle(6));
    expect(screen.queryByRole("button", { name: "Hold to talk" })).toBeNull();
    expect(w.calls[0]).toEqual({ name: "listens", args: { bot: "alpha", session: "b_alpha" } });
  });

  test("held: the microphone's turn, the recording streamed to its host half; released: the words sent as the user's message, once", async () => {
    twoChunks();
    const w = world();
    await act(() => settle(6));
    const button = screen.getByRole("button", { name: "Hold to talk" });
    await act(async () => { fireEvent.pointerDown(button, { pointerId: 1, button: 0 }); await settle(6); });
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("status").textContent).toBe("Listening… release to send");
    expect(w.turns).toEqual(["device/microphone"]);
    expect(w.streams.map((s) => [s.name, s.meta.bot])).toEqual([["talk", "alpha"]]);
    expect(w.written).toEqual([3200, 3200]);
    await act(async () => { fireEvent.pointerUp(button, { pointerId: 1, button: 0 }); await settle(10); });
    expect(w.streams[0]!.closed).toBe(true);
    expect(w.done).toEqual(["device/microphone"]);
    expect(w.calls.find((c) => c.name === "heard")?.args).toEqual({ utterance: w.streams[0]!.meta.utterance });
    expect(w.sent).toEqual([{ to: { session: "b_alpha" }, message: { text: "hello from the clip" } }]);
    expect(button.getAttribute("aria-pressed")).toBe("false");
  });

  test("by key: Space held while it has the focus does the same", async () => {
    twoChunks();
    const w = world();
    await act(() => settle(6));
    const button = screen.getByRole("button", { name: "Hold to talk" });
    await act(async () => { fireEvent.keyDown(button, { key: " " }); await settle(6); });
    await act(async () => { fireEvent.keyDown(button, { key: " ", repeat: true }); await settle(2); });
    expect(w.streams).toHaveLength(1);
    await act(async () => { fireEvent.keyUp(button, { key: " " }); await settle(10); });
    expect(w.sent).toHaveLength(1);
  });

  test("nothing heard: no send, and a note says why by the button", async () => {
    twoChunks();
    const w = world({ heard: { note: "Nothing was heard." } });
    await act(() => settle(6));
    const button = screen.getByRole("button", { name: "Hold to talk" });
    await act(async () => { fireEvent.pointerDown(button, { pointerId: 1, button: 0 }); await settle(6); });
    await act(async () => { fireEvent.pointerUp(button, { pointerId: 1, button: 0 }); await settle(10); });
    expect(w.sent).toEqual([]);
    expect(screen.getByRole("note").textContent).toBe("Nothing was heard.");
  });
});

describe("it never sticks on (review item 7): a hold that ends without the user's release is dropped, nothing sent", () => {
  /** A test source that says when it is stopped. */
  function stoppable(): { stopped: () => boolean } {
    let stopped = false;
    setTalkSource(async (sink) => {
      sink.chunk(new Uint8Array(3200));
      return { stop: () => { stopped = true; } };
    });
    return { stopped: () => stopped };
  }
  const held = async () => {
    const button = screen.getByRole("button", { name: "Hold to talk" });
    await act(async () => { fireEvent.pointerDown(button, { pointerId: 1, button: 0 }); await settle(6); });
    expect(button.getAttribute("aria-pressed")).toBe("true");
    return button;
  };

  for (const [what, end] of [
    ["the window losing the focus", () => window.dispatchEvent(new Event("blur"))],
    ["the window going hidden", () => { Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true }); document.dispatchEvent(new Event("visibilitychange")); }],
    ["the button losing the focus", () => fireEvent.blur(screen.getByRole("button", { name: "Hold to talk" }))],
    ["the pointer cancelled", () => fireEvent.pointerCancel(screen.getByRole("button", { name: "Hold to talk" }), { pointerId: 1 })],
  ] as const) {
    test(what, async () => {
      const src = stoppable();
      const w = world();
      await act(() => settle(6));
      const button = await held();
      await act(async () => { end(); await settle(10); });
      Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
      expect(src.stopped()).toBe(true);
      expect(w.done).toEqual(["device/microphone"]);
      expect(w.calls.some((c) => c.name === "heard")).toBe(false);
      expect(w.sent).toEqual([]);
      expect(button.getAttribute("aria-pressed")).toBe("false");
      expect(screen.getByRole("note").textContent).toBe("Stopped: you let go elsewhere. Hold to talk again.");
    });
  }

  test("the button going away (another bot's tab)", async () => {
    const src = stoppable();
    const w = world();
    await act(() => settle(6));
    await held();
    await act(async () => { cleanup(); await settle(10); });
    expect(src.stopped()).toBe(true);
    expect(w.done).toEqual(["device/microphone"]);
    expect(w.sent).toEqual([]);
  });

  test("a release after the hold was dropped sends nothing either", async () => {
    stoppable();
    const w = world();
    await act(() => settle(6));
    const button = await held();
    await act(async () => { window.dispatchEvent(new Event("blur")); await settle(6); });
    await act(async () => { fireEvent.pointerUp(button, { pointerId: 1, button: 0 }); await settle(10); });
    expect(w.sent).toEqual([]);
  });
});

describe("what a transcription sends: one plain line, cut at TALK_TEXT_MAX, never refused for its length", () => {
  test("control, line-break, zero-width and direction characters collapse to one space, as the SDK's plainLine does", () => {
    expect(spokenText("  hi\nthere\u0007\u200b you\u202e\tok  ")).toBe("hi there you ok");
    expect(spokenText("x".repeat(5000))).toHaveLength(TALK_TEXT_MAX);
    // Never half a surrogate pair at the cut.
    expect(spokenText("a".repeat(TALK_TEXT_MAX - 1) + "\u{1F600}")).toBe("a".repeat(TALK_TEXT_MAX - 1));
  });

  test("a long, unclean transcription is sent cut and plain", async () => {
    twoChunks();
    const w = world({ heard: { text: "one\ntwo\u0000 " + "z".repeat(4000) } });
    await act(() => settle(6));
    const button = screen.getByRole("button", { name: "Hold to talk" });
    await act(async () => { fireEvent.pointerDown(button, { pointerId: 1, button: 0 }); await settle(6); });
    await act(async () => { fireEvent.pointerUp(button, { pointerId: 1, button: 0 }); await settle(10); });
    expect(w.sent).toHaveLength(1);
    const text = (w.sent[0]!.message as { text: string }).text;
    expect(text).toHaveLength(TALK_TEXT_MAX);
    expect(text.startsWith("one two " + "z")).toBe(true);
  });
});

describe("the microphone never outlives the recording", () => {
  function stoppable(): { stopped: () => boolean } {
    let stopped = false;
    setTalkSource(async (sink) => {
      // A piece once the source is open, as a microphone gives them.
      setTimeout(() => sink.chunk(new Uint8Array(3200)), 1);
      return { stop: () => { stopped = true; } };
    });
    return { stopped: () => stopped };
  }

  test("a piece the stream refuses (the host half cut it) closes the source at once, while the user still holds", async () => {
    const src = stoppable();
    const w = world({ writeFails: true });
    await act(() => settle(6));
    const button = screen.getByRole("button", { name: "Hold to talk" });
    await act(async () => { fireEvent.pointerDown(button, { pointerId: 1, button: 0 }); await settle(6); await new Promise((r) => setTimeout(r, 10)); await settle(6); });
    expect(src.stopped()).toBe(true);
    expect(w.done).toEqual(["device/microphone"]);
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("note").textContent).toBe("The recording stopped. Hold to talk again.");
    // The release that follows sends nothing.
    await act(async () => { fireEvent.pointerUp(button, { pointerId: 1, button: 0 }); await settle(10); });
    expect(w.calls.some((c) => c.name === "heard")).toBe(false);
    expect(w.sent).toEqual([]);
  });

  test("at the host half's limit (and a little past it) the source closes even with no refused piece", async () => {
    setTalkLimit(15);
    const src = stoppable();
    const w = world();
    await act(() => settle(6));
    const button = screen.getByRole("button", { name: "Hold to talk" });
    await act(async () => { fireEvent.pointerDown(button, { pointerId: 1, button: 0 }); await settle(6); });
    expect(button.getAttribute("aria-pressed")).toBe("true");
    await act(async () => { await new Promise((r) => setTimeout(r, 40)); await settle(6); });
    expect(src.stopped()).toBe(true);
    expect(w.done).toEqual(["device/microphone"]);
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("note").textContent).toBe("That was longer than a minute; hold to talk for less.");
    await act(async () => { fireEvent.pointerUp(button, { pointerId: 1, button: 0 }); await settle(10); });
    expect(w.sent).toEqual([]);
  });

  test("a release before the limit clears it: nothing is dropped afterwards", async () => {
    setTalkLimit(30);
    twoChunks();
    const w = world();
    await act(() => settle(6));
    const button = screen.getByRole("button", { name: "Hold to talk" });
    await act(async () => { fireEvent.pointerDown(button, { pointerId: 1, button: 0 }); await settle(6); });
    await act(async () => { fireEvent.pointerUp(button, { pointerId: 1, button: 0 }); await settle(10); });
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); await settle(4); });
    expect(w.sent).toHaveLength(1);
    expect(screen.queryByRole("note")).toBeNull();
  });
});
