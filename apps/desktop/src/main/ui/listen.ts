// Push-to-talk, the main process's side (spec §6.6: "on desktops the app records and plays the audio too and hands it to
// voice plugins, so no plugin needs the microphone permission"; §5.7: "voice listens only while the user holds push-to-talk").
//
// What records is the app's own `clover` shell document (the layer that plays a bot's speech); a plugin never gets the
// microphone, and the bundled composer only asks. This file is the one place that decides whether a recording may exist:
//
//   start  the composer's `listenStart`, inside the user's own press (composer-calls.ts took the gesture). Main mints the
//          utterance id and keeps ONE hold per window; only then does the shell get `{ type: "listen", op: "start" }`, and
//          only for the hold's lifetime does the window's microphone permission answer yes (`micAllowed`). A recording
//          nobody pressed for cannot start: the shell records only on that message, and the OS's permission is refused
//          to every frame of every other time.
//   piece  the shell's audio, as `voice.listen` calls from `clover/shell` (tree-calls.ts `voice.listen`, the `held`
//          disposition). The shell sends `{ audio, final }` and nothing else: main chooses the bot and the utterance and
//          numbers the pieces from 0, so the shell cannot name another bot, replay or reorder; calls are serialised so
//          piece N+1 never overtakes piece N (the core opens the utterance on piece 0, after its provider check).
//   stop   the composer's release. The shell is told to stop and flush; its last piece (`final: true`) closes the
//          utterance and main answers the composer with the text. A hold is also ended by the 60 s cap, by the shell
//          failing to answer within a grace, and by its window closing; whichever closes it, if anything reached the core
//          its utterance gets a last (empty) piece, so the plugin's call ends now rather than idling out.
//
// A tap that recorded nothing sends nothing to the core.
import type { LayerMessage } from "@waifucave/clover-plugin-sdk/ui/bridge";

/** One recording is at most this long. The shell stops itself here too; main's is the one that counts. */
export const LISTEN_MAX_MS = 60_000;
/** After a stop is asked (by the user, the cap or a close), how long the shell has to send its last piece. */
export const LISTEN_GRACE_MS = 10_000;
/** The most base64 characters one piece may carry: `voice.listen`'s own limit. */
export const LISTEN_PIECE_MAX_CHARS = 2_000_000;
/** The most audio, in bytes, one recording may add up to: the cap's worth of 16 kHz 16-bit mono (32,000 B/s), and a second. */
export const LISTEN_MAX_BYTES = 32_000 * (LISTEN_MAX_MS / 1000 + 1);
/** A finished hold nobody asked about is dropped when the window starts another or after this long. */
const FINISHED_KEPT_MS = 5 * 60_000;
/** The first piece waits for the bot's voice provider's check (a card the user may take a while to answer), and the last for the transcription. */
export const LISTEN_REQUEST_MS = 5 * 60_000;

/** What a recording came to: the words heard, or a short sentence saying why there are none. */
export interface ListenOutcome {
  text?: string;
  note?: string;
}

export interface ListenDeps {
  /** A message to the window's `clover` shell (the one that records). */
  shell(windowId: number, message: LayerMessage): void;
  /** `voice.listen` on the app's own connection. */
  request(method: string, params: unknown): Promise<unknown>;
  /** The operating system's microphone permission for this app: undefined when it is granted (the first time the OS asks
   *  the user), else a sentence saying why not. Never called in a test or acceptance build. */
  ensureMic?(): Promise<string | undefined>;
  log(line: string): void;
  /** For tests: a timer that returns its cancel. */
  schedule?(fn: () => void, ms: number): () => void;
  now?(): number;
  makeId?(): string;
}

type Phase = "opening" | "recording" | "stopping" | "closed";

interface Hold {
  windowId: number;
  bot: string;
  utterance: string;
  phase: Phase;
  /** The next piece's number at the core. */
  next: number;
  bytes: number;
  /** Something reached the core, so its utterance needs a last piece. */
  sent: boolean;
  /** The user let go before the microphone was open (the OS was asking): record nothing. */
  stopAsked: boolean;
  /** The pieces go one after another. */
  chain: Promise<unknown>;
  result: Promise<ListenOutcome>;
  settle(o: ListenOutcome): void;
  cancel: Array<() => void>;
  closedAt?: number;
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** The bytes a base64 string holds, without decoding it. */
export function base64Bytes(s: string): number {
  const pad = s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0;
  return Math.floor((s.length * 3) / 4) - pad;
}

/** A piece the shell sent, checked: `audio` base64 of whole 16-bit samples within the method's size, `final` a boolean, and
 *  no other field but `problem` (true on a last, empty piece: the microphone could not be opened). The shell never names a
 *  bot, an utterance or a number. */
export function cleanPiece(p: unknown): { audio: string; final: boolean; problem?: true } | { why: string } {
  if (p === null || typeof p !== "object" || Array.isArray(p)) return { why: "a piece of audio" };
  const o = p as Record<string, unknown>;
  if (Object.keys(o).some((k) => k !== "audio" && k !== "final" && k !== "problem")) return { why: "a piece is audio and whether it is the last, nothing else" };
  if (typeof o.audio !== "string" || typeof o.final !== "boolean" || (o.problem !== undefined && o.problem !== true)) return { why: "a piece is audio and whether it is the last" };
  if (o.audio.length > LISTEN_PIECE_MAX_CHARS) return { why: "that piece is too large" };
  if (!BASE64.test(o.audio) || o.audio.length % 4 !== 0) return { why: "the audio isn't base64" };
  if (base64Bytes(o.audio) % 2 !== 0) return { why: "the audio isn't whole 16-bit samples" };
  if (o.problem === true && (!o.final || o.audio !== "")) return { why: "only a last, empty piece says the microphone failed" };
  return { audio: o.audio, final: o.final, ...(o.problem === true ? { problem: true as const } : {}) };
}

export class ListenHolds {
  readonly #d: ListenDeps;
  /** One per window: the one recording or, once it closed, what it came to, until the composer takes it. */
  readonly #holds = new Map<number, Hold>();
  #count = 0;

  constructor(deps: ListenDeps) {
    this.#d = deps;
  }

  #schedule(fn: () => void, ms: number): () => void {
    if (this.#d.schedule !== undefined) return this.#d.schedule(fn, ms);
    const t = setTimeout(fn, ms);
    (t as { unref?: () => void }).unref?.();
    return () => clearTimeout(t);
  }

  /** The user pressed (the caller took their gesture): a hold for `bot` opens in this window, over any before it. The
   *  answer comes when the shell has been told to record, or with a note when it will not. */
  async start(windowId: number, bot: string): Promise<{ note?: string }> {
    this.#sweep();
    const before = this.#holds.get(windowId);
    if (before !== undefined && before.phase !== "closed") this.#close(before, { note: "Another recording began." }, true);
    let settle!: (o: ListenOutcome) => void;
    const result = new Promise<ListenOutcome>((resolve) => { settle = resolve; });
    const h: Hold = {
      windowId, bot, utterance: this.#d.makeId?.() ?? `ptt_${Date.now().toString(36)}_${(++this.#count).toString(36)}`,
      phase: "opening", next: 0, bytes: 0, sent: false, stopAsked: false, chain: Promise.resolve(), result, settle, cancel: [],
    };
    this.#holds.set(windowId, h);
    const why = await this.#d.ensureMic?.().catch(() => "Clover couldn't ask for the microphone.");
    if (h.phase === "closed") return {};
    if (why !== undefined) {
      this.#close(h, { note: why }, false);
      return { note: why };
    }
    if (h.stopAsked) {
      // Let go while the system was asking: nothing was recorded, and the next press records.
      this.#close(h, { note: "The microphone is allowed now. Hold to talk again." }, false);
      return { note: "The microphone is allowed now. Hold to talk again." };
    }
    h.phase = "recording";
    this.#d.shell(windowId, { type: "listen", op: "start", bot, utterance: h.utterance, maxMs: LISTEN_MAX_MS });
    h.cancel.push(this.#schedule(() => this.#askStop(h, "the cap"), LISTEN_MAX_MS));
    return {};
  }

  /** The user let go (or the window lost the focus): the shell stops and sends its last piece. Answers with what was
   *  heard, or why not; a window with no recording answers nothing. */
  async stop(windowId: number): Promise<ListenOutcome> {
    const h = this.#holds.get(windowId);
    if (h === undefined) return {};
    if (h.phase === "opening") h.stopAsked = true;
    else if (h.phase === "recording") this.#askStop(h, "the release");
    const outcome = await h.result;
    if (this.#holds.get(windowId) === h) this.#holds.delete(windowId);
    return outcome;
  }

  #askStop(h: Hold, why: string): void {
    if (h.phase !== "recording") return;
    h.phase = "stopping";
    this.#d.shell(h.windowId, { type: "listen", op: "stop", utterance: h.utterance });
    // The shell answers with its last piece; if it doesn't, the hold ends here.
    h.cancel.push(this.#schedule(() => {
      if (h.phase === "closed") return;
      this.#d.log(`listen: ${h.bot}: the shell sent no last piece within ${LISTEN_GRACE_MS / 1000} s (${why}); ended`);
      this.#close(h, { note: "The recording didn't finish." }, true);
    }, LISTEN_GRACE_MS));
  }

  /** The shell's piece (`voice.listen` from `clover/shell`). Numbered, checked and sent here; the shell's own words are the
   *  audio and whether it is the last. */
  piece(windowId: number, raw: unknown): Promise<{ text?: string }> {
    const p = cleanPiece(raw);
    if ("why" in p) return Promise.reject(new Error(p.why));
    const h = this.#holds.get(windowId);
    if (h === undefined || (h.phase !== "recording" && h.phase !== "stopping")) return Promise.reject(new Error("nothing is being recorded"));
    const bytes = base64Bytes(p.audio);
    if (h.bytes + bytes > LISTEN_MAX_BYTES) {
      this.#close(h, { note: "That recording was too long." }, true);
      return Promise.reject(new Error("that recording is too long"));
    }
    h.bytes += bytes;
    const run = h.chain.then(() => this.#send(h, p));
    h.chain = run.catch(() => undefined);
    return run;
  }

  async #send(h: Hold, p: { audio: string; final: boolean; problem?: true }): Promise<{ text?: string }> {
    if (h.phase === "closed") throw new Error("the recording is over");
    if (!p.final && p.audio === "") return {};
    // A press that recorded nothing: nothing goes to the core.
    if (p.final && p.audio === "" && !h.sent) {
      this.#close(h, { note: p.problem === true ? "The microphone couldn't be opened." : "Nothing was recorded." }, false);
      return {};
    }
    try {
      h.sent = true;
      const r = (await this.#d.request("voice.listen", { bot: h.bot, utterance: h.utterance, seq: h.next++, audio: p.audio, format: "pcm16-16k", final: p.final })) as { text?: unknown } | undefined;
      if (p.final) {
        const text = typeof r?.text === "string" ? r.text.trim() : "";
        this.#close(h, text === "" ? { note: "Nothing was heard." } : { text }, false);
        return text === "" ? {} : { text };
      }
      return {};
    } catch (err) {
      // The core's reason (a bot with no voice, a voice that doesn't listen, the user's no to its provider) is the user's note.
      const reason = err instanceof Error ? err.message : "";
      this.#d.log(`listen: ${h.bot}: voice.listen refused (${reason.replace(/[^\w .,'’:-]/g, "").slice(0, 120)})`);
      this.#close(h, { note: reason !== "" ? reason.slice(0, 300) : "The voice couldn't listen." }, true);
      throw err;
    }
  }

  /** Ends the hold with its outcome. `finish`: a stream the core may still hold open gets its last piece. */
  #close(h: Hold, outcome: ListenOutcome, finish: boolean): void {
    if (h.phase === "closed") return;
    // A stop already went to the shell when the phase is "stopping"; a shell that is still recording is told now.
    const wasRecording = h.phase === "recording";
    h.phase = "closed";
    h.closedAt = (this.#d.now ?? Date.now)();
    for (const c of h.cancel) c();
    h.cancel = [];
    if (wasRecording) this.#d.shell(h.windowId, { type: "listen", op: "stop", utterance: h.utterance });
    if (finish && h.sent) {
      void this.#d.request("voice.listen", { bot: h.bot, utterance: h.utterance, seq: h.next++, audio: "", format: "pcm16-16k", final: true }).catch(() => undefined);
    }
    h.settle(outcome);
  }

  /** Whether the window's microphone may be opened now: only while its hold is recording. */
  micAllowed(windowId: number): boolean {
    return this.#holds.get(windowId)?.phase === "recording";
  }

  /** A window closed: its recording ends, with nothing to answer. */
  closeWindow(windowId: number): void {
    const h = this.#holds.get(windowId);
    if (h !== undefined) this.#close(h, { note: "The window closed." }, true);
    this.#holds.delete(windowId);
  }

  #sweep(): void {
    const now = (this.#d.now ?? Date.now)();
    for (const [w, h] of this.#holds) if (h.phase === "closed" && h.closedAt !== undefined && now - h.closedAt > FINISHED_KEPT_MS) this.#holds.delete(w);
  }
}

/** What the `ui` session's permission handlers answer for a microphone: yes only for the main window's `clover` shell (the
 *  layer's own origin), for audio alone, while its window's hold is recording. Everything else is refused: a camera, a
 *  screen, any other frame, any other time. */
export function micPermission(q: { permission: string; mediaTypes?: readonly string[]; requestingUrl: string; windowId: number | undefined }, holds: Pick<ListenHolds, "micAllowed">, layerScheme: string): boolean {
  if (q.permission !== "media" || q.windowId === undefined) return false;
  if (q.mediaTypes === undefined || q.mediaTypes.length === 0 || q.mediaTypes.some((t) => t !== "audio")) return false;
  if (!q.requestingUrl.startsWith(`${layerScheme}://clover/`)) return false;
  return holds.micAllowed(q.windowId);
}
