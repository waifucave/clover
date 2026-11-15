// Clover Voice's host half (spec §6.6): the bundled voice mode. The core hands it each reply (a ticket) and each sound
// a plugin plays as a bot's voice, and the user's push-to-talk; it says them in its one queue (`src/queue.ts`, the
// rule), through the bot's chosen provider's endpoint (`voices.speak`, `voices.listen`), and feeds this device's player
// (`speech.piece`, `speech.play`, `speech.stop`). It never sees a provider's key, and it never makes sound or hears
// the user when another voice mode is the active one (the core refuses it then).
import type { HostPluginApi, VoiceModeHandler } from "@waifucave/clover-plugin-sdk";
import { VoiceQueue, type Played, type QueueItem } from "../src/queue";

/** The most bytes one `speech.piece` carries. */
const PIECE_MAX = 1_500_000;

let api: HostPluginApi | undefined;
let queue: VoiceQueue | undefined;
let count = 0;
/** What stops each item now: its provider call and its sound. */
const stoppers = new Map<string, () => void>();
/** The push-to-talk utterances being heard: the provider's listening, its id, and what it heard. */
const hearing = new Map<string, { id: string; close: () => void; heard: Promise<string> }>();

/** A watch's unsubscribe: the function itself in a plugin host, or a promise of it where a call answers late. */
const unsubscriber = (r: unknown): (() => void) => {
  if (typeof r === "function") return r as () => void;
  let stopped = false;
  let off: (() => void) | undefined;
  void Promise.resolve(r).then((f) => {
    if (typeof f !== "function") return;
    off = f as () => void;
    if (stopped) off();
  }, () => undefined);
  return () => {
    stopped = true;
    off?.();
  };
};

const need = (): HostPluginApi => {
  if (api === undefined) throw new Error("Clover Voice hasn't started");
  return api;
};

/** Says a reply: the provider's audio, piece by piece, to the player, then its last piece. */
function say(item: QueueItem & { kind: "reply" }): Promise<Played> {
  const a = need();
  const utterance = `cv_${Date.now().toString(36)}_${(++count).toString(36)}`;
  return new Promise<Played>((resolve) => {
    let bytes = 0;
    let firstAt: number | undefined;
    let chain: Promise<unknown> = Promise.resolve();
    let ended = false;
    /** Whether the player said the utterance ended (the last piece's answer). */
    let played = false;
    const send = (data: Uint8Array, final: boolean) => {
      chain = chain.then(() => a.speech!.piece({ bot: item.bot, session: item.session, utterance, data, final })).then((r) => {
        if (final && r?.ended === true) played = true;
      }).catch(() => undefined);
    };
    const end = (cut: boolean) => {
      if (ended) return;
      ended = true;
      stoppers.delete(item.ticket);
      send(new Uint8Array(0), true);
      void chain.then(() => resolve({ seconds: bytes / 48_000, ...(firstAt === undefined ? {} : { firstAt }), cut, ended: played }));
    };
    const cancel = unsubscriber(a.voices!.speak(item.voice.provider, { ticket: item.ticket }, (e) => {
      if (e.audio !== undefined) {
        if (ended) return;
        firstAt ??= Date.now();
        bytes += e.audio.length;
        for (let at = 0; at < e.audio.length; at += PIECE_MAX) send(e.audio.subarray(at, at + PIECE_MAX), false);
      } else if (e.done !== undefined) end(false);
      else if (e.error !== undefined) end(true);
    }));
    stoppers.set(item.ticket, () => {
      cancel();
      end(true);
    });
  });
}

/** Plays a plugin's offered sound (the core holds its pieces). */
async function play(item: QueueItem & { kind: "sound" }): Promise<Played> {
  const a = need();
  const firstAt = Date.now();
  stoppers.set(item.ticket, () => void a.speech!.stop({ utterance: item.ticket }).catch(() => undefined));
  try {
    const r = await a.speech!.play({ ticket: item.ticket });
    return { seconds: r.seconds, firstAt, cut: r.cut, ended: r.ended };
  } finally {
    stoppers.delete(item.ticket);
  }
}

function q(): VoiceQueue {
  queue ??= new VoiceQueue(
    {
      say,
      play,
      stop: (item) => {
        const s = stoppers.get(item.ticket);
        if (s !== undefined) s();
      },
    },
    { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) },
    (line) => console.error(line),
  );
  return queue;
}

export function start(given: HostPluginApi): void {
  api = given;
  // A start (a restart of the host half) begins with nothing sounding and nothing waiting.
  queue = undefined;
  stoppers.clear();
  hearing.clear();
}

/** The voice mode's handler (`voiceModes`' `handler: "voice"`), as the core calls it. */
export const voice: VoiceModeHandler = {
  async reply(args) {
    return q().reply({ kind: "reply", ticket: args.ticket, bot: args.bot, session: args.session, asked: args.asked, voice: args.voice });
  },
  async stop(args) {
    q().stop(args.bot);
  },
  async listenStart(args) {
    const a = need();
    q().hold(args.utterance);
    const id = `cl_${(++count).toString(36)}`;
    let close = () => {};
    const heard = new Promise<string>((resolve, reject) => {
      close = unsubscriber(a.voices!.listen(args.voice.provider, { id, format: args.format }, (e) => {
        if (e.text !== undefined) resolve(e.text);
        else reject(new Error(e.error ?? "the voice heard nothing"));
      }));
    });
    heard.catch(() => undefined);
    hearing.set(args.utterance, { id, close, heard });
  },
  async listenPiece(args) {
    const h = hearing.get(args.utterance);
    if (h === undefined) throw new Error(`no push-to-talk ${args.utterance} is being heard`);
    await need().voices!.feed(h.id, args.data, args.final);
    if (!args.final) return {};
    try {
      return { text: await h.heard };
    } finally {
      hearing.delete(args.utterance);
      h.close();
      q().release(args.utterance);
    }
  },
  async listenEnd(args) {
    const h = hearing.get(args.utterance);
    hearing.delete(args.utterance);
    h?.close();
    q().release(args.utterance);
  },
  async offer(args) {
    q().offer({ kind: "sound", ticket: args.ticket, bot: args.bot, from: args.from });
  },
};
