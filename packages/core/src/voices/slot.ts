// The listening half of voice (spec §6.6), until it is re-founded on general capabilities (P3 `microphone`,
// `device/microphone` and the `user.send` release rule): the speaking half left the core for Clover Voice's own plugin
// (its background part plays, its host half hears `message.out`, its providers are its own point), and this keeps only
// what push-to-talk still stands on.
//
// * Which voice mode hears push-to-talk: the user's choice (Clover Voice's `active` setting) when that plugin has a
//   `voiceModes` entry that is on and running here; else Clover Voice; else none, and push-to-talk is refused.
// * Push-to-talk goes to that mode: its start (the mode holds its own speech meanwhile), each piece, and the last, whose
//   answer is what the provider heard. A copy still goes to `audio.onRecording`, never to an inactive voice mode.
// * The providers' listening (`voices.listen`, `voices.feed`, `voices.providers`): their `voices` entries, called by any
//   plugin with `voices.use` and by any voice mode, the core carrying the calls and the provider placing its own key;
//   at most VOICES_CALLS_PER_PLUGIN open at once per plugin, each use logged with the caller's id.
import { BUNDLED_ROOT_PLUGIN, topPluginIdOf } from "@waifucave/clover-protocol";
import { ContractError } from "../contracts/common";
import type { PluginHost } from "../contracts/plugin-host";
import type { PluginRegistry } from "../contracts/plugin-registry";
import { listenerArg, stringArg, type ApiCallContext, type ApiHandlers } from "../plugin-host/api/router";
import type { RecordingPiece, VoiceService } from "./service";

/** Clover Voice: the bundled voice mode. */
export const CLOVER_VOICE = `${BUNDLED_ROOT_PLUGIN}/voice`;
/** Provider listenings (`voices.listen`) one plugin may have open at once. */
export const VOICES_CALLS_PER_PLUGIN = 4;
/** How long a push-to-talk utterance waits for its next piece before it is dropped. */
export const LISTEN_IDLE_MS = 30_000;
export interface VoiceSlotOptions {
  registry: Pick<PluginRegistry, "entries"> & Partial<Pick<PluginRegistry, "get">>;
  host: Pick<PluginHost, "invoke">;
  service: VoiceService;
  /** The user's choice of voice mode (Clover Voice's `active` setting), read at each use. */
  chosen?(): Promise<string | undefined> | string | undefined;
  log?(line: string): void;
  warn?(message: string): void;
  listenIdleMs?: number;
}

export interface VoiceModeView {
  pluginId: string;
  id: string;
  name: string;
  handler: string;
}

/** A push-to-talk utterance in the active mode's hands. */
interface Hearing {
  bot: string;
  mode: VoiceModeView;
  next: number;
  idle?: ReturnType<typeof setTimeout>;
}

const textOf = (name: unknown): string | undefined => (typeof name === "string" ? name : typeof (name as { en?: unknown } | undefined)?.en === "string" ? (name as { en: string }).en : undefined);
const UTTERANCE = /^[A-Za-z0-9_-]{1,64}$/;
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export class VoiceSlot {
  readonly #o: VoiceSlotOptions;
  /** Push-to-talk utterances in the active mode's hands. */
  readonly #hearing = new Map<string, Hearing>();
  /** Open provider calls, per plugin, and the open listenings by caller and id. */
  readonly #open = new Map<string, number>();
  readonly #listens = new Map<string, ReturnType<VoiceService["providerListen"]>>();
  /** The active mode last resolved (cached for the synchronous check). */
  #active: VoiceModeView | undefined;

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

  /** The voice mode that hears push-to-talk now, or undefined (none). */
  async active(): Promise<VoiceModeView | undefined> {
    const modes = this.modes();
    let chosen: string | undefined;
    try {
      chosen = (await this.#o.chosen?.()) ?? undefined;
    } catch {
      chosen = undefined;
    }
    if (chosen === "") chosen = undefined;
    const pick = (chosen !== undefined ? modes.find((m) => m.pluginId === chosen) : undefined) ?? modes.find((m) => m.pluginId === CLOVER_VOICE);
    this.#active = pick;
    return pick;
  }

  /** Whether `pluginId` is a voice mode that isn't the active one (it doesn't hear push-to-talk), from the last
   *  resolution (`audio.onRecording`'s delivery is synchronous). */
  inactiveMode(pluginId: string): boolean {
    return this.modes().some((m) => m.pluginId === pluginId) && this.#active?.pluginId !== pluginId;
  }

  /** Whether a push-to-talk would reach a listening voice for `bot` (`voice.status`): the active mode says (the bot's
   *  voice is its own setting). */
  async listens(bot: string): Promise<boolean> {
    const mode = await this.active();
    if (mode === undefined) return false;
    try {
      return (await this.#call<unknown>(mode, "listens", { bot })) === true;
    } catch {
      return false;
    }
  }

  async #call<R>(mode: VoiceModeView, method: string, args: unknown): Promise<R> {
    return this.#o.host.invoke<R>({ pluginId: mode.pluginId, handler: mode.handler, method, args, caller: { kind: "core" } });
  }

  /** One push-to-talk piece (`voice.listen`): to the active mode (its start first: it holds its own speech meanwhile),
   *  and a copy to `audio.onRecording`. The last piece's answer is what the mode's provider heard. */
  async listen(p: { bot: string; utterance: string; seq: number; audio: string; format: "pcm16-16k" | "opus"; final: boolean }): Promise<{ text?: string }> {
    let h = this.#hearing.get(p.utterance);
    if (h === undefined) {
      if (p.seq !== 0) throw new ContractError("invalid", `utterance ${p.utterance} starts at piece 0, not ${p.seq}`);
      const mode = await this.active();
      if (mode === undefined) throw new ContractError("refused", "no voice is on: turn on Clover Voice (or another voice) in Settings › Plugins to talk to your bots");
      await this.#call(mode, "listenStart", { bot: p.bot, utterance: p.utterance, format: p.format });
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

  /** The providers' listening may be called by a plugin with `voices.use`, or by a voice mode. */
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

  /** The providers' listening (`voices.*`). */
  apiHandlers(): ApiHandlers {
    const log = (line: string) => (this.#o.log ?? this.#o.warn)?.(line);
    return {
      "voices.providers": async (ctx) => {
        if (topPluginIdOf(ctx.pluginId) !== BUNDLED_ROOT_PLUGIN) this.#mayUseProviders(ctx);
        return this.#o.service.providers();
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
