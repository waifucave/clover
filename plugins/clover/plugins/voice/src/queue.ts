// Clover Voice's one output queue (spec §6.6): what this device's player sounds, one thing at a time.
//
// The rule:
// * One sound at a time on the device.
// * Same bot: a new reply of the bot's replaces its playing reply at once (as before the slot). Anything else for a
//   bot that is sounding waits its turn: sound a plugin plays as its voice, or a reply the user asked for with the
//   speak button. A reply waiting its turn is replaced by the bot's newer one.
// * Two bots: the second waits until the first is done, first come first served.
// * At most WAITING_SOUNDS plugins' sounds wait; past it the oldest of them goes. A reply is never dropped for room.
// * The user holding push-to-talk stops whatever is sounding at once, and nothing starts until they let go; what
//   arrives meanwhile plays after.
// * The user's stop on a bot ends what it sounds and drops what it has waiting.
//
// "Done" is when the sound ends on the player: its last piece went, and its length (pcm16-24k, from the bytes) has
// played out from its first piece, plus a little for the device's latency.

export type QueueItem =
  | { kind: "reply"; ticket: string; bot: string; session: string; asked: boolean; voice: { provider: string; voice: string; model?: string } }
  | { kind: "sound"; ticket: string; bot: string; from: string };

export interface Played {
  /** How long it sounds. */
  seconds: number;
  /** When its first piece went to the player (epoch ms), if one did. */
  firstAt?: number;
  /** Stopped, or failed, before its end. */
  cut: boolean;
}

/** What the queue drives: saying a reply, playing an offered sound, and stopping either. */
export interface QueueSpeech {
  say(item: QueueItem & { kind: "reply" }): Promise<Played>;
  play(item: QueueItem & { kind: "sound" }): Promise<Played>;
  stop(item: QueueItem): void;
}

export interface QueueClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Plugins' sounds that may wait their turn at once. */
export const WAITING_SOUNDS = 8;
/** Added to a sound's length before the next starts: what the player lags behind this half's clock. The pieces cross
 *  the core and the app before the player schedules them, and the player's first sound waits for its AudioContext to
 *  start; the acceptance run measured that lag past 250 ms on a first sound (a reply's tail cut by the next sound), so
 *  this leaves room for it: a short pause between two sounds, never one over another. */
export const LATENCY_SLACK_MS = 600;

export class VoiceQueue {
  #current: { item: QueueItem; timer?: unknown; stopped: boolean } | undefined;
  #waiting: QueueItem[] = [];
  readonly #holds = new Set<string>();
  readonly #speech: QueueSpeech;
  readonly #clock: QueueClock;
  readonly #warn: (line: string) => void;

  constructor(speech: QueueSpeech, clock: QueueClock, warn: (line: string) => void = () => {}) {
    this.#speech = speech;
    this.#clock = clock;
    this.#warn = warn;
  }

  /** What sounds now and what waits (for tests and the log). */
  get state(): { current?: QueueItem; waiting: QueueItem[]; held: boolean } {
    return { ...(this.#current === undefined ? {} : { current: this.#current.item }), waiting: [...this.#waiting], held: this.#holds.size > 0 };
  }

  /** A bot's reply (at its turn's end, or asked by the user). Whether it waits its turn. */
  reply(item: QueueItem & { kind: "reply" }): { queued: boolean } {
    const cur = this.#current;
    const held = this.#holds.size > 0;
    if (!item.asked) {
      // A newer reply of the bot's takes the place of one waiting.
      this.#waiting = this.#waiting.filter((w) => !(w.kind === "reply" && !w.asked && w.bot === item.bot));
      // Same bot, its reply playing: the newer one replaces it at once.
      if (!held && cur !== undefined && cur.item.kind === "reply" && !cur.item.asked && cur.item.bot === item.bot) {
        this.#stopCurrent();
        this.#start(item);
        return { queued: false };
      }
    }
    if (!held && this.#current === undefined) {
      this.#start(item);
      return { queued: false };
    }
    this.#waiting.push(item);
    return { queued: true };
  }

  /** A plugin's sound as a bot's voice: in its turn. */
  offer(item: QueueItem & { kind: "sound" }): { queued: boolean } {
    if (this.#holds.size === 0 && this.#current === undefined) {
      this.#start(item);
      return { queued: false };
    }
    const sounds = this.#waiting.filter((w) => w.kind === "sound");
    if (sounds.length >= WAITING_SOUNDS) {
      const oldest = sounds[0]!;
      this.#waiting = this.#waiting.filter((w) => w !== oldest);
      this.#speech.stop(oldest);
      this.#warn(`voice: ${oldest.kind === "sound" ? oldest.from : ""}'s sound for ${oldest.bot} was dropped: ${WAITING_SOUNDS} sounds were waiting`);
    }
    this.#waiting.push(item);
    return { queued: true };
  }

  /** The user's stop on a bot. */
  stop(bot: string): void {
    for (const w of this.#waiting.filter((x) => x.bot === bot)) this.#speech.stop(w);
    this.#waiting = this.#waiting.filter((w) => w.bot !== bot);
    if (this.#current?.item.bot === bot) {
      this.#stopCurrent();
      this.#pump();
    }
  }

  /** The user holds push-to-talk (`utterance`): whatever sounds stops, nothing starts. */
  hold(utterance: string): void {
    this.#holds.add(utterance);
    if (this.#current !== undefined) this.#stopCurrent();
  }

  /** They let go: what waited plays. */
  release(utterance: string): void {
    this.#holds.delete(utterance);
    this.#pump();
  }

  #stopCurrent(): void {
    const cur = this.#current;
    if (cur === undefined) return;
    cur.stopped = true;
    if (cur.timer !== undefined) this.#clock.clearTimeout(cur.timer);
    this.#current = undefined;
    this.#speech.stop(cur.item);
  }

  #start(item: QueueItem): void {
    const mine: { item: QueueItem; timer?: unknown; stopped: boolean } = { item, stopped: false };
    this.#current = mine;
    const startedAt = this.#clock.now();
    const run = item.kind === "reply" ? this.#speech.say(item) : this.#speech.play(item);
    void run.then((p) => p, (err: unknown) => {
      this.#warn(`voice: ${item.bot}'s ${item.kind} wasn't played: ${err instanceof Error ? err.message : String(err)}`);
      return { seconds: 0, cut: true } satisfies Played;
    }).then((p) => {
      if (this.#current !== mine || mine.stopped) return;
      if (p.cut || p.seconds <= 0) return this.#finish(mine);
      const ends = (p.firstAt ?? startedAt) + p.seconds * 1000 + LATENCY_SLACK_MS;
      mine.timer = this.#clock.setTimeout(() => this.#finish(mine), Math.max(0, ends - this.#clock.now()));
    });
  }

  #finish(mine: { item: QueueItem }): void {
    if (this.#current !== mine) return;
    this.#current = undefined;
    this.#pump();
  }

  #pump(): void {
    if (this.#holds.size > 0 || this.#current !== undefined) return;
    const next = this.#waiting.shift();
    if (next !== undefined) this.#start(next);
  }
}
