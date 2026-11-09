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
import { answerKeyHolderFor, type AnswerKeyHolder } from "@waifucave/clover-protocol";

/** Where the key's private half is kept: the current key, and a replacement staged while its card waits. */
export interface KeyVault {
  readonly held: AnswerKeyHolder;
  load(): Uint8Array | undefined;
  save(secret: Uint8Array): void;
  clear(): void;
  /** The staged replacement and the card it waits on, when one is staged. */
  loadStaged(): { secret: Uint8Array; card?: string } | undefined;
  /** Stores a replacement before it is asked for; throws when it can't, and the rotation doesn't start. */
  saveStaged(secret: Uint8Array, card?: string): void;
  clearStaged(): void;
  /** The staged key becomes the current one, in one step (a rename over it). */
  promoteStaged(): void;
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
        const v = JSON.parse(text) as { secret?: unknown; card?: unknown };
        if (typeof v.secret !== "string") return undefined;
        return { secret: new Uint8Array(Buffer.from(v.secret, "base64")), ...(typeof v.card === "string" ? { card: v.card } : {}) };
      } catch {
        return undefined;
      }
    },
    saveStaged(secret, card) {
      write(staged, JSON.stringify({ secret: Buffer.from(secret).toString("base64"), ...(card === undefined ? {} : { card }) }));
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
  let staged: { secret: Uint8Array; card?: string } | undefined;
  return {
    held,
    load: () => secret,
    save: (s) => void (secret = new Uint8Array(s)),
    clear: () => void (secret = undefined),
    loadStaged: () => staged,
    saveStaged: (s, card) => void (staged = { secret: new Uint8Array(s), ...(card === undefined ? {} : { card }) }),
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

  constructor(private readonly vault: KeyVault, private readonly log: (line: string) => void = () => {}) {}

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
  private staged(): { key: KeyObject; card?: string } | undefined {
    const v = this.vault.loadStaged();
    if (!v) return undefined;
    try {
      return { key: createPrivateKey({ key: Buffer.from(v.secret), format: "der", type: "pkcs8" }), ...(v.card === undefined ? {} : { card: v.card }) };
    } catch {
      this.vault.clearStaged();
      return undefined;
    }
  }

  /** The public half, raw (32 bytes), base64. */
  publicKey(): string {
    return rawPublic(this.private());
  }

  /** The card a staged replacement waits on, if one does. */
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
   *  start), then registered under its own signature with the current key's hand-over. The core withdraws any card an
   *  earlier replacement still waits on. The current key stays until the core holds the new one. */
  async rotate(client: AnswerKeyClient, deviceId: string, now: number = Date.now()): Promise<RotationStart> {
    // A staged key the core already holds (an earlier card's yes) becomes the key first: the new hand-over is from it.
    const before = this.staged();
    if (before) await this.adoptIfHeld(client, deviceId, before.key);
    const current = this.private();
    const from = rawPublic(current);
    const { privateKey: next } = generateKeyPairSync("ed25519");
    const secret = new Uint8Array(next.export({ format: "der", type: "pkcs8" }));
    try {
      this.vault.saveStaged(secret);
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
    try {
      const r = await client.request<{ applied: boolean; card?: string }>("device.answerKey.set", params, 15_000);
      if (r.applied) {
        this.promote();
        return { applied: true };
      }
      if (typeof r.card !== "string") throw new Error("the core didn't say which card");
      // The staged key now names its card, so a start after a crash knows what it waits on.
      try {
        this.vault.saveStaged(secret, r.card);
      } catch {
        // The key itself is stored; only the card's id isn't, and the next connection still adopts it if it's held.
      }
      this.log("answer key: replacing it waits on its card");
      return { card: r.card };
    } catch (err) {
      this.vault.clearStaged();
      const why = err instanceof Error ? err.message.slice(0, 200) : "refused";
      this.log(`answer key: not replaced (${why})`);
      return { refused: why };
    }
  }

  /** A card resolved. On the staged replacement's yes, the app promotes the staged key once the core holds it; on its
   *  no, expiry, withdrawal or cancellation the staged key is discarded. True when the key changed. */
  async resolved(client: AnswerKeyClient, deviceId: string, cardId: string, outcome: string): Promise<boolean> {
    const st = this.staged();
    if (!st || st.card !== cardId) return false;
    if (outcome !== "approved") {
      this.vault.clearStaged();
      this.log(`answer key: kept (the replacement was ${outcome})`);
      return false;
    }
    for (let i = 0; i < ADOPT_TRIES; i++) {
      if (await this.adoptIfHeld(client, deviceId, st.key)) return true;
      await new Promise((r) => setTimeout(r, ADOPT_GAP_MS));
    }
    // Kept staged: the next connection adopts it if the core holds it by then.
    this.log("answer key: the core doesn't hold the new key yet; it stays staged");
    return false;
  }

  /** Registers the key with the core, for this device, on every connection; the core takes it only from a desktop,
   *  with this signature. A staged replacement the core already holds (a yes the app missed, or one before a crash) is
   *  promoted first; one whose card is over is discarded. */
  async register(client: AnswerKeyClient, deviceId: string): Promise<boolean> {
    const st = this.staged();
    if (st && (await this.adoptIfHeld(client, deviceId, st.key))) return true;
    try {
      const publicKey = this.publicKey();
      const signature = Buffer.from(this.sign(answerKeyStatement(deviceId, publicKey, this.held))).toString("base64");
      await client.request("device.answerKey.set", { publicKey, held: this.held, signature }, 10_000);
      this.log(`answer key: registered (${this.held})`);
    } catch (err) {
      // An older daemon, a device that isn't a desktop, or one whose key was removed (pair again): said, not fatal.
      this.log(`answer key: not registered (${err instanceof Error ? err.message.slice(0, 200) : "refused"})`);
      return false;
    }
    // The core holds the current key: a staged one waits on its card, or its card is over.
    if (st?.card !== undefined) {
      const card: { outcome?: string } | Error = await client.request<{ outcome?: string }>("card.get", { id: st.card }, 10_000)
        .catch((err: unknown) => (err instanceof Error ? err : new Error(String(err))));
      if (card instanceof Error) {
        // The core doesn't know the card (it restarted): nothing can approve it now.
        if (/no card|not found/i.test(card.message)) this.vault.clearStaged();
      } else if (card.outcome !== undefined) {
        this.vault.clearStaged();
        this.log(`answer key: kept (the replacement was ${card.outcome})`);
      }
    }
    return true;
  }

  /** Whether the core holds `key`: registering it again applies at once only then. If it does, it becomes the key. */
  private async adoptIfHeld(client: AnswerKeyClient, deviceId: string, key: KeyObject): Promise<boolean> {
    const to = rawPublic(key);
    const signature = b64(sign(null, Buffer.from(answerKeyStatement(deviceId, to, this.held)), key));
    try {
      const r = await client.request<{ applied?: boolean }>("device.answerKey.set", { publicKey: to, held: this.held, signature }, 10_000);
      if (r?.applied !== true) return false;
    } catch {
      return false;
    }
    this.promote();
    this.log("answer key: replaced");
    return true;
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

function rawPublic(key: KeyObject): string {
  const der = createPublicKey(key).export({ format: "der", type: "spki" });
  return Buffer.from(der.subarray(der.length - 32)).toString("base64");
}

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");
