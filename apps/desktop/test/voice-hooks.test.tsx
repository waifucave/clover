// The stage's reading of the player: `useBotSpeech` follows `speaking` and hands a stable feed with the player's frames; a
// stage mounting mid-sentence is in time; nothing runs for a bot that is quiet.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, describe, expect, test } from "bun:test";
import type { VoicePiece } from "@waifucave/clover-plugin-sdk/ui/bridge";

GlobalRegistrator.register();
process.env.RTL_SKIP_AUTO_CLEANUP = "true";
const { act, cleanup, render } = await import("@testing-library/react");
const { createElement: h } = await import("react");
const { setVoiceStage, voiceStage, useBotSpeech } = await import("../src/layer/clover/voice-hooks");
const { VoiceStage } = await import("../src/layer/clover/voice");

afterAll(async () => {
  cleanup();
  await GlobalRegistrator.unregister();
});

class Src { buffer: unknown = null; onended: (() => void) | null = null; connect() {} start() {} stop() {} }
const ctx = {
  currentTime: 5, destination: {}, outputLatency: 0,
  srcs: [] as Src[],
  createBuffer: (_c: number, n: number, r: number) => ({ getChannelData: () => new Float32Array(n), duration: n / r }),
  createBufferSource() { const s = new Src(); this.srcs.push(s); return s; },
};
const pcm = (ms: number) => btoa(String.fromCharCode(...new Uint8Array(Math.round(24 * ms) * 2).map((_, i) => (i % 2 === 0 ? (i * 7) & 127 : 20))));
const piece = (seq: number, o: Partial<VoicePiece> = {}): VoicePiece => ({ bot: "luna", utterance: "u", seq, audio: pcm(100), format: "pcm16-24k", final: false, ...o });

function Probe({ bot, onFrames }: { bot: string; onFrames: (n: number) => void }) {
  const { feed, speaking } = useBotSpeech(bot);
  const seen = h("span", { "data-speaking": String(speaking) });
  // A renderer reads the feed the way the avatars do.
  (Probe as unknown as { subscribe?: () => void }).subscribe = () => feed.subscribe((f) => onFrames(f.length));
  return seen;
}

describe("useBotSpeech", () => {
  test("speaking follows the player; a stage mounted mid-sentence hears the frames still ahead", async () => {
    setVoiceStage(() => new VoiceStage({ audio: () => ctx as never }));
    const player = voiceStage();
    player.piece(piece(0, { audio: pcm(400) }));
    let frames = 0;
    const r = render(h(Probe, { bot: "luna", onFrames: (n) => (frames += n) }));
    const dot = () => r.container.querySelector("span")!.getAttribute("data-speaking");
    expect(dot()).toBe("true");
    (Probe as unknown as { subscribe: () => void }).subscribe();
    expect(frames).toBeGreaterThan(0);
    await act(async () => player.stop("luna"));
    expect(dot()).toBe("false");
    // A bot that never spoke: quiet, and no other bot's speech reaches it.
    const q = render(h(Probe, { bot: "mira", onFrames: () => undefined }));
    await act(async () => player.piece(piece(0, { utterance: "x" })));
    expect(q.container.querySelector("span")!.getAttribute("data-speaking")).toBe("false");
    expect(dot()).toBe("true");
  });
});
