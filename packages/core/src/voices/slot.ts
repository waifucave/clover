// The voice slot (spec §6.6): one voice mode, of those installed, is active on this device, and it alone makes the
// bots' sound and hears the user: it says their replies, plays sound other plugins play as their voices, and hears
// push-to-talk. Clover Voice (`clover/voice`) is the bundled one; another plugin that contributes `voiceModes` takes its
// place when the user chooses it (Settings › Voice). The player stays the app's: one sink per device, which only the
// active voice feeds (`speech.*`), so nothing talks over it.
//
// * Which is active: the user's choice (Clover Voice's `active` setting) when that mode is on and running here; else
//   Clover Voice; else the first voice mode that is; else none, and bots are text-only. When the user's choice stops
//   (turned off, removed, stopped, crashed), voice falls back and the user is told once, in words.
// * Replies go to the active mode as tickets: the text stays here; the mode says it through a provider
//   (`voices.speak` with the ticket, the bot's provider check first) and feeds the player itself. Sound a plugin plays
//   as a bot's voice (`audio.play`) is held here and offered the same way (`speech.play` plays it in its turn).
// * Push-to-talk goes to the active mode: its start (nothing sounds meanwhile), each piece, and the last, whose answer
//   is what the provider heard. A copy still goes to `audio.onRecording`, never to an inactive voice mode.
// * The providers' endpoints (`voices.*`): their `voices` entries, called by any plugin with `voices.use` and by any
//   voice mode, the core carrying the calls and the provider placing its own key; each caller gets the audio or text
//   back as its own, at most VOICES_CALLS_PER_PLUGIN open at once, each use logged with the caller's id.
// * The user's own stop is the core's too: whatever the mode does, the bot's sound ends.
import { BUNDLED_ROOT_PLUGIN, topPluginIdOf } from "@waifucave/clover-protocol";
import { randomUUID } from "node:crypto";
import { ContractError } from "../contracts/common";
import type { PluginHost } from "../contracts/plugin-host";
import type { PluginRegistry } from "../contracts/plugin-registry";
import { listenerArg, stringArg, type ApiCallContext, type ApiHandlers } from "../plugin-host/api/router";
import type { RecordingPiece, VoicePlay, VoiceService } from "./service";

/** Clover Voice: the bundled voice mode. */
export const CLOVER_VOICE = `${BUNDLED_ROOT_PLUGIN}/voice`;
/** How long a ticket waits for its mode to use it. */
export const TICKET_TTL_MS = 10 * 60_000;
/** How long the user's speak button waits for the first piece before it answers that the voice is speaking. */
export const ASKED_WAIT_MS = 15_000;
/** The most an offered sound holds before its mode plays it. */
export const OFFER_MAX_BYTES = 32 * 1024 * 1024;
/** Provider calls (`voices.speak`, `voices.listen`) one plugin may have open at once. */
export const VOICES_CALLS_PER_PLUGIN = 4;
/** A `voices.speak` text, at most. */
export const VOICES_TEXT_MAX = 16_000;
/** How long a push-to-talk utterance waits for its next piece before it is dropped. */
export const LISTEN_IDLE_MS = 30_000;
/** How long past a sound's own length its end waits for the player's report (`voice.played`) before it counts as ended
 *  anyway: a device with no window, or a player that never reports. */
export const PLAYED_GRACE_MS = 3_000;

export interface VoiceSlotOptions {
  registry: Pick<PluginRegistry, "entries"> & Partial<Pick<PluginRegistry, "get">>;
  host: Pick<PluginHost, "invoke">;
  service: VoiceService;
  /** The user's choice of voice mode (Clover Voice's `active` setting), read at each use. */
  chosen?(): Promise<string | undefined> | string | undefined;
  /** Tells the user something in words (a notification): the fallback when their voice stops. */
  tell?(text: string): void;
  log?(line: string): void;
  warn?(message: string): void;
  now?(): number;
  listenIdleMs?: number;
  /** `PLAYED_GRACE_MS` (tests shorten it). */
  playedGraceMs?: number;
}

export interface VoiceModeView {
  pluginId: string;
  id: string;
  name: string;
  handler: string;
}

type ReplyTicket = { id: string; owner: string; kind: "reply"; bot: string; session: string; text: string; asked: boolean; at: number; first?: () => void; done?: (r: { bytes: number; cut: boolean } | { err: unknown }) => void };
type AudioTicket = { id: string; owner: string; kind: "audio"; bot: string; session: string; from: string; utterance: string; at: number; pieces: VoicePlay[]; bytes: number; final: boolean; playing: boolean; stopped: boolean; wake?: () => void };
type Ticket = ReplyTicket | AudioTicket;

/** A push-to-talk utterance in the active mode's hands. */
interface Hearing {
  bot: string;
  mode: VoiceModeView;
  next: number;
  idle?: ReturnType<typeof setTimeout>;
}

const textOf = (name: unknown): string | undefined => (typeof name === "string" ? name : typeof (name as { en?: unknown } | undefined)?.en === "string" ? (name as { en: string }).en : undefined);
/** pcm16-24k: two bytes a sample, 24,000 samples a second. */
const secondsOf = (bytes: number): number => bytes / 48_000;
const UTTERANCE = /^[A-Za-z0-9_-]{1,64}$/;
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export class VoiceSlot {
  readonly #o: VoiceSlotOptions;
  readonly #tickets = new Map<string, Ticket>();
  /** The audio tickets by the utterance their plugin named in `audio.play`. */
  readonly #offered = new Map<string, AudioTicket>();
  /** The mode's own utterances sounding now (`speech.piece`), by name: whose bot, and the next seq. */
  readonly #sounding = new Map<string, { bot: string; session: string; seq: number; bytes: number; firstAt: number }>();
  /** Utterances whose last piece went to the player and whose end waits for its report (`voice.played`), by the
   *  utterance the player was sent. */
  readonly #ends = new Map<string, { bot: string; ended: (byPlayer: boolean) => void }>();
  /** Push-to-talk utterances in the active mode's hands. */
  readonly #hearing = new Map<string, Hearing>();
  /** Open provider calls, per plugin, and the open listenings by caller and id. */
  readonly #open = new Map<string, number>();
  readonly #listens = new Map<string, ReturnType<VoiceService["providerListen"]>>();
  /** The active mode last resolved (cached for the synchronous checks). */
  #active: VoiceModeView | undefined;
  readonly #told = new Set<string>();
  /** A reply that wasn't spoken is said once per bot and reason. */
  readonly #warned = new Set<string>();

  constructor(o: VoiceSlotOptions) {
    this.#o = o;
  }

  /** The voice modes on and running here (their `voiceModes` entries that are active), in install order. */
  modes(): VoiceModeView[] {
    const out: VoiceModeView[] = [];
    for (const c of this.#o.registry.entries("voiceModes")) {
      if (c.state !== "active" || c.entryId === undefined) continue;
      const v = c.value as { handler?: unknown; name?: unknown };
      if (typeof v.handler !== "string") continue;
      out.push({ pluginId: c.pluginId, id: c.entryId, name: textOf(v.name) ?? c.entryId, handler: v.handler });
    }
    return out;
  }

  /** The active voice mode now, or undefined (text-only). */
  async active(): Promise<VoiceModeView | undefined> {
    const modes = this.modes();
    let chosen: string | undefined;
    try {
      chosen = (await this.#o.chosen?.()) ?? undefined;
    } catch {
      chosen = undefined;
    }
    if (chosen === "") chosen = undefined;
    const pick = (chosen !== undefined ? modes.find((m) => m.pluginId === chosen) : undefined) ?? modes.find((m) => m.pluginId === CLOVER_VOICE) ?? modes[0];
    // The user's choice stopped (off, removed, stopped, crashed): they hear of it once, in words.
    if (chosen !== undefined && pick?.pluginId !== chosen) {
      const key = `${chosen}\u0000${pick?.pluginId ?? ""}`;
      if (!this.#told.has(key)) {
        this.#told.add(key);
        const was = this.#active?.pluginId === chosen ? this.#active.name : chosen;
        this.#o.tell?.(pick === undefined ? `${was} isn't running, so your bots are text-only for now.` : `${was} isn't running, so ${pick.name} speaks for your bots for now.`);
        this.#o.warn?.(`voice: ${chosen} is chosen but isn't running here; ${pick === undefined ? "text-only" : `${pick.pluginId} speaks`}`);
      }
    } else if (chosen !== undefined) {
      for (const k of [...this.#told]) if (k.startsWith(`${chosen}\u0000`)) this.#told.delete(k);
    }
    this.#active = pick;
    return pick;
  }

  /** Whether `pluginId` is a voice mode that isn't the active one (it neither speaks nor hears), from the last
   *  resolution (`audio.onRecording`'s delivery is synchronous). */
  inactiveMode(pluginId: string): boolean {
    return this.modes().some((m) => m.pluginId === pluginId) && this.#active?.pluginId !== pluginId;
  }

  /** Whether a push-to-talk would reach a listening voice for `bot` (`voice.status`). */
  async listens(bot: string): Promise<boolean> {
    if ((await this.active()) === undefined) return false;
    return this.#o.service.listens(bot);
  }

  #ticket(t: Ticket): string {
    this.#sweep();
    this.#tickets.set(t.id, t);
    return t.id;
  }

  #sweep(): void {
    const now = (this.#o.now ?? Date.now)();
    for (const [id, t] of this.#tickets) {
      if (now - t.at <= TICKET_TTL_MS || (t.kind === "audio" && t.playing)) continue;
      this.#tickets.delete(id);
      if (t.kind === "audio") this.#offered.delete(t.utterance);
      else t.done?.({ bytes: 0, cut: true });
    }
  }

  #drop(id: string): void {
    const t = this.#tickets.get(id);
    this.#tickets.delete(id);
    if (t?.kind === "audio") this.#offered.delete(t.utterance);
  }

  async #call<R>(mode: VoiceModeView, method: string, args: unknown): Promise<R> {
    return this.#o.host.invoke<R>({ pluginId: mode.pluginId, handler: mode.handler, method, args, caller: { kind: "core" } });
  }

  #voiceArg(bot: string): { provider: string; voice: string; model?: string } {
    const v = this.#o.service.voiceOf(bot);
    if (v === undefined) throw new ContractError("refused", `${bot} has no voice; it is text-only`);
    return { provider: v.provider, voice: v.voice, ...(v.model === undefined ? {} : { model: v.model }) };
  }

  /** A reply of a bot's main conversation, at its turn's end (`speakReplies`): to the active mode, which says it in its
   *  turn. Refused (text-only) when no voice mode is on or the bot has no voice. */
  async reply(o: { bot: string; session: string; text: string }): Promise<void> {
    const mode = await this.active();
    if (mode === undefined) throw new ContractError("refused", "no voice is on: turn on Clover Voice (or another voice) in Settings › Plugins to hear your bots");
    const voice = this.#voiceArg(o.bot);
    const ticket = this.#ticket({ id: `vt_${randomUUID()}`, owner: mode.pluginId, kind: "reply", bot: o.bot, session: o.session, text: o.text, asked: false, at: (this.#o.now ?? Date.now)() });
    await this.#call(mode, "reply", { ticket, bot: o.bot, session: o.session, asked: false, voice });
  }

  /** The user's speak button on one past reply (`voice.speak`): the user's own provider check (a card, if one is
   *  needed, never holds the answer), then the active mode says it in its turn. Answers once its first piece went, it
   *  waits its turn, or with a short note when nothing will be spoken. */
  async asked(o: { bot: string; session: string; text: string; waitMs?: number }): Promise<{ speaking: boolean; note?: string }> {
    const voice = this.#o.service.voiceOf(o.bot);
    if (!voice) return { speaking: false, note: "This bot has no voice. Choose one in its settings to hear its replies." };
    let entry: { speak: boolean; name?: string };
    try {
      entry = this.#o.service.entryOf(voice.provider);
    } catch {
      return { speaking: false, note: "Its voice plugin isn't installed or is turned off, so this reply can't be spoken." };
    }
    if (!entry.speak) return { speaking: false, note: "Its voice plugin only listens; it doesn't speak." };
    const mode = await this.active();
    if (mode === undefined) return { speaking: false, note: "No voice is on: turn on Clover Voice in Settings › Plugins to hear your bots." };
    let asking!: () => void;
    const askedCard = new Promise<"asking">((resolve) => { asking = () => resolve("asking"); });
    const check = this.#o.service.mayUse(o.bot, { origin: "user", onAsk: () => asking() });
    const verdict = await Promise.race([check, askedCard]);
    const hand = async () => {
      let first!: () => void;
      let done!: (r: { bytes: number; cut: boolean } | { err: unknown }) => void;
      const started = new Promise<"started">((resolve) => { first = () => resolve("started"); });
      const ended = new Promise<{ bytes: number; cut: boolean } | { err: unknown }>((resolve) => { done = resolve; });
      const ticket = this.#ticket({ id: `vt_${randomUUID()}`, owner: mode.pluginId, kind: "reply", bot: o.bot, session: o.session, text: o.text, asked: true, at: (this.#o.now ?? Date.now)(), first, done });
      const r = await this.#call<{ queued?: unknown } | undefined>(mode, "reply", { ticket, bot: o.bot, session: o.session, asked: true, voice: this.#voiceArg(o.bot) });
      return { queued: r?.queued === true, first: started, done: ended };
    };
    if (verdict === "asking") {
      void check.then((v) => { if (v.ok) void hand().catch((err: unknown) => this.#o.warn?.(`${o.bot}'s reply wasn't spoken: ${errText(err)}`)); }, () => undefined);
      return { speaking: false, note: `Answer the card to let ${entry.name?.trim() || voice.provider} speak.`.slice(0, 300) };
    }
    if (!verdict.ok) return { speaking: false, note: verdict.reason.slice(0, 300) };
    const h = await hand();
    if (h.queued) return { speaking: true };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const slow = new Promise<"slow">((resolve) => { timer = setTimeout(() => resolve("slow"), o.waitMs ?? ASKED_WAIT_MS); });
    try {
      const r = await Promise.race([h.first, slow, h.done]);
      if (r === "started" || r === "slow") return { speaking: true };
      if ("err" in r) return { speaking: false, note: `Its voice couldn't speak this reply: ${errText(r.err)}`.slice(0, 300) };
      if (r.cut) return { speaking: false, note: "Stopped before it began." };
      return r.bytes > 0 ? { speaking: true } : { speaking: false, note: "Its voice sent no sound for this reply." };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** The app's player says an utterance it was sent has ended (`voice.played`): its wait ends now. An utterance the
   *  core isn't waiting on, or another bot's, is ignored; nothing starts from it. */
  played(bot: string, utterance: string): void {
    const e = this.#ends.get(utterance);
    if (e === undefined || e.bot !== bot) return;
    e.ended(true);
  }

  /** Waits for the player's report that `utterance` ended, or for its deadline: its length from `firstAt`, plus
   *  PLAYED_GRACE_MS. Whether the player said so. */
  #awaitEnd(utterance: string, bot: string, firstAt: number, bytes: number): Promise<boolean> {
    this.#ends.get(utterance)?.ended(false);
    return new Promise<boolean>((resolve) => {
      const ms = Math.max(0, firstAt + secondsOf(bytes) * 1000 + (this.#o.playedGraceMs ?? PLAYED_GRACE_MS) - this.#now());
      const timer = setTimeout(() => entry.ended(false), ms);
      (timer as { unref?: () => void }).unref?.();
      const entry = {
        bot,
        ended: (byPlayer: boolean) => {
          if (this.#ends.get(utterance) === entry) this.#ends.delete(utterance);
          clearTimeout(timer);
          resolve(byPlayer);
        },
      };
      this.#ends.set(utterance, entry);
    });
  }

  #now(): number {
    return (this.#o.now ?? Date.now)();
  }

  /** The user's stop on a bot (`voice.stop`): the core ends what it sounds whatever the mode does, and the mode drops
   *  what the bot has waiting. */
  async stop(bot: string): Promise<void> {
    this.#o.service.stop(bot);
    await this.#silence(bot);
    const mode = await this.active();
    if (mode !== undefined) await this.#call(mode, "stop", { bot }).catch((err: unknown) => this.#o.warn?.(`voice: ${mode.pluginId}'s stop failed: ${errText(err)}`));
  }

  /** Ends what `bot` sounds through the sink now: its mode's utterances (their last piece goes) and offered sound. */
  async #silence(bot: string): Promise<void> {
    for (const [utterance, s] of [...this.#sounding]) {
      if (s.bot !== bot) continue;
      this.#sounding.delete(utterance);
      await this.#o.service.sendPiece({ bot, session: s.session, utterance, seq: s.seq, audio: "", format: "pcm16-24k", final: true }).catch(() => undefined);
    }
    for (const t of this.#offered.values()) if (t.bot === bot && t.playing) this.#stopOffered(t);
  }

  /** One push-to-talk piece (`voice.listen`): to the active mode (its start first: nothing sounds meanwhile), and a
   *  copy to `audio.onRecording`. The last piece's answer is what the mode's provider heard. */
  async listen(p: { bot: string; utterance: string; seq: number; audio: string; format: "pcm16-16k" | "opus"; final: boolean }): Promise<{ text?: string }> {
    let h = this.#hearing.get(p.utterance);
    if (h === undefined) {
      if (p.seq !== 0) throw new ContractError("invalid", `utterance ${p.utterance} starts at piece 0, not ${p.seq}`);
      const voice = this.#voiceArg(p.bot);
      const mode = await this.active();
      if (mode === undefined) throw new ContractError("refused", "no voice is on: turn on Clover Voice (or another voice) in Settings › Plugins to talk to your bots");
      // Push-to-talk: the user is talking to the bot.
      const verdict = await this.#o.service.mayUse(p.bot, { origin: "user" });
      if (!verdict.ok) throw new ContractError("refused", verdict.reason);
      await this.#call(mode, "listenStart", { bot: p.bot, utterance: p.utterance, format: p.format, voice });
      h = { bot: p.bot, mode, next: 0 };
      this.#hearing.set(p.utterance, h);
    }
    if (h.bot !== p.bot) throw new ContractError("invalid", `utterance ${p.utterance} is ${h.bot}'s`);
    if (p.seq !== h.next) throw new ContractError("invalid", `utterance ${p.utterance} expected piece ${h.next}, not ${p.seq}`);
    h.next++;
    if (h.idle !== undefined) clearTimeout(h.idle);
    h.idle = undefined;
    const data = new Uint8Array(Buffer.from(p.audio, "base64"));
    this.#o.service.hearRecording({ bot: p.bot, utterance: p.utterance, format: p.format, data, final: p.final } satisfies RecordingPiece);
    if (!p.final) {
      await this.#call(h.mode, "listenPiece", { bot: p.bot, utterance: p.utterance, data, final: false });
      const hearing = h;
      const idleMs = this.#o.listenIdleMs ?? LISTEN_IDLE_MS;
      h.idle = setTimeout(() => {
        if (this.#hearing.get(p.utterance) !== hearing) return;
        this.#hearing.delete(p.utterance);
        void this.#call(hearing.mode, "listenEnd", { bot: p.bot, utterance: p.utterance }).catch(() => undefined);
        this.#o.warn?.(`${p.bot}'s utterance ${p.utterance} was dropped: no piece came for ${Math.round(idleMs / 1000)} s`);
      }, idleMs);
      (h.idle as { unref?: () => void }).unref?.();
      return {};
    }
    this.#hearing.delete(p.utterance);
    const r = await this.#call<{ text?: unknown } | undefined>(h.mode, "listenPiece", { bot: p.bot, utterance: p.utterance, data, final: true });
    return { text: typeof r?.text === "string" ? r.text : "" };
  }

  /** One piece of sound a plugin plays as a bot's voice (`audio.play`, numbered by the core's audio area): held for the
   *  active mode, which plays it in its turn; its first piece offers it to the mode. */
  async offerPiece(from: string, p: VoicePlay): Promise<void> {
    let t = this.#offered.get(p.utterance);
    if (t === undefined) {
      if (p.seq !== 0) return; // an utterance already played out, or dropped: its late pieces go nowhere
      const mode = await this.active();
      if (mode === undefined) throw new ContractError("refused", "no voice is on: turn on Clover Voice (or another voice) in Settings › Plugins to play sound as a bot");
      t = { id: `vt_${randomUUID()}`, owner: mode.pluginId, kind: "audio", bot: p.bot, session: p.session, from, utterance: p.utterance, at: (this.#o.now ?? Date.now)(), pieces: [], bytes: 0, final: false, playing: false, stopped: false };
      this.#ticket(t);
      this.#offered.set(p.utterance, t);
      const ticket = t.id;
      void this.#call(mode, "offer", { ticket, bot: p.bot, from }).catch((err: unknown) => {
        this.#o.warn?.(`voice: ${mode.pluginId} didn't take ${from}'s sound: ${errText(err)}`);
        this.#drop(ticket);
      });
    }
    if (t.stopped) return;
    const size = Math.floor(p.audio.length * 0.75);
    if (!t.playing && t.bytes + size > OFFER_MAX_BYTES) throw new ContractError("refused", `a sound waiting its turn holds at most ${OFFER_MAX_BYTES} bytes`);
    t.bytes += size;
    t.pieces.push(p);
    if (p.final) t.final = true;
    t.wake?.();
  }

  #stopOffered(t: AudioTicket): void {
    t.stopped = true;
    t.wake?.();
  }

  /** The providers' endpoints may be called by a plugin with `voices.use`, or by a voice mode. */
  #mayUseProviders(ctx: ApiCallContext): void {
    if (ctx.record.granted.includes("voices.use")) return;
    if (this.#o.registry.entries("voiceModes").some((c) => c.pluginId === ctx.pluginId && c.state === "active")) return;
    throw new ContractError("refused", "voices.* needs the capability voices.use, which this plugin's OK doesn't list");
  }

  /** One more provider call open for `pluginId`, or refused past the cap; the release. */
  #reserve(pluginId: string): () => void {
    const n = this.#open.get(pluginId) ?? 0;
    if (n >= VOICES_CALLS_PER_PLUGIN) throw new ContractError("refused", `${pluginId} has ${VOICES_CALLS_PER_PLUGIN} voice provider calls open, the most one plugin may; let one end first`);
    this.#open.set(pluginId, n + 1);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const left = (this.#open.get(pluginId) ?? 1) - 1;
      if (left <= 0) this.#open.delete(pluginId);
      else this.#open.set(pluginId, left);
    };
  }

  /** The `speech.*` sink (the active mode's alone; `modes` any voice mode's and Clover's pages') and the providers'
   *  endpoints (`voices.*`). */
  apiHandlers(): ApiHandlers {
    const mine = async (ctx: ApiCallContext): Promise<VoiceModeView> => {
      const mode = await this.active();
      if (mode === undefined || mode.pluginId !== ctx.pluginId) throw new ContractError("refused", `${ctx.pluginId} isn't the active voice; choose it in Settings › Voice`);
      return mode;
    };
    const log = (line: string) => (this.#o.log ?? this.#o.warn)?.(line);
    return {
      "speech.modes": async (ctx) => {
        if (topPluginIdOf(ctx.pluginId) !== BUNDLED_ROOT_PLUGIN && !this.#o.registry.entries("voiceModes").some((c) => c.pluginId === ctx.pluginId)) {
          throw new ContractError("refused", `${ctx.pluginId} isn't a voice mode`);
        }
        const active = await this.active();
        return this.modes().map((m) => ({ pluginId: m.pluginId, id: m.id, name: m.name, active: m.pluginId === active?.pluginId }));
      },
      "speech.piece": async (ctx, args) => {
        await mine(ctx);
        const p = (args[0] ?? {}) as { bot?: unknown; session?: unknown; utterance?: unknown; data?: unknown; final?: unknown };
        const bot = stringArg([p.bot], 0, "the bot", 128);
        const session = stringArg([p.session], 0, "the session", 128);
        const utterance = typeof p.utterance === "string" && UTTERANCE.test(p.utterance) ? p.utterance : undefined;
        if (utterance === undefined) throw new ContractError("invalid", "an utterance is 1 to 64 letters, digits, _ or -");
        if (!(p.data instanceof Uint8Array)) throw new ContractError("invalid", "a piece's data is bytes (pcm16-24k)");
        if (p.data.length > 1_500_000) throw new ContractError("invalid", "a piece is at most 1,500,000 bytes");
        const key = `${ctx.pluginId}:${utterance}`;
        let s = this.#sounding.get(key);
        if (s === undefined) {
          s = { bot, session, seq: 0, bytes: 0, firstAt: this.#now() };
          this.#sounding.set(key, s);
        } else if (s.bot !== bot) throw new ContractError("invalid", `utterance ${utterance} is ${s.bot}'s`);
        const final = p.final === true;
        if (final) this.#sounding.delete(key);
        s.bytes += p.data.length;
        // The last piece's answer waits for the player to say the utterance ended (or for its deadline).
        const ended = final ? this.#awaitEnd(key, bot, s.firstAt, s.bytes) : undefined;
        try {
          await this.#o.service.sendPiece({ bot, session, utterance: key, seq: s.seq++, audio: Buffer.from(p.data).toString("base64"), format: "pcm16-24k", final });
        } catch (err) {
          // The player can't be reached: said once per bot and reason (the mode's own speech is the bot's reply).
          if (!this.#warned.has(`${bot}\u0000${errText(err)}`)) {
            this.#warned.add(`${bot}\u0000${errText(err)}`);
            this.#o.warn?.(`${bot}'s reply wasn't spoken: ${errText(err)}`);
          }
          this.#ends.get(key)?.ended(false);
          throw err;
        }
        return ended === undefined ? null : { ended: await ended };
      },
      "speech.play": async (ctx, args) => {
        await mine(ctx);
        const id = (args[0] as { ticket?: unknown } | undefined)?.ticket;
        const t = typeof id === "string" ? this.#tickets.get(id) : undefined;
        if (t === undefined || t.owner !== ctx.pluginId || t.kind !== "audio") throw new ContractError("not_found", "no such sound of yours to play (each ticket is used once, within 10 minutes)");
        if (t.playing) throw new ContractError("invalid", "that sound is already playing");
        t.playing = true;
        let sent = 0;
        let bytes = 0;
        let seq = 0;
        let ended = false;
        const firstAt = this.#now();
        let played: Promise<boolean> | undefined;
        try {
          for (;;) {
            if (t.stopped) break;
            const next = t.pieces[sent];
            if (next !== undefined) {
              sent++;
              bytes += Math.floor(next.audio.length * 0.75);
              if (next.final) played = this.#awaitEnd(t.utterance, t.bot, firstAt, bytes);
              await this.#o.service.sendPiece({ ...next, seq: seq++ });
              if (next.final) { ended = true; break; }
              continue;
            }
            if (t.final) break;
            await new Promise<void>((resolve) => { t.wake = resolve; });
            t.wake = undefined;
          }
        } finally {
          if (!ended) {
            played = this.#awaitEnd(t.utterance, t.bot, firstAt, bytes);
            await this.#o.service.sendPiece({ bot: t.bot, session: t.session, utterance: t.utterance, seq: seq++, audio: "", format: t.pieces[0]?.format ?? "pcm16-24k", final: true }).catch(() => this.#ends.get(t.utterance)?.ended(false));
          }
          this.#drop(t.id);
        }
        return { bytes, seconds: secondsOf(bytes), cut: t.stopped, ended: await (played ?? Promise.resolve(false)) };
      },
      "speech.stop": async (ctx, args) => {
        await mine(ctx);
        const req = (args[0] ?? {}) as { utterance?: unknown; bot?: unknown };
        if (typeof req.utterance === "string") {
          const key = `${ctx.pluginId}:${req.utterance}`;
          const s = this.#sounding.get(key);
          if (s !== undefined) {
            this.#sounding.delete(key);
            await this.#o.service.sendPiece({ bot: s.bot, session: s.session, utterance: key, seq: s.seq, audio: "", format: "pcm16-24k", final: true });
          }
          for (const t of this.#tickets.values()) if (t.kind === "audio" && t.owner === ctx.pluginId && t.id === req.utterance) this.#stopOffered(t);
        }
        if (typeof req.bot === "string") {
          this.#o.service.stop(req.bot);
          await this.#silence(req.bot);
        }
        return null;
      },
      "voices.providers": async (ctx) => {
        if (topPluginIdOf(ctx.pluginId) !== BUNDLED_ROOT_PLUGIN) this.#mayUseProviders(ctx);
        return this.#o.service.providers();
      },
      "voices.speak": (ctx, args) => {
        this.#mayUseProviders(ctx);
        const provider = stringArg(args, 0, "the provider", 128);
        const req = (args[1] ?? {}) as { ticket?: unknown; text?: unknown; voice?: unknown; model?: unknown };
        const listener = listenerArg<{ audio?: Uint8Array; done?: { bytes: number }; error?: string }>(args, 2);
        let text: string;
        let reply: ReplyTicket | undefined;
        if (typeof req.ticket === "string") {
          const t = this.#tickets.get(req.ticket);
          if (t === undefined || t.owner !== ctx.pluginId || t.kind !== "reply") throw new ContractError("not_found", "no such reply of yours to say (each ticket is used once, within 10 minutes)");
          // A reply is the active voice mode's to say, and only while it is the active one.
          if (this.#active?.pluginId !== ctx.pluginId) throw new ContractError("refused", `${ctx.pluginId} isn't the active voice; choose it in Settings › Voice`);
          this.#drop(t.id);
          reply = t;
          text = t.text;
        } else if (typeof req.text === "string" && req.text.trim() !== "") {
          if (req.text.length > VOICES_TEXT_MAX) throw new ContractError("invalid", `a text is at most ${VOICES_TEXT_MAX} characters`);
          text = req.text;
        } else throw new ContractError("invalid", "voices.speak takes a reply's ticket or a text");
        const own = reply === undefined ? undefined : this.#o.service.voiceOf(reply.bot);
        const voice = typeof req.voice === "string" ? req.voice : own?.voice;
        if (voice === undefined) throw new ContractError("invalid", "voices.speak takes the voice to speak with");
        const model = typeof req.model === "string" ? req.model : own?.provider === provider ? own.model : undefined;
        const entry = this.#o.service.entryOf(provider);
        if (!entry.speak) throw new ContractError("refused", `the voice plugin "${provider}" doesn't speak`);
        const release = this.#reserve(ctx.pluginId);
        const abort = new AbortController();
        void (async () => {
          try {
            // A reply's bot gets the user's provider check (its own turn's origin, or the user's when they asked).
            if (reply !== undefined) {
              const verdict = await this.#o.service.mayUse(reply.bot, reply.asked ? { origin: "user" } : { session: reply.session });
              if (!verdict.ok) throw new ContractError("refused", verdict.reason);
            }
            let first = true;
            const r = await this.#o.service.providerSpeak({ provider, text, voice, ...(model === undefined ? {} : { model }), signal: abort.signal }, (audio) => {
              if (first) { first = false; reply?.first?.(); }
              listener({ audio });
            });
            reply?.done?.({ bytes: r.bytes, cut: abort.signal.aborted });
            log(`voice: ${ctx.pluginId} had ${provider} speak ${text.length} characters (${r.bytes} bytes of audio${reply === undefined ? "" : `, ${reply.bot}'s reply`})`);
            if (!abort.signal.aborted) listener({ done: { bytes: r.bytes } });
          } catch (err) {
            reply?.done?.({ err });
            if (reply !== undefined && !this.#warned.has(`${reply.bot}\u0000${errText(err)}`)) {
              this.#warned.add(`${reply.bot}\u0000${errText(err)}`);
              this.#o.warn?.(`${reply.bot}'s reply wasn't spoken: ${errText(err)}`);
            }
            if (!abort.signal.aborted) listener({ error: errText(err).slice(0, 500) });
          } finally {
            release();
          }
        })();
        return () => abort.abort();
      },
      "voices.listen": (ctx, args) => {
        this.#mayUseProviders(ctx);
        const provider = stringArg(args, 0, "the provider", 128);
        const req = (args[1] ?? {}) as { id?: unknown; format?: unknown };
        const listener = listenerArg<{ text?: string; error?: string }>(args, 2);
        const id = typeof req.id === "string" && UTTERANCE.test(req.id) ? req.id : undefined;
        if (id === undefined) throw new ContractError("invalid", "a listening's id is 1 to 64 letters, digits, _ or -");
        if (req.format !== "pcm16-16k" && req.format !== "opus") throw new ContractError("invalid", "a listening's format is pcm16-16k or opus");
        const key = `${ctx.pluginId}\u0000${id}`;
        if (this.#listens.has(key)) throw new ContractError("invalid", `a listening ${id} is already open`);
        const release = this.#reserve(ctx.pluginId);
        let l: ReturnType<VoiceService["providerListen"]>;
        try {
          l = this.#o.service.providerListen({ provider, format: req.format });
        } catch (err) {
          release();
          throw err;
        }
        this.#listens.set(key, l);
        let closed = false;
        void l.result.then((text) => {
          log(`voice: ${ctx.pluginId} had ${provider} transcribe (${text.length} characters)`);
          if (!closed) listener({ text });
        }, (err: unknown) => {
          if (!closed) listener({ error: errText(err).slice(0, 500) });
        }).finally(() => {
          this.#listens.delete(key);
          release();
        });
        return () => {
          closed = true;
          if (this.#listens.get(key) === l) {
            this.#listens.delete(key);
            l.fail(new ContractError("cancelled", "the listening was closed"));
          }
        };
      },
      "voices.feed": async (ctx, args) => {
        this.#mayUseProviders(ctx);
        const id = stringArg(args, 0, "the listening", 64);
        const data = args[1];
        if (!(data instanceof Uint8Array)) throw new ContractError("invalid", "a piece's data is bytes");
        if (data.length > 1_500_000) throw new ContractError("invalid", "a piece is at most 1,500,000 bytes");
        const l = this.#listens.get(`${ctx.pluginId}\u0000${id}`);
        if (l === undefined) throw new ContractError("not_found", `no listening ${id} of yours is open`);
        if (data.length > 0) l.push(data);
        if (args[2] === true) l.end();
        return null;
      },
    };
  }
}

