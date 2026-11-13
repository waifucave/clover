// The acceptance run's third-party voice mode (spec §6.6). Chosen in Settings › Voice, it says each reply at once through
// the provider the bot uses (`voices.speak` with the reply's ticket: the provider's audio comes back to it, never its key)
// and feeds this device's player (`speech.piece`); offered sound it plays in turn (`speech.play`). Not chosen, the core
// refuses it the player and push-to-talk. No queue of its own: the run proves the slot, not this mode's manners.

type Api = {
  voices: { speak(provider: string, o: { ticket: string }, l: (e: { audio?: Uint8Array; done?: unknown; error?: string }) => void): unknown };
  speech: {
    piece(p: { bot: string; session: string; utterance: string; data: Uint8Array; final: boolean }): Promise<unknown>;
    play(p: { ticket: string }): Promise<{ seconds: number; cut: boolean }>;
  };
  audio: { play(a: { format: "pcm16-24k"; data: Uint8Array }, o?: { bot?: string }): Promise<unknown> };
};

let api: Api | undefined;
let n = 0;
const said = { replies: [] as string[], bytes: 0, sounds: 0 };

export function start(a: Api): void {
  api = a;
}

const need = (): Api => {
  if (api === undefined) throw new Error("the acceptance voice mode hasn't started");
  return api;
};

/** `seconds` of a 330 Hz tone as pcm16-24k. */
function tone(seconds: number): Uint8Array {
  const count = Math.round(seconds * 24_000);
  const out = new Uint8Array(count * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < count; i++) view.setInt16(i * 2, Math.round(Math.sin((2 * Math.PI * 330 * i) / 24_000) * 0.5 * 32767), true);
  return out;
}

export const voice = {
  async reply(args: { ticket: string; bot: string; session: string; voice: { provider: string } }) {
    const a = need();
    const utterance = `avm_${++n}`;
    await new Promise<void>((resolve) => {
      let chain: Promise<unknown> = Promise.resolve();
      a.voices.speak(args.voice.provider, { ticket: args.ticket }, (e) => {
        if (e.audio !== undefined) {
          const data = e.audio;
          said.bytes += data.length;
          chain = chain.then(() => a.speech.piece({ bot: args.bot, session: args.session, utterance, data, final: false })).catch(() => undefined);
        } else {
          chain = chain.then(() => a.speech.piece({ bot: args.bot, session: args.session, utterance, data: new Uint8Array(0), final: true })).catch(() => undefined);
          void chain.then(() => resolve());
        }
      });
    });
    said.replies.push(args.bot);
    return { queued: false };
  },
  async stop() {},
  async listenStart() {},
  async listenPiece() {
    return { text: "" };
  },
  async listenEnd() {},
  async offer(args: { ticket: string }) {
    await need().speech.play({ ticket: args.ticket });
    said.sounds++;
  },
};

/** A 0.4 s tone as Alpha's voice: through the active voice mode, in its turn. */
export const chime = async () => {
  await need().audio.play({ format: "pcm16-24k", data: tone(0.4) }, { bot: "alpha" });
  return { offered: true };
};

/** The player itself: refused unless this mode is the active voice. */
export const sink = async () => {
  try {
    await need().speech.piece({ bot: "alpha", session: "b_alpha", utterance: "avm_sink", data: new Uint8Array(2), final: true });
    return { sounded: true };
  } catch (e) {
    return { refused: e instanceof Error ? e.message : String(e) };
  }
};

export const report = async () => ({ replies: said.replies, bytes: said.bytes, sounds: said.sounds });
