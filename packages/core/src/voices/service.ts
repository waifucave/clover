// The providers' listening (spec §6.6), for push-to-talk until the listening half is re-founded: a provider plugin's
// `voices` entry is its endpoint; its handler's `listen` takes the recording as the call's input (lane B's streaming
// shape) and returns what it heard. The speaking half left the core (Clover Voice's own plugin speaks, through its own
// providers point). Also the copy of push-to-talk to `audio.onRecording`'s listeners.
import { ContractError } from "../contracts/common";
import type { PluginHost } from "../contracts/plugin-host";
import type { PluginRegistry } from "../contracts/plugin-registry";

/** One piece of the user's push-to-talk audio, as `audio.onRecording` hands it on. */
export interface RecordingPiece {
  bot: string;
  utterance: string;
  format: "pcm16-16k" | "opus";
  data: Uint8Array;
  final: boolean;
}

export interface VoiceServiceOptions {
  registry: Pick<PluginRegistry, "entries">;
  /** `stream` for the providers; `invoke` for the active voice mode (the voice slot), without which push-to-talk is
   *  refused. */
  host: Pick<PluginHost, "stream"> & Partial<Pick<PluginHost, "invoke">>;
  listenIdleMs?: number;
  warn?: (message: string) => void;
}

interface Entry {
  pluginId: string;
  handler: string;
  listen: boolean;
}

/** A queue the app's pieces go into and the plugin's input reads out of. */
class Pieces implements AsyncIterable<Uint8Array> {
  readonly #items: Uint8Array[] = [];
  #ended = false;
  #error: Error | undefined;
  #wake: (() => void) | undefined;
  push(piece: Uint8Array): void {
    this.#items.push(piece);
    this.#wake?.();
  }
  end(): void {
    this.#ended = true;
    this.#wake?.();
  }
  /** Ends the input with an error, which the plugin's read throws. */
  fail(error: Error): void {
    this.#error = error;
    this.#wake?.();
  }
  async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
    for (;;) {
      if (this.#error) throw this.#error;
      const next = this.#items.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.#ended) return;
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
      this.#wake = undefined;
    }
  }
}

export class VoiceService {
  readonly #o: VoiceServiceOptions;
  /** Who hears the user's push-to-talk audio as it comes (the plugin API's `audio.onRecording`). */
  readonly #recording = new Set<(piece: RecordingPiece) => void>();

  constructor(opts: VoiceServiceOptions) {
    this.#o = opts;
  }

  /** Every provider on `voices` that is on. */
  providers(): { pluginId: string; id: string; name: string; speak: boolean; listen: boolean }[] {
    const out: { pluginId: string; id: string; name: string; speak: boolean; listen: boolean }[] = [];
    for (const c of this.#o.registry.entries("voices")) {
      if (c.state !== "active" || c.entryId === undefined) continue;
      const v = c.value as { handler?: unknown; speak?: unknown; listen?: unknown; name?: unknown };
      if (typeof v.handler !== "string") continue;
      const name = typeof v.name === "string" ? v.name : typeof (v.name as { en?: unknown } | undefined)?.en === "string" ? (v.name as { en: string }).en : c.entryId;
      out.push({ pluginId: c.pluginId, id: c.entryId, name, speak: v.speak === true, listen: v.listen === true });
    }
    return out;
  }

  /** A push-to-talk piece to `audio.onRecording`'s listeners (the slot's listening path). */
  hearRecording(piece: RecordingPiece): void {
    for (const fn of [...this.#recording]) {
      try { fn(piece); } catch { /* a listener's failure is its own */ }
    }
  }

  /** A provider's listening (`voices.listen`): pieces in (`push`, `end`), what it heard out (`result`). */
  providerListen(o: { provider: string; format: "pcm16-16k" | "opus" }): { push(piece: Uint8Array): void; end(): void; fail(err: Error): void; result: Promise<string> } {
    const entry = this.#entry(o.provider);
    if (!entry.listen) throw new ContractError("refused", `the voice plugin "${o.provider}" doesn't listen`);
    const pieces = new Pieces();
    const gen = this.#o.host.stream<unknown, { text?: unknown }>({
      pluginId: entry.pluginId, handler: entry.handler, method: "listen", caller: { kind: "core" }, input: pieces,
      args: { format: o.format },
    });
    const result = (async () => {
      for (;;) {
        const next = await gen.next();
        if (next.done) return typeof next.value?.text === "string" ? next.value.text : "";
      }
    })();
    result.catch(() => {});
    return { push: (p) => pieces.push(p), end: () => pieces.end(), fail: (e) => pieces.fail(e), result };
  }

  /** Hears each piece of the user's push-to-talk audio as it comes (`audio.onRecording`). */
  onRecording(fn: (piece: RecordingPiece) => void): () => void {
    this.#recording.add(fn);
    return () => { this.#recording.delete(fn); };
  }

  #entry(provider: string): Entry {
    for (const c of this.#o.registry.entries("voices")) {
      if (c.state !== "active" || c.entryId !== provider) continue;
      const v = c.value as { handler?: unknown; listen?: unknown };
      if (typeof v.handler !== "string") continue;
      return { pluginId: c.pluginId, handler: v.handler, listen: v.listen === true };
    }
    throw new ContractError("not_installed", `no voice plugin "${provider}" is installed`);
  }
}
