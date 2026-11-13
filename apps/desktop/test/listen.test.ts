// Push-to-talk's main side (ui/listen.ts): one hold per window, opened by the user's press and nothing else; the shell's pieces
// numbered, ordered and checked here; the microphone permission answered only while a hold records.
import { describe, expect, test } from "bun:test";
import { MICROPHONE_ORIGIN, commonHeaders, layerHeaders, withMicrophone } from "../src/main/ui/documents";
import { LISTEN_GRACE_MS, LISTEN_MAX_BYTES, LISTEN_MAX_MS, ListenHolds, base64Bytes, cleanPiece, micPermission, type ListenDeps } from "../src/main/ui/listen";

const b64 = (n: number): string => Buffer.alloc(n, 1).toString("base64");

function setup(over: Partial<ListenDeps> & { answer?: (params: Record<string, unknown>) => unknown | Promise<unknown> } = {}) {
  const sent: Record<string, unknown>[] = [];
  const shell: { windowId: number; message: Record<string, unknown> }[] = [];
  const logs: string[] = [];
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  let ids = 0;
  const holds = new ListenHolds({
    shell: (windowId, message) => shell.push({ windowId, message: message as unknown as Record<string, unknown> }),
    request: async (method, params) => {
      expect(method).toBe("voice.listen");
      const p = params as Record<string, unknown>;
      sent.push(p);
      return over.answer ? over.answer(p) : p.final === true ? { text: " what a day " } : {};
    },
    log: (l) => logs.push(l),
    schedule: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return () => { t.live = false; }; },
    makeId: () => `ptt_${++ids}`,
    ...over,
  });
  return { holds, sent, shell, logs, timers, fire: (ms: number) => timers.filter((t) => t.live && t.ms === ms).forEach((t) => { t.live = false; t.fn(); }) };
}

describe("a hold, from the press to the words", () => {
  test("a press opens one: main mints the utterance, the shell is told to record with the cap, and the window's microphone opens only now", async () => {
    const t = setup();
    expect(t.holds.micAllowed(5)).toBe(false);
    expect(await t.holds.start(5, "luna")).toEqual({});
    expect(t.shell).toEqual([{ windowId: 5, message: { type: "listen", op: "start", bot: "luna", utterance: "ptt_1", maxMs: LISTEN_MAX_MS } }]);
    expect(t.holds.micAllowed(5)).toBe(true);
    expect(t.holds.micAllowed(6)).toBe(false);
  });

  test("the shell's pieces go to the core numbered from 0 for the bot main named, in order, the last final; the release answers the words, trimmed", async () => {
    const t = setup();
    await t.holds.start(5, "luna");
    // The shell names nothing but its audio: no bot, utterance or number is taken from it.
    await t.holds.piece(5, { audio: b64(16_000), final: false });
    await t.holds.piece(5, { audio: b64(16_000), final: false });
    const stopped = t.holds.stop(5);
    expect(t.shell.at(-1)!.message).toEqual({ type: "listen", op: "stop", utterance: "ptt_1" });
    expect(await t.holds.piece(5, { audio: b64(6_400), final: true })).toEqual({ text: "what a day" });
    expect(await stopped).toEqual({ text: "what a day" });
    expect(t.sent.map((p) => [p.bot, p.utterance, p.seq, p.final, p.format, base64Bytes(p.audio as string)])).toEqual([
      ["luna", "ptt_1", 0, false, "pcm16-16k", 16_000],
      ["luna", "ptt_1", 1, false, "pcm16-16k", 16_000],
      ["luna", "ptt_1", 2, true, "pcm16-16k", 6_400],
    ]);
    // The recording is over: the microphone is closed again and a late piece is refused.
    expect(t.holds.micAllowed(5)).toBe(false);
    await expect(t.holds.piece(5, { audio: b64(2), final: false })).rejects.toThrow("nothing is being recorded");
  });

  test("pieces go one after another even if the shell fires them together: piece 1 waits for piece 0's answer (the core opens the utterance on piece 0)", async () => {
    let release!: () => void;
    const first = new Promise<void>((r) => { release = r; });
    const order: string[] = [];
    const t = setup({ answer: async (p) => { order.push(`begin ${p.seq}`); if (p.seq === 0) await first; order.push(`end ${p.seq}`); return {}; } });
    await t.holds.start(5, "luna");
    const a = t.holds.piece(5, { audio: b64(100), final: false });
    const b = t.holds.piece(5, { audio: b64(100), final: false });
    await Promise.resolve();
    expect(order).toEqual(["begin 0"]);
    release();
    await Promise.all([a, b]);
    expect(order).toEqual(["begin 0", "end 0", "begin 1", "end 1"]);
  });

  test("a press that recorded nothing sends nothing to the core, and says so; a mic that couldn't open says that", async () => {
    const t = setup();
    await t.holds.start(5, "luna");
    const stopped = t.holds.stop(5);
    await t.holds.piece(5, { audio: "", final: true });
    expect(await stopped).toEqual({ note: "Nothing was recorded." });
    expect(t.sent).toEqual([]);
    await t.holds.start(5, "luna");
    const again = t.holds.stop(5);
    await t.holds.piece(5, { audio: "", final: true, problem: true });
    expect(await again).toEqual({ note: "The microphone couldn't be opened." });
    expect(t.sent).toEqual([]);
  });

  test("nothing heard says so; the core's refusal (a voice that doesn't listen, the user's no to a provider) is the note and the stream is finished", async () => {
    const quiet = setup({ answer: () => ({ text: "  " }) });
    await quiet.holds.start(5, "luna");
    const s1 = quiet.holds.stop(5);
    await quiet.holds.piece(5, { audio: b64(100), final: true });
    expect(await s1).toEqual({ note: "Nothing was heard." });

    const refused = setup({ answer: (p) => { if (p.final === false) return {}; throw new Error("Luna's voice plugin doesn't listen"); } });
    await refused.holds.start(5, "luna");
    await refused.holds.piece(5, { audio: b64(100), final: false });
    const s2 = refused.holds.stop(5);
    await expect(refused.holds.piece(5, { audio: b64(100), final: true })).rejects.toThrow("doesn't listen");
    expect(await s2).toEqual({ note: "Luna's voice plugin doesn't listen" });
    // The core's utterance gets a last, empty piece so its plugin's call ends now, not after the idle wait.
    expect(refused.sent.map((p) => [p.seq, p.final, p.audio])).toEqual([[0, false, b64(100)], [1, true, b64(100)], [2, true, ""]]);
  });
});

describe("what a piece may be", () => {
  test("audio and whether it is the last, nothing else; base64 of whole 16-bit samples, within the method's size", () => {
    expect(cleanPiece({ audio: b64(4), final: false })).toEqual({ audio: b64(4), final: false });
    expect(cleanPiece({ audio: "", final: true, problem: true })).toEqual({ audio: "", final: true, problem: true });
    for (const bad of [null, [], "x", {}, { audio: 1, final: false }, { audio: "AAAA", final: "no" }, { audio: "AAAA", final: false, bot: "luna" }, { audio: "AAAA", final: false, seq: 3 }, { audio: "AA!A", final: false }, { audio: "AAA", final: false }, { audio: b64(3), final: false }, { audio: "AAAA", final: false, problem: true }, { audio: "", final: true, problem: false }, { audio: "x".repeat(2_000_004), final: false }]) {
      expect([bad, "why" in cleanPiece(bad)]).toEqual([bad, true]);
    }
  });

  test("a bad piece, or one with no hold open in that window, reaches the core with nothing", async () => {
    const t = setup();
    await expect(t.holds.piece(5, { audio: b64(4), final: false })).rejects.toThrow("nothing is being recorded");
    await t.holds.start(5, "luna");
    await expect(t.holds.piece(6, { audio: b64(4), final: false })).rejects.toThrow("nothing is being recorded");
    await expect(t.holds.piece(5, { audio: b64(4), final: false, bot: "other" })).rejects.toThrow("nothing else");
    expect(t.sent).toEqual([]);
  });

  test("more audio than the cap's worth ends the hold", async () => {
    const t = setup();
    await t.holds.start(5, "luna");
    await t.holds.piece(5, { audio: b64(1_000_000), final: false });
    await t.holds.piece(5, { audio: b64(LISTEN_MAX_BYTES - 1_000_000), final: false });
    const stopped = t.holds.stop(5);
    await expect(t.holds.piece(5, { audio: b64(4), final: false })).rejects.toThrow("too long");
    expect(await stopped).toEqual({ note: "That recording was too long." });
  });
});

describe("how a hold ends", () => {
  test("the cap tells the shell to stop; a shell that sends no last piece is ended after the grace, the core's stream finished", async () => {
    const t = setup();
    await t.holds.start(5, "luna");
    await t.holds.piece(5, { audio: b64(100), final: false });
    t.fire(LISTEN_MAX_MS);
    expect(t.shell.at(-1)!.message).toEqual({ type: "listen", op: "stop", utterance: "ptt_1" });
    expect(t.holds.micAllowed(5)).toBe(false);
    t.fire(LISTEN_GRACE_MS);
    expect(await t.holds.stop(5)).toEqual({ note: "The recording didn't finish." });
    expect(t.sent.map((p) => [p.seq, p.final])).toEqual([[0, false], [1, true]]);
    expect(t.logs.some((l) => l.includes("sent no last piece"))).toBe(true);
  });

  test("the window closing ends it; a new press in the window ends the one before; a window with no hold answers nothing", async () => {
    const t = setup();
    expect(await t.holds.stop(5)).toEqual({});
    await t.holds.start(5, "luna");
    await t.holds.piece(5, { audio: b64(100), final: false });
    t.holds.closeWindow(5);
    expect(t.holds.micAllowed(5)).toBe(false);
    expect(t.sent.map((p) => p.final)).toEqual([false, true]);
    await t.holds.start(5, "luna");
    const older = t.holds.stop(5);
    await t.holds.start(5, "luna");
    expect(await older).toEqual({ note: "Another recording began." });
    expect(t.holds.micAllowed(5)).toBe(true);
    // The first hold's utterance is not the second's.
    expect(t.shell.filter((s) => s.message.op === "start").map((s) => s.message.utterance)).toEqual(["ptt_1", "ptt_2", "ptt_3"]);
  });

  test("a hold's outcome waits for the composer's release even if the shell already finished it (a blur, a cap)", async () => {
    const t = setup();
    await t.holds.start(5, "luna");
    await t.holds.piece(5, { audio: b64(100), final: true });
    expect(await t.holds.stop(5)).toEqual({ text: "what a day" });
    // Taken once: a second release finds nothing.
    expect(await t.holds.stop(5)).toEqual({});
  });
});

describe("the operating system's microphone", () => {
  test("a refusal is the note and the shell is never told to record", async () => {
    const t = setup({ ensureMic: async () => "Microphone access is off for Clover." });
    expect(await t.holds.start(5, "luna")).toEqual({ note: "Microphone access is off for Clover." });
    expect(t.shell).toEqual([]);
    expect(t.holds.micAllowed(5)).toBe(false);
    expect(await t.holds.stop(5)).toEqual({ note: "Microphone access is off for Clover." });
  });

  test("let go while the system was asking: nothing records, and the next press does", async () => {
    let answer!: (why: string | undefined) => void;
    const t = setup({ ensureMic: () => new Promise((r) => { answer = r; }) });
    const started = t.holds.start(5, "luna");
    const released = t.holds.stop(5);
    answer(undefined);
    expect(await started).toEqual({ note: "The microphone is allowed now. Hold to talk again." });
    expect(await released).toEqual({ note: "The microphone is allowed now. Hold to talk again." });
    expect(t.shell).toEqual([]);
  });

  test("still held when the system says yes: it records", async () => {
    let answer!: (why: string | undefined) => void;
    const t = setup({ ensureMic: () => new Promise((r) => { answer = r; }) });
    const started = t.holds.start(5, "luna");
    expect(t.holds.micAllowed(5)).toBe(false);
    answer(undefined);
    expect(await started).toEqual({});
    expect(t.holds.micAllowed(5)).toBe(true);
  });
});

describe("the window's microphone permission", () => {
  const holds = (on: number[]) => ({ micAllowed: (w: number) => on.includes(w) });
  const ask = { permission: "media", mediaTypes: ["audio"], requestingUrl: "clover-plugin://clover/doc/index.html?mount=a", windowId: 5 };
  test("yes only for audio, from the clover layer, while that window's hold records", () => {
    expect(micPermission(ask, holds([5]), "clover-plugin")).toBe(true);
    expect(micPermission(ask, holds([]), "clover-plugin")).toBe(false);
    expect(micPermission(ask, holds([6]), "clover-plugin")).toBe(false);
    expect(micPermission({ ...ask, windowId: undefined }, holds([5]), "clover-plugin")).toBe(false);
  });
  test("never a camera, a screen, another permission, another plugin's frame or another scheme, a lookalike host", () => {
    for (const q of [{ mediaTypes: ["video"] }, { mediaTypes: ["audio", "video"] }, { mediaTypes: [] }, { mediaTypes: undefined }, { permission: "display-capture" }, { permission: "geolocation" }, { requestingUrl: "clover-plugin://alpha/doc" }, { requestingUrl: "clover-plugin://clover.evil/doc" }, { requestingUrl: "https://clover/doc" }, { requestingUrl: "clover-web://clover/doc" }, { requestingUrl: "" }]) {
      expect([q, micPermission({ ...ask, ...q }, holds([5]), "clover-plugin")]).toEqual([q, false]);
    }
  });
});

describe("the documents' microphone policy: closed everywhere but the clover layer", () => {
  const policy = (h: Record<string, string>) => h["Permissions-Policy"]!;
  test("every response of the app's schemes keeps microphone=(); only the clover layer's document and the core root that frames it open it", () => {
    expect(policy(commonHeaders())).toContain("microphone=()");
    expect(policy(layerHeaders("text/html; charset=utf-8"))).toContain("microphone=()");
    expect(policy(layerHeaders("text/javascript"))).toContain("microphone=()");
    expect(policy(layerHeaders("text/html; charset=utf-8", [], [], false, true))).toContain("microphone=(self)");
    expect(policy(withMicrophone(commonHeaders(), `(self "${MICROPHONE_ORIGIN}")`))).toContain(`microphone=(self "clover-plugin://clover")`);
    // The rest of the policy is untouched: camera, screen capture and the others stay closed.
    for (const p of [policy(layerHeaders("text/html", [], [], false, true)), policy(withMicrophone(commonHeaders(), "(self)"))]) {
      for (const closed of ["camera=()", "display-capture=()", "geolocation=()"]) expect(p).toContain(closed);
    }
  });
});
