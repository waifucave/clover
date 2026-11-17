// MOSS's own answer key (spec §5.5 "Only sealed buttons answer", ruling C, item 91): one Ed25519 key per (device,
// program), held by MOSS apart from MOSS Code's and the host's, which signs the answers of the sealed cards MOSS draws.
// MOSS registers it with `device.programKey.set` (never MOSS Code's `device.answerKey.set`), signed by the key itself
// over `programAnswerKeyStatement` (the device, the program `moss`, the public key, how it is held, the algorithm). The
// engine takes the program from the connection's signed identity, never from anything MOSS says.
//
// Where it is kept (`vaultChoice`, as MOSS Code keeps its own): the OS's own store through Electron's safeStorage, in
// MOSS's own user data, in a packaged app; in memory alone in an unpackaged (dev), headless or test run, or the acceptance's
// kept file in its temp home. Never a plain file of a real build. No biometric or passcode gate, ever. The key never goes into a log line, an error or the engine; signing reads it from memory.
//
// Replacing a registered key is a sensitive change: the engine takes it only with the held key's hand-over and then on a
// sealed card; without one it refuses at once (no card). MOSS's first build never replaces its key, and says so if the
// engine already holds another one for MOSS on this device. A packaged MOSS keeps its key across starts (the OS's
// store), so an ordinary restart registers the same key and nothing is asked; a kept key that can't be read at one start
// is never written over.
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
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
export function safeStorageVault(file: string, storage: SafeStorageLike, platform: NodeJS.Platform = process.platform, log: (line: string) => void = () => {}): KeyVault {
  /** The kept key is there but couldn't be read this start (the store locked or refused, for now): it is never written
   *  over, so a later start that can read it registers the same key again (no hand-over could replace a lost one). */
  let unreadable = false;
  return {
    held: platform === "darwin" ? "app-keychain" : "none",
    load: () => {
      if (!existsSync(file)) return undefined;
      if (!storage.isEncryptionAvailable()) { unreadable = true; return undefined; }
      try {
        return new Uint8Array(Buffer.from(storage.decryptString(readFileSync(file)), "base64"));
      } catch {
        unreadable = true;
        return undefined;
      }
    },
    save: (secret) => {
      if (unreadable) {
        log("answer key: the kept key couldn't be read this start; it is kept as it is, and this start's key is in memory only");
        return;
      }
      if (!storage.isEncryptionAvailable()) throw new Error("this computer's protected store isn't available");
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, storage.encryptString(Buffer.from(secret).toString("base64")), { mode: 0o600 });
      renameSync(tmp, file);
    },
  };
}

/** A key kept in a plain file (0600): the acceptance run's alone (`MOSS_TEST_ANSWER_KEY`, a file beside its throwaway
 *  keychain file in a temp home, read only by a test-marked headless build), so the run can sign as an attacker holding
 *  MOSS's key would, and a MOSS it restarts registers the same key. Never a real build's: there the key is in the OS's
 *  store or in memory. */
export function fileVault(file: string): KeyVault {
  return {
    held: "none",
    load: () => {
      try {
        if (!existsSync(file)) return undefined;
        const text = readFileSync(file, "utf8").trim();
        return text === "" ? undefined : new Uint8Array(Buffer.from(text, "base64"));
      } catch {
        return undefined;
      }
    },
    save: (secret) => {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, Buffer.from(secret).toString("base64"), { mode: 0o600 });
      renameSync(tmp, file);
    },
  };
}

/** Where MOSS keeps its answer key, by how it runs, as MOSS Code keeps its own (apps/desktop/src/main/index.ts
 *  `answerKey()`); a secret is never in a plain file of a real build:
 *  - a test-marked headless run given an absolute `MOSS_TEST_ANSWER_KEY`: that file (the acceptance's kept key, in a
 *    throwaway temp home; a real build compiles the variable out);
 *  - any other headless or test-marked run, and any unpackaged run (the dev app from the checkout): memory, a new key at
 *    each start (the engine then asks for the new key on a replacement card, as for MOSS Code's dev key);
 *  - a packaged app, dist or dev: the OS's store through safeStorage, unless Linux's store is plain text (then memory). */
export function vaultChoice(o: { packaged: boolean; headless: boolean; testBuild: boolean; profile: "dist" | "dev"; platform: NodeJS.Platform; testKeyFile?: string; linuxPlainText?: boolean }): { kind: "file"; file: string } | { kind: "memory" } | { kind: "safe-storage" } {
  if (o.testBuild && o.headless && o.testKeyFile !== undefined && isAbsolute(o.testKeyFile)) return { kind: "file", file: o.testKeyFile };
  if (o.headless || o.testBuild) return { kind: "memory" };
  if (!o.packaged) return { kind: "memory" };
  if (o.platform === "linux" && o.linuxPlainText === true) return { kind: "memory" };
  return { kind: "safe-storage" };
}

/** The engine's refusal of a key because it holds another one for MOSS here: "this program already has an answer key"
 *  (no hand-over sent), or a hand-over that isn't from the held key. Only these; any other invalid request (a connection
 *  that is closing, a hello said twice) is tried again. */
export function heldElsewhere(err: unknown): boolean {
  if (!(err instanceof RpcCallError) || err.code !== -32600) return false;
  const code = (err.data as { code?: unknown } | undefined)?.code;
  return /already has an answer key/.test(err.message) || code === "not-current" || code === "no-current-key";
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
        // A refusal of the call itself won't change by asking again: invalid params (the key's signature, a revoked
        // device), or an invalid request (the engine holds another key for MOSS here, and a key can't replace it without
        // the held key's hand-over, which a lost key can't give: no card is ever raised for it). Anything else ("not
        // served yet", a timeout, a closed connection) is tried again.
        if (heldElsewhere(err)) {
          this.log("answer key: the engine holds another key for MOSS on this device, and this one can't replace it");
          this.setState({ kind: "refused", why: "The engine holds another answer key for MOSS on this computer, so MOSS can't answer cards here." });
          return this.stateValue;
        }
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
