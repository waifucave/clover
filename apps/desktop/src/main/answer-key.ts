// This desktop's answer key (spec §5.5, decision 91; lane H's ask in H-M1): an Ed25519 key the app holds apart from
// the core's link key, which signs this desktop's answers to cards and the user's own messages (E-M3), so plugin code
// can't sign with it where the OS keeps it from them. The app makes it once and registers its public half with the
// core on every connection (`device.answerKey.set`, with the app's signature over
// `clover/answer-key/1\n<device>\n<public key>\n<holder>`, which lane H's registry checks).
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
    held: answerKeyHolderFor(platform, { appKeychain: platform === "darwin" }),
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

  /** The public half, raw (32 bytes), base64. */
  publicKey(): string {
    const der = createPublicKey(this.private()).export({ format: "der", type: "spki" });
    return Buffer.from(der.subarray(der.length - 32)).toString("base64");
  }

  get held(): AnswerKeyHolder {
    return this.vault.held;
  }

  sign(message: Uint8Array): Uint8Array {
    return new Uint8Array(sign(null, Buffer.from(message), this.private()));
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
