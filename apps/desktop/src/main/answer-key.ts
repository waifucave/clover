// This desktop's answer key (spec §5.5, decision 91; lane H's ask in H-M1): an Ed25519 key the app holds apart from
// the core's link key, which signs this desktop's answers to cards and the user's own messages (E-M3), so plugin code
// can't sign with it where the OS keeps it from them. The app makes it once and registers its public half with the
// core on every connection (`device.answerKey.set`, with the app's signature over
// `clover/answer-key/1\n<device>\n<public key>\n<holder>`, which lane H's registry checks).
//
// Replacing it (`rotate`): other computers trust the key with their cards, so the core takes a new one only with the
// current key's hand-over (its signature over `clover/answer-key-rotate/1\n<device>\n<from>\n<to>\n<at>`) and the user's
// yes on a sealed change card (lane C's `answer-key-rotate`). The app keeps answering with the current key until that
// card is approved and the core holds the new one; then it keeps the new one (`resolved`). A no keeps the current key.
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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { answerKeyHolderFor, type AnswerKeyHolder } from "@waifucave/clover-protocol";

/** Where the key's private half is kept. */
export interface KeyVault {
  readonly held: AnswerKeyHolder;
  load(): Uint8Array | undefined;
  save(secret: Uint8Array): void;
  clear(): void;
}

/** What safeStorage offers (Electron's), so the vault is testable without it. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

/** The OS's store, through safeStorage: the file holds only what the OS's own key encrypted. Held through the
 *  protocol's own choice (macOS's Keychain limited to the signed app; nothing elsewhere this app can prove). */
export function safeStorageVault(file: string, storage: SafeStorageLike, platform: NodeJS.Platform = process.platform): KeyVault {
  return {
    held: answerKeyHolderFor(platform === "darwin" ? "macos" : platform === "win32" ? "windows" : "linux", { appKeychain: platform === "darwin" }),
    load() {
      if (!existsSync(file) || !storage.isEncryptionAvailable()) return undefined;
      try {
        return new Uint8Array(Buffer.from(storage.decryptString(readFileSync(file)), "base64"));
      } catch {
        return undefined;
      }
    },
    save(secret) {
      if (!storage.isEncryptionAvailable()) throw new Error("this computer's protected store isn't available");
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, storage.encryptString(Buffer.from(secret).toString("base64")), { mode: 0o600 });
    },
    clear() {
      rmSync(file, { force: true });
    },
  };
}

/** A vault in memory: a headless run's and the tests'. */
export function memoryVault(held: AnswerKeyHolder = "none"): KeyVault {
  let secret: Uint8Array | undefined;
  return { held, load: () => secret, save: (s) => void (secret = new Uint8Array(s)), clear: () => void (secret = undefined) };
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
  /** A replacement waiting on its card: the new key, kept in memory alone until the core holds it. */
  private pending: { card: string; key: KeyObject } | undefined;

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

  /** The public half, raw (32 bytes), base64. */
  publicKey(): string {
    return rawPublic(this.private());
  }

  /** The card a replacement waits on, if one does. */
  get pendingCard(): string | undefined {
    return this.pending?.card;
  }

  get held(): AnswerKeyHolder {
    return this.vault.held;
  }

  sign(message: Uint8Array): Uint8Array {
    return new Uint8Array(sign(null, Buffer.from(message), this.private()));
  }

  /** Starts replacing the key: a new one, registered under its own signature with the current key's hand-over. The
   *  current key stays until the core holds the new one (`resolved`, on the card's yes). */
  async rotate(client: AnswerKeyClient, deviceId: string, now: number = Date.now()): Promise<RotationStart> {
    if (this.pending) return { card: this.pending.card };
    const current = this.private();
    const from = rawPublic(current);
    const { privateKey: next } = generateKeyPairSync("ed25519");
    const to = rawPublic(next);
    const params = {
      publicKey: to, held: this.held,
      signature: b64(sign(null, Buffer.from(answerKeyStatement(deviceId, to, this.held)), next)),
      rotation: { from, at: now, signature: b64(sign(null, Buffer.from(answerKeyRotateStatement(deviceId, from, to, now)), current)) },
    };
    try {
      const r = await client.request<{ applied: boolean; card?: string }>("device.answerKey.set", params, 15_000);
      if (r.applied) {
        this.adopt(next);
        return { applied: true };
      }
      if (typeof r.card !== "string") return { refused: "the core didn't say which card" };
      this.pending = { card: r.card, key: next };
      this.log("answer key: replacing it waits on its card");
      return { card: r.card };
    } catch (err) {
      const why = err instanceof Error ? err.message.slice(0, 200) : "refused";
      this.log(`answer key: not replaced (${why})`);
      return { refused: why };
    }
  }

  /** A card resolved. On the pending replacement's yes, the app keeps the new key once the core holds it (registering it
   *  again applies at once then); on anything else it keeps the current key. True when the key changed. */
  async resolved(client: AnswerKeyClient, deviceId: string, cardId: string, outcome: string): Promise<boolean> {
    const p = this.pending;
    if (!p || p.card !== cardId) return false;
    this.pending = undefined;
    if (outcome !== "approved") {
      this.log(`answer key: kept (the replacement was ${outcome})`);
      return false;
    }
    const to = rawPublic(p.key);
    const signature = b64(sign(null, Buffer.from(answerKeyStatement(deviceId, to, this.held)), p.key));
    for (let i = 0; i < ADOPT_TRIES; i++) {
      try {
        await client.request("device.answerKey.set", { publicKey: to, held: this.held, signature }, 10_000);
        this.adopt(p.key);
        this.log("answer key: replaced");
        return true;
      } catch {
        await new Promise((r) => setTimeout(r, ADOPT_GAP_MS));
      }
    }
    this.log("answer key: the core didn't take the new key; the current one stays");
    return false;
  }

  /** Keeps `next` as the key: in the vault (when it can), and for signing from now on. */
  private adopt(next: KeyObject): void {
    try {
      this.vault.save(new Uint8Array(next.export({ format: "der", type: "pkcs8" })));
    } catch {
      this.log("answer key: the new key couldn't be kept in this computer's store; it stays in memory");
    }
    this.key = next;
  }

  /** Registers the key with the core, for this device; the core takes it only from a desktop, with this signature. */
  async register(client: AnswerKeyClient, deviceId: string): Promise<boolean> {
    try {
      const publicKey = this.publicKey();
      const signature = Buffer.from(this.sign(answerKeyStatement(deviceId, publicKey, this.held))).toString("base64");
      await client.request("device.answerKey.set", { publicKey, held: this.held, signature }, 10_000);
      this.log(`answer key: registered (${this.held})`);
      return true;
    } catch (err) {
      // An older daemon, a device that isn't a desktop, or one whose key was removed (pair again): said, not fatal.
      this.log(`answer key: not registered (${err instanceof Error ? err.message.slice(0, 200) : "refused"})`);
      return false;
    }
  }
}

function rawPublic(key: KeyObject): string {
  const der = createPublicKey(key).export({ format: "der", type: "spki" });
  return Buffer.from(der.subarray(der.length - 32)).toString("base64");
}

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");
