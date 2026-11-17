// MOSS's own answer key (spec §5.5 "Only sealed buttons answer", ruling C, item 91): one Ed25519 key per (device,
// program), held by MOSS apart from MOSS Code's and the host's, which signs the answers of the sealed cards MOSS draws.
// MOSS registers it with `device.programKey.set` (never MOSS Code's `device.answerKey.set`), signed by the key itself
// over `programAnswerKeyStatement` (the device, the program `moss`, the public key, how it is held, the algorithm). The
// engine takes the program from the connection's signed identity, never from anything MOSS says.
//
// Where it is kept: the OS's own store through Electron's safeStorage, in MOSS's own user data, in a packaged app; in
// memory alone in a dev, unpackaged, headless or test run, so nothing ever brings a Keychain dialog up. No biometric or
// passcode gate, ever. The key never goes into a log line, an error or the engine; signing reads it from memory.
//
// Replacing a registered key is a sensitive change (a sealed card, `{ applied: false, card }`); MOSS's first build never
// replaces its key, and says so if the engine already holds another one for MOSS on this device.
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { programAnswerKeyStatement, type AnswerKeyHolder } from "@waifucave/moss-protocol";
import { RpcCallError } from "./client";

export interface KeyVault {
  readonly held: AnswerKeyHolder;
  load(): Uint8Array | undefined;
  save(secret: Uint8Array): void;
}

export function memoryVault(): KeyVault {
  let kept: Uint8Array | undefined;
  return { held: "none", load: () => kept, save: (s) => { kept = s; } };
}

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

/** The OS's store, through safeStorage: the file holds only what the OS's key encrypted. On macOS that is a Keychain item
 *  only the signed app reads without asking ("app-keychain"); elsewhere the engine hears "none" (the risk accepted). */
export function safeStorageVault(file: string, storage: SafeStorageLike, platform: NodeJS.Platform = process.platform): KeyVault {
  return {
    held: platform === "darwin" ? "app-keychain" : "none",
    load: () => {
      if (!existsSync(file) || !storage.isEncryptionAvailable()) return undefined;
      try {
        return new Uint8Array(Buffer.from(storage.decryptString(readFileSync(file)), "base64"));
      } catch {
        return undefined;
      }
    },
    save: (secret) => {
      if (!storage.isEncryptionAvailable()) throw new Error("this computer's protected store isn't available");
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, storage.encryptString(Buffer.from(secret).toString("base64")), { mode: 0o600 });
      renameSync(tmp, file);
    },
  };
}

export type KeyState = { kind: "unregistered" } | { kind: "registered" } | { kind: "waiting"; why: string } | { kind: "refused"; why: string };

export interface KeyClient {
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
}

export class ProgramAnswerKey {
  private key: KeyObject | undefined;
  private stateValue: KeyState = { kind: "unregistered" };
  private waiters: (() => void)[] = [];

  constructor(private readonly vault: KeyVault, private readonly log: (line: string) => void = () => {}) {}

  private privateKey(): KeyObject {
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
    const der = createPublicKey(this.privateKey()).export({ format: "der", type: "spki" });
    return Buffer.from(der.subarray(der.length - 32)).toString("base64");
  }

  get held(): AnswerKeyHolder {
    return this.vault.held;
  }

  get state(): KeyState {
    return this.stateValue;
  }

  /** Signs bytes with the key (an answer's `programCardAnswerSigningInput`). Never prompts. */
  sign(message: Uint8Array): Uint8Array {
    return new Uint8Array(sign(null, Buffer.from(message), this.privateKey()));
  }

  /** The registration's own proof: the key's signature over its statement for this device and the `moss` program. */
  registration(device: string): { publicKey: string; held: AnswerKeyHolder; alg: "ed25519"; signature: string } {
    const publicKey = this.publicKey();
    const statement = programAnswerKeyStatement({ device, program: "moss", publicKey, held: this.held, alg: "ed25519" });
    return { publicKey, held: this.held, alg: "ed25519", signature: Buffer.from(this.sign(new TextEncoder().encode(statement))).toString("base64") };
  }

  private setState(s: KeyState): void {
    this.stateValue = s;
    if (s.kind === "registered" || s.kind === "refused") {
      for (const w of this.waiters.splice(0)) w();
    }
  }

  /** Registers on a connection, trying again on a growing wait while the engine can't take it yet ("not served yet",
   *  a timeout): a press waits on it. `live` says whether the connection is still the current one. */
  async register(client: KeyClient, device: string, live: () => boolean, waits: readonly number[] = [500, 1_000, 2_000, 5_000, 10_000, 30_000]): Promise<KeyState> {
    for (let attempt = 0; live(); attempt++) {
      try {
        const r = await client.request<{ applied?: unknown; card?: unknown }>("device.programKey.set", this.registration(device), 10_000);
        if (r.applied === true) {
          this.log("answer key: MOSS's key is registered for this device");
          this.setState({ kind: "registered" });
        } else {
          this.log("answer key: the engine holds another key for MOSS on this device");
          this.setState({ kind: "refused", why: "The engine holds another answer key for MOSS on this computer." });
        }
        return this.stateValue;
      } catch (err) {
        const why = err instanceof RpcCallError ? `${err.code}: ${err.message}` : String(err);
        // A refusal of the call itself (invalid params: the key's signature, a revoked device) won't change by asking
        // again; anything else ("not served yet", a timeout, a closed connection) is tried again.
        if (err instanceof RpcCallError && err.code === -32602) {
          this.setState({ kind: "refused", why: why.slice(0, 200) });
          return this.stateValue;
        }
        this.stateValue = { kind: "waiting", why: why.slice(0, 200) };
        const wait = waits[Math.min(attempt, waits.length - 1)] ?? 30_000;
        await new Promise((r) => setTimeout(r, wait));
      }
    }
    return this.stateValue;
  }

  /** Waits up to `ms` for the registration to settle; the state then. */
  async ready(ms: number): Promise<KeyState> {
    if (this.stateValue.kind === "registered" || this.stateValue.kind === "refused") return this.stateValue;
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, ms);
      this.waiters.push(() => { clearTimeout(t); resolve(); });
    });
    return this.stateValue;
  }

  /** A new connection registers afresh. */
  reset(): void {
    this.stateValue = { kind: "unregistered" };
  }
}
