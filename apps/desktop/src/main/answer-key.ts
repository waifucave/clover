// This desktop's answer key (spec §5.5, decision 91; lane H's ask in H-M1): an Ed25519 key the app holds apart from
// the core's link key, which signs this desktop's answers to cards and the user's own messages (E-M3), so plugin code
// can't sign with it where the OS keeps it from them. The app makes it once and registers its public half with the
// core on every connection (`device.answerKey.set`, with the app's signature over
// `clover/answer-key/1\n<device>\n<public key>\n<holder>`, which lane H's registry checks).
//
// Replacing it (`rotate`): other computers trust the key with their cards, so the core takes a new one only with the
// current key's hand-over (its signature over `clover/answer-key-rotate/1\n<device>\n<from>\n<to>\n<at>`) and the user's
// yes on a sealed change card (lane C's `answer-key-rotate`), which the core cancels after 10 minutes. The core adopts
// the new key on that yes, wherever it is answered and whether or not the app is there to see it, so the new key is
// stored first, in the vault's second slot (`staged`), before the app asks; a rotation whose key can't be stored never
// starts. The app keeps answering with the current key until the core holds the staged one, then promotes it (write
// then rename): on the card's yes, or on any later connection or start where the core turns out to hold it (a yes the
// app missed, or one before a crash). A no, an expiry or a withdrawal discards it. Other computers take the new key
// from the peer update that follows; until it reaches one, that computer still trusts the old key.
//
// Where it is kept: the OS's own store, with no user-presence or biometric gate on any OS — no Touch ID, Windows Hello
// or passcode prompt, ever (the owner's decision, folded at E-M2). A packaged app keeps it through Electron's
// safeStorage, whose key is the OS's: on macOS a Keychain item only the signed app reads without asking
// ("app-keychain"); on Windows DPAPI; on Linux the Secret Service (`gnome_libsecret`) — its `basic_text` backend is
// no secret store at all, so the key stays in memory there, and the core hears it (S3). On Windows and the Linux
// Secret Service, which plugin code running as the user could also reach, the core hears "none", the risk the owner
// accepted. An unpackaged app keeps the key in memory alone, so a dev build never brings a Keychain or keyring dialog
// up (S4, the no-prompt rule). The key never goes into a log line, an error message or the core; signing reads it
// from memory and never prompts. The one place an OS auth check may appear at all is pairing or revoking a device,
// and only if it is asked for later.
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { answerKeyHolderFor, ERR, type AnswerKeyHolder } from "@waifucave/clover-protocol";
import { CLIENT_ERR } from "./protocol/client";

/** Where the key's private half is kept: the current key, and a replacement staged while its card waits. */
export interface KeyVault {
  readonly held: AnswerKeyHolder;
  load(): Uint8Array | undefined;
  save(secret: Uint8Array): void;
  clear(): void;
  /** The staged replacement, when one is staged: when it was staged, and the card it waits on once the core said. */
  loadStaged(): StagedKey | undefined;
  /** Stores a replacement before it is asked for; throws when it can't, and the rotation doesn't start. */
  saveStaged(staged: StagedKey): void;
  clearStaged(): void;
  /** The staged key becomes the current one, in one step (a rename over it). */
  promoteStaged(): void;
}

/** A replacement kept while its card waits. */
export interface StagedKey {
  secret: Uint8Array;
  /** When it was staged (ms): its card can't outlive `ROTATION_CARD_MS` after that. */
  at: number;
  card?: string;
}

/** What safeStorage offers (Electron's), so the vault is testable without it. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

/** The OS's store, through safeStorage: the files hold only what the OS's own key encrypted. Held through the
 *  protocol's own choice (macOS's Keychain limited to the signed app; nothing elsewhere this app can prove). The staged
 *  replacement is a second file beside the key, written to a temporary name and renamed into place. */
export function safeStorageVault(file: string, storage: SafeStorageLike, platform: NodeJS.Platform = process.platform): KeyVault {
  const staged = `${file}.staged`;
  const read = (path: string): string | undefined => {
    if (!existsSync(path) || !storage.isEncryptionAvailable()) return undefined;
    try {
      return storage.decryptString(readFileSync(path));
    } catch {
      return undefined;
    }
  };
  const write = (path: string, text: string) => {
    if (!storage.isEncryptionAvailable()) throw new Error("this computer's protected store isn't available");
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, storage.encryptString(text), { mode: 0o600 });
    renameSync(tmp, path);
  };
  return {
    held: answerKeyHolderFor(platform === "darwin" ? "macos" : platform === "win32" ? "windows" : "linux", { appKeychain: platform === "darwin" }),
    load() {
      const text = read(file);
      return text === undefined ? undefined : new Uint8Array(Buffer.from(text, "base64"));
    },
    save(secret) {
      write(file, Buffer.from(secret).toString("base64"));
    },
    clear() {
      rmSync(file, { force: true });
    },
    loadStaged() {
      const text = read(staged);
      if (text === undefined) return undefined;
      try {
        const v = JSON.parse(text) as { secret?: unknown; at?: unknown; card?: unknown };
        if (typeof v.secret !== "string" || typeof v.at !== "number") return undefined;
        return { secret: new Uint8Array(Buffer.from(v.secret, "base64")), at: v.at, ...(typeof v.card === "string" ? { card: v.card } : {}) };
      } catch {
        return undefined;
      }
    },
    saveStaged(st) {
      write(staged, JSON.stringify({ secret: Buffer.from(st.secret).toString("base64"), at: st.at, ...(st.card === undefined ? {} : { card: st.card }) }));
    },
    clearStaged() {
      rmSync(staged, { force: true });
    },
    promoteStaged() {
      const v = this.loadStaged();
      if (!v) throw new Error("no staged key");
      // The current key's file is replaced by a rename (write then rename), then the staged slot goes.
      write(file, Buffer.from(v.secret).toString("base64"));
      rmSync(staged, { force: true });
    },
  };
}

/** A vault in memory: a headless run's and the tests'. */
export function memoryVault(held: AnswerKeyHolder = "none"): KeyVault {
  let secret: Uint8Array | undefined;
  let staged: StagedKey | undefined;
  return {
    held,
    load: () => secret,
    save: (s) => void (secret = new Uint8Array(s)),
    clear: () => void (secret = undefined),
    loadStaged: () => staged,
    saveStaged: (st) => void (staged = { ...st, secret: new Uint8Array(st.secret) }),
    clearStaged: () => void (staged = undefined),
    promoteStaged: () => {
      if (!staged) throw new Error("no staged key");
      secret = staged.secret;
      staged = undefined;
    },
  };
}

/** What the app signs to show the core it holds the key (lane H's `answerKeyStatement`). */
export function answerKeyStatement(deviceId: string, publicKey: string, held: AnswerKeyHolder): Uint8Array {
  return new TextEncoder().encode(`clover/answer-key/1\n${deviceId}\n${publicKey}\n${held}`);
}

/** What the current key signs to hand this desktop's answer key over to a new one (lane H's `answerKeyRotateStatement`). */
export function answerKeyRotateStatement(deviceId: string, from: string, to: string, at: number): Uint8Array {
  return new TextEncoder().encode(`clover/answer-key-rotate/1\n${deviceId}\n${from}\n${to}\n${at}`);
}

/** How a replacement went: applied at once, waiting on its card, or refused (and why). */
export type RotationStart = { applied: true } | { card: string } | { refused: string };

/** How often, and how far apart, the app checks the core holds the new key once its card is approved: the core applies
 *  it just after the card resolves. */
const ADOPT_TRIES = 10;
const ADOPT_GAP_MS = 200;

export interface AnswerKeyClient {
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
}

export class AnswerKey {
  private key: KeyObject | undefined;
  private readonly now: () => number;

  constructor(private readonly vault: KeyVault, private readonly log: (line: string) => void = () => {}, opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
  }

  /** The key, made and kept the first time. */
  private private(): KeyObject {
    if (this.key !== undefined) return this.key;
    const kept = this.vault.load();
    if (kept !== undefined) {
      try {
        this.key = createPrivateKey({ key: Buffer.from(kept), format: "der", type: "pkcs8" });
        return this.key;
      } catch {
        this.log("answer key: the kept key couldn't be read; a new one is made");
      }
    }
    const { privateKey } = generateKeyPairSync("ed25519");
    this.vault.save(new Uint8Array(privateKey.export({ format: "der", type: "pkcs8" })));
    this.key = privateKey;
    return privateKey;
  }

  /** The staged replacement, if one is kept and reads. */
  private staged(): (StagedKey & { key: KeyObject }) | undefined {
    const v = this.vault.loadStaged();
    if (!v) return undefined;
    try {
      return { ...v, key: createPrivateKey({ key: Buffer.from(v.secret), format: "der", type: "pkcs8" }) };
    } catch {
      this.vault.clearStaged();
      return undefined;
    }
  }

  /** The public half, raw (32 bytes), base64. */
  publicKey(): string {
    return rawPublic(this.private());
  }

  /** The card a staged replacement waits on, if the core said which. */
  get pendingCard(): string | undefined {
    return this.vault.loadStaged()?.card;
  }

  get held(): AnswerKeyHolder {
    return this.vault.held;
  }

  sign(message: Uint8Array): Uint8Array {
    return new Uint8Array(sign(null, Buffer.from(message), this.private()));
  }

  /** Starts replacing the key: a new one, stored in the staged slot first (a rotation whose key can't be stored doesn't
   *  start), then registered under its own signature with the current key's hand-over. A replacement already staged
   *  and not known to be over is never overwritten: it is resolved first, and while it still waits a new one is
   *  refused. The current key stays until the core holds the new one. */
  async rotate(client: AnswerKeyClient, deviceId: string, now: number = this.now()): Promise<RotationStart> {
    if (this.vault.loadStaged() && (await this.resolveStaged(client, deviceId)) === "waiting") {
      return { refused: "a replacement already waits on its card" };
    }
    const current = this.private();
    const from = rawPublic(current);
    const { privateKey: next } = generateKeyPairSync("ed25519");
    const staged: StagedKey = { secret: new Uint8Array(next.export({ format: "der", type: "pkcs8" })), at: this.now() };
    try {
      this.vault.saveStaged(staged);
    } catch (err) {
      const why = `the new key couldn't be stored (${err instanceof Error ? err.message.slice(0, 120) : "refused"})`;
      this.log(`answer key: not replaced: ${why}`);
      return { refused: why };
    }
    const to = rawPublic(next);
    const params = {
      publicKey: to, held: this.held,
      signature: b64(sign(null, Buffer.from(answerKeyStatement(deviceId, to, this.held)), next)),
      rotation: { from, at: now, signature: b64(sign(null, Buffer.from(answerKeyRotateStatement(deviceId, from, to, now)), current)) },
    };
    let r: { applied?: boolean; card?: string };
    try {
      r = await client.request<{ applied?: boolean; card?: string }>("device.answerKey.set", params, 15_000);
    } catch (err) {
      const why = err instanceof Error ? err.message.slice(0, 200) : "refused";
      if (isRefusal(err)) {
        // The core answered no: nothing was asked of the user, so nothing can approve this key.
        this.vault.clearStaged();
        this.log(`answer key: not replaced (${why})`);
        return { refused: why };
      }
      // A lost reply (a timeout, the connection closed): the core may already show the card. The key stays staged, and
      // the next connection adopts it if the core holds it, or drops it once no card can approve it.
      this.log(`answer key: the replacement's answer was lost (${why}); its key stays staged`);
      return { refused: why };
    }
    if (r?.applied === true) {
      this.promote();
      return { applied: true };
    }
    if (typeof r?.card !== "string") {
      this.log("answer key: the core didn't say which card; the new key stays staged");
      return { refused: "the core didn't say which card" };
    }
    // The staged key now names its card, so a start after a crash knows what it waits on.
    try {
      this.vault.saveStaged({ ...staged, card: r.card });
    } catch {
      // The key itself is stored; without the card's id it is resolved by its age.
    }
    this.log("answer key: replacing it waits on its card");
    return { card: r.card };
  }

  /** A card resolved. On the staged replacement's yes, the app promotes the staged key once the core holds it; on its
   *  no, expiry, withdrawal or cancellation the staged key is discarded (after one last look). True when the key
   *  changed. */
  async resolved(client: AnswerKeyClient, deviceId: string, cardId: string, outcome: string): Promise<boolean> {
    const st = this.staged();
    if (!st || st.card !== cardId) return false;
    if (outcome !== "approved") {
      const look = await this.adoptIfHeld(client, deviceId, st.key);
      if (look === "held") return true;
      // No answer: kept staged, and the next connection looks again.
      if (look === "unknown") return false;
      this.vault.clearStaged();
      this.log(`answer key: kept (the replacement was ${outcome})`);
      return false;
    }
    return this.adoptWithRetries(client, deviceId, st.key);
  }

  /** Registers the key with the core, for this device, on every connection; the core takes it only from a desktop,
   *  with this signature. A staged replacement the core already holds (a yes the app missed, or one before a crash) is
   *  promoted first; one no card can approve any more is dropped. */
  async register(client: AnswerKeyClient, deviceId: string): Promise<boolean> {
    return "registered" in (await this.registerOnce(client, deviceId));
  }

  /** One registration, and what it came to: `registered`; `again` when the core can't take it yet (it isn't serving
   *  the method yet, says to try again, or didn't answer), so a later try may; `refused` on the core's definite no (a
   *  different key already held, a device whose key was removed, a signature it didn't take). `quiet` leaves a retry's
   *  repeat out of the log. */
  async registerOnce(client: AnswerKeyClient, deviceId: string, o: { quiet?: boolean } = {}): Promise<Registration> {
    const st = this.staged();
    if (st && (await this.adoptIfHeld(client, deviceId, st.key)) === "held") return { registered: true };
    try {
      const publicKey = this.publicKey();
      const signature = Buffer.from(this.sign(answerKeyStatement(deviceId, publicKey, this.held))).toString("base64");
      await client.request("device.answerKey.set", { publicKey, held: this.held, signature }, 10_000);
      this.log(`answer key: registered (${this.held})`);
    } catch (err) {
      const why = err instanceof Error ? err.message.slice(0, 200) : "refused";
      if (!o.quiet) this.log(`answer key: not registered (${why})`);
      return notYet(err) ? { again: why } : { refused: why };
    }
    if (st) await this.resolveStaged(client, deviceId);
    return { registered: true };
  }

  /** What became of a staged replacement: `adopted` (the core holds it, now the key), `dropped` (no card can approve
   *  it any more), or `waiting`. It is dropped only on a known end — its card denied, expired, withdrawn, cancelled
   *  or unknown to the core, or older than any card can live — and only after one last look finds the core doesn't
   *  hold it: a yes can land at any moment before. An approved card is waited on, never dropped. */
  private async resolveStaged(client: AnswerKeyClient, deviceId: string): Promise<"adopted" | "dropped" | "waiting"> {
    const st = this.staged();
    if (!st) return "dropped";
    const first = await this.adoptIfHeld(client, deviceId, st.key);
    if (first === "held") return "adopted";
    // No answer from the core: nothing is known, so nothing is dropped.
    if (first === "unknown") return "waiting";
    let over = this.now() - st.at > ROTATION_CARD_MS + ROTATION_MARGIN_MS;
    if (!over && st.card !== undefined) {
      const card = await client.request<{ outcome?: string }>("card.get", { id: st.card }, 10_000)
        .then((c) => ({ outcome: c?.outcome }), (err: unknown) => ({ error: err }));
      if ("error" in card) {
        // The core doesn't know the card (it restarted): nothing can approve it now. Any other failure tells nothing.
        over = isRefusal(card.error) && (card.error as { code?: number }).code === ERR.NOT_FOUND;
      } else if (card.outcome === "approved") {
        return (await this.adoptWithRetries(client, deviceId, st.key)) ? "adopted" : "waiting";
      } else if (card.outcome !== undefined) {
        over = true;
      }
    }
    if (!over) return "waiting";
    // One last look: a yes may have landed since the first. Dropped only on a definitive "not held".
    const last = await this.adoptIfHeld(client, deviceId, st.key);
    if (last === "held") return "adopted";
    if (last === "unknown") return "waiting";
    this.vault.clearStaged();
    this.log("answer key: kept (the replacement's card is over)");
    return "dropped";
  }

  /** The core applies an approved key just after its card resolves: look a few times. */
  private async adoptWithRetries(client: AnswerKeyClient, deviceId: string, key: KeyObject): Promise<boolean> {
    for (let i = 0; i < ADOPT_TRIES; i++) {
      if ((await this.adoptIfHeld(client, deviceId, key)) === "held") return true;
      await new Promise((r) => setTimeout(r, ADOPT_GAP_MS));
    }
    // Kept staged: the next connection adopts it if the core holds it by then.
    this.log("answer key: the core doesn't hold the new key yet; it stays staged");
    return false;
  }

  /** Whether the core holds `key` (registering it again applies at once only then): `held`, and it becomes the key;
   *  `not-held` on a definitive answer (not applied, or a refusal from the core); `unknown` when no answer came (a
   *  timeout, a closed connection, an internal error), which never counts as not held. */
  private async adoptIfHeld(client: AnswerKeyClient, deviceId: string, key: KeyObject): Promise<"held" | "not-held" | "unknown"> {
    const to = rawPublic(key);
    const signature = b64(sign(null, Buffer.from(answerKeyStatement(deviceId, to, this.held)), key));
    try {
      const r = await client.request<{ applied?: boolean }>("device.answerKey.set", { publicKey: to, held: this.held, signature }, 10_000);
      if (r?.applied !== true) return "not-held";
    } catch (err) {
      return isRefusal(err) ? "not-held" : "unknown";
    }
    this.promote();
    this.log("answer key: replaced");
    return "held";
  }

  /** The staged key becomes the current one, in the vault and for signing. */
  private promote(): void {
    const st = this.vault.loadStaged();
    if (!st) return;
    // Signing moves to the new key at once: the core holds it. If the vault can't promote it now, it stays staged and
    // the next start promotes it (the core holds it then too).
    this.key = createPrivateKey({ key: Buffer.from(st.secret), format: "der", type: "pkcs8" });
    try {
      this.vault.promoteStaged();
    } catch {
      this.log("answer key: the new key stays staged in this computer's store until the next start");
    }
  }
}

/** How a registration went (`AnswerKey.registerOnce`). */
export type Registration = { registered: true } | { again: string } | { refused: string };

/** The waits between tries while the core can't take the key yet: growing, then every 30 s while connected. */
export const REGISTER_WAITS_MS = [500, 1_000, 2_000, 4_000, 8_000, 15_000, 30_000] as const;

/** This connection's registration of the answer key: tried at once, then again on a growing wait while the core can't
 *  take it yet (a daemon whose device registry is still opening, or an older one that serves the method only once its
 *  links are up), until it is registered, definitely refused, or the connection goes. A press on a card asks
 *  `ready()`, which tries again at once rather than waiting out the current wait: the key is registered before the
 *  answer it signs is sent. */
export class KeyRegistration {
  private state: Registration | undefined;
  private wake: (() => void) | undefined;
  private settledWaiters: Array<() => void> = [];
  private stopped = false;
  private tries = 0;

  constructor(
    private readonly key: AnswerKey, private readonly client: AnswerKeyClient, private readonly deviceId: string,
    private readonly alive: () => boolean, private readonly log: (line: string) => void = () => {},
    private readonly waits: readonly number[] = REGISTER_WAITS_MS,
  ) {
    void this.run();
  }

  /** The last outcome: registered, refused, or still trying (`again`), undefined before the first answer. */
  get current(): Registration | undefined {
    return this.state;
  }

  stop(): void {
    this.stopped = true;
    this.wake?.();
  }

  /** Registered (or definitely refused) within `timeoutMs`, trying again at once if a wait is running. */
  async ready(timeoutMs: number): Promise<Registration> {
    if (this.state !== undefined && !("again" in this.state)) return this.state;
    this.wake?.();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      new Promise<void>((r) => this.settledWaiters.push(r)),
      new Promise<void>((r) => { timer = setTimeout(r, timeoutMs); }),
    ]);
    clearTimeout(timer);
    return this.state ?? { again: "the core hasn't answered yet" };
  }

  private async run(): Promise<void> {
    for (;;) {
      if (this.stopped || !this.alive()) return this.settle();
      const r = await this.key.registerOnce(this.client, this.deviceId, { quiet: this.tries > 0 });
      this.tries++;
      this.state = r;
      if (!("again" in r)) {
        if ("registered" in r && this.tries > 1) this.log(`answer key: registered after ${this.tries} tries`);
        return this.settle();
      }
      // Each try's outcome wakes a press waiting on it, registered or not.
      for (const w of this.settledWaiters.splice(0)) w();
      const wait = this.waits[Math.min(this.tries - 1, this.waits.length - 1)]!;
      if (this.tries === 1) this.log(`answer key: trying again (in ${wait / 1000} s, and on a growing wait while the core can't take it)`);
      await new Promise<void>((r) => {
        const t = setTimeout(r, wait);
        this.wake = () => { clearTimeout(t); r(); };
      });
      this.wake = undefined;
    }
  }

  private settle(): void {
    for (const w of this.settledWaiters.splice(0)) w();
  }
}

/** The core can't take the key yet, or didn't answer: a later try may. Not served (an older daemon before its links
 *  are up), told to try again, a timeout, a closed connection or an internal error. */
function notYet(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code !== "number" || code === ERR.METHOD_NOT_FOUND || code === ERR.RETRY || code === CLIENT_ERR.CLOSED || code === CLIENT_ERR.TIMEOUT || code === ERR.INTERNAL;
}

/** The core cancels a replacement's card this long after it shows (`ANSWER_KEY_ROTATION_CARD_MS`), and a minute's
 *  margin: a staged key older than both can't be approved any more. */
const ROTATION_CARD_MS = 10 * 60 * 1000;
const ROTATION_MARGIN_MS = 60 * 1000;

/** A definitive answer from the core: a JSON-RPC error it sent. A timeout, a closed connection or an internal error
 *  tells nothing about whether it acted. */
function isRefusal(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "number" && code !== CLIENT_ERR.CLOSED && code !== CLIENT_ERR.TIMEOUT && code !== ERR.INTERNAL;
}

function rawPublic(key: KeyObject): string {
  const der = createPublicKey(key).export({ format: "der", type: "spki" });
  return Buffer.from(der.subarray(der.length - 32)).toString("base64");
}

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");
