// What keeps this device findable (B2 of H-M1's review; spec §8.3 "Connect early, stay connected"): the handshake
// directories only answer when asked, and this is what asks.
//
// * **Publish:** this device's addresses go to every pair and every device of the account at start, before the
//   published record runs out (every `republishMs`, under the record's 15-minute TTL), and at once on a network change
//   or a wake, since a re-dial behind NATs needs fresh addresses at the handshake.
// * **Sockets:** one per registered account-less pair and one for the account, so a peer's records, its "dial now" and
//   the account's lease arrive at once. A socket that closes is opened again with backoff; an account socket's
//   24-hour `reauth` close is opened again at once with a fresh token.
// * **The account's devices** are taken from the account at start, when this device signs in, when the account's
//   socket names a device this one doesn't know, and on each republish.
// * **"Dial now"** goes out from the directories themselves as a dial asks for its target.
import type { Unsubscribe } from "../contracts/common";
import type { FileDeviceRegistry } from "../devices/registry";
import type { AccountDirectory } from "./account-directory";
import type { HandshakeDirectory } from "./handshake-directory";

export interface DirectoryDriverOptions {
  registry: FileDeviceRegistry;
  pairs?: HandshakeDirectory;
  account?: AccountDirectory;
  /** Whether this device is signed in now. */
  signedIn(): Promise<boolean>;
  /** Takes the account's devices into the registry (`syncAccountDevices`). */
  syncAccount?(): Promise<void>;
  /** Everything a refresh does besides publishing: the net report, pending registrations, pending revocations. */
  refresh(): Promise<void>;
  republishMs?: number;
  backoffMs?: readonly number[];
  log?(line: string): void;
  /** For tests: a WebSocket constructor. */
  WebSocket?: typeof WebSocket;
}

export class DirectoryDriver {
  readonly #o: DirectoryDriverOptions;
  readonly #pairSockets = new Map<string, { close?: () => void; attempt: number; timer?: ReturnType<typeof setTimeout> }>();
  #accountSocket: { ws?: WebSocket; attempt: number; timer?: ReturnType<typeof setTimeout> } | undefined;
  #republish: ReturnType<typeof setInterval> | undefined;
  #closed = false;
  #refreshing: Promise<void> | undefined;
  readonly #offs: Unsubscribe[] = [];

  constructor(o: DirectoryDriverOptions) {
    this.#o = o;
  }

  start(): void {
    void this.refresh();
    this.#republish = setInterval(() => void this.refresh(), this.#o.republishMs ?? 10 * 60_000);
    (this.#republish as { unref?: () => void }).unref?.();
    this.#offs.push(this.#o.registry.watch((c) => {
      if (c.type === "revoked") this.#closePair(c.id);
    }));
  }

  /** A pairing finished (its pair registered at the service): publish to it and open its socket now. */
  paired(): Promise<void> {
    return this.refresh();
  }

  /** The OS reported a network change or a wake: fresh addresses everywhere now, and the sockets back. */
  networkChanged(): Promise<void> {
    return this.refresh();
  }

  /** One refresh at a time; a second ask while one runs waits for it. */
  refresh(): Promise<void> {
    if (this.#refreshing) return this.#refreshing;
    this.#refreshing = (async () => {
      try {
        await this.#o.refresh().catch((e: unknown) => this.#log(`refresh: ${errText(e)}`));
        const signedIn = await this.#o.signedIn().catch(() => false);
        if (signedIn && this.#o.syncAccount) await this.#o.syncAccount().catch((e: unknown) => this.#log(`the account's devices: ${errText(e)}`));
        await this.#o.pairs?.publish().catch((e: unknown) => this.#log(`publishing to pairs: ${errText(e)}`));
        if (signedIn) await this.#o.account?.publish().catch((e: unknown) => this.#log(`publishing to the account: ${errText(e)}`));
        this.#ensureSockets(signedIn);
      } finally {
        this.#refreshing = undefined;
      }
    })();
    return this.#refreshing;
  }

  close(): void {
    this.#closed = true;
    if (this.#republish) clearInterval(this.#republish);
    for (const off of this.#offs.splice(0)) off();
    for (const id of [...this.#pairSockets.keys()]) this.#closePair(id);
    if (this.#accountSocket) {
      if (this.#accountSocket.timer) clearTimeout(this.#accountSocket.timer);
      this.#accountSocket.ws?.close(1000, "done");
      this.#accountSocket = undefined;
    }
  }

  #ensureSockets(signedIn: boolean): void {
    if (this.#closed) return;
    if (this.#o.pairs) {
      for (const p of this.#o.registry.pairs()) {
        if (p.endedAt !== undefined || p.registeredAt === undefined || this.#pairSockets.has(p.peer)) continue;
        this.#openPair(p.peer);
      }
    }
    if (signedIn && this.#o.account && !this.#accountSocket) this.#openAccount();
  }

  #openPair(device: string): void {
    const pairs = this.#o.pairs!;
    const entry = this.#pairSockets.get(device) ?? { attempt: 0 };
    this.#pairSockets.set(device, entry);
    void pairs.connectSocket(device, (code) => {
      entry.close = undefined;
      // Ended or revoked at the service: no point coming back.
      if (code === 4003 || this.#closed) {
        this.#pairSockets.delete(device);
        return;
      }
      this.#retryPair(device, entry);
    }).then((close) => {
      entry.close = close;
      entry.attempt = 0;
    }, () => this.#retryPair(device, entry));
  }

  #retryPair(device: string, entry: { attempt: number; timer?: ReturnType<typeof setTimeout> }): void {
    if (this.#closed || !this.#pairSockets.has(device)) return;
    const wait = this.#backoff(entry.attempt++);
    entry.timer = setTimeout(() => {
      if (this.#registered(device)) this.#openPair(device);
      else this.#pairSockets.delete(device);
    }, wait);
    (entry.timer as { unref?: () => void }).unref?.();
  }

  #closePair(device: string): void {
    const e = this.#pairSockets.get(device);
    if (!e) return;
    if (e.timer) clearTimeout(e.timer);
    e.close?.();
    this.#pairSockets.delete(device);
  }

  #registered(device: string): boolean {
    const p = this.#o.registry.pairWith(device);
    return p !== undefined && p.registeredAt !== undefined;
  }

  #openAccount(): void {
    const account = this.#o.account!;
    const entry = this.#accountSocket ?? { attempt: 0 };
    this.#accountSocket = entry;
    const Ws = this.#o.WebSocket ?? WebSocket;
    void account.ticket().then((url) => {
      if (this.#closed) return;
      const ws = new Ws(url);
      entry.ws = ws;
      const ping = setInterval(() => ws.readyState === Ws.OPEN && ws.send("ping"), 30_000);
      (ping as { unref?: () => void }).unref?.();
      ws.addEventListener("open", () => (entry.attempt = 0));
      ws.addEventListener("message", (ev) => {
        if (typeof ev.data !== "string" || ev.data === "pong") return;
        let f: Record<string, unknown>;
        try {
          f = JSON.parse(ev.data) as Record<string, unknown>;
        } catch {
          return;
        }
        void account.takeFrame(f);
        // A device the registry doesn't know yet came online: take the account's list again.
        if (f.t === "presence" && typeof f.device === "string" && !this.#o.registry.get(f.device)) void this.#o.syncAccount?.().catch(() => undefined);
      });
      ws.addEventListener("close", (ev) => {
        clearInterval(ping);
        entry.ws = undefined;
        if (this.#closed || this.#accountSocket !== entry) return;
        // 4010: the token's 24 hours are up; open a new one with a fresh token at once.
        const wait = ev.code === 4010 ? 0 : this.#backoff(entry.attempt++);
        entry.timer = setTimeout(() => this.#openAccount(), wait);
        (entry.timer as { unref?: () => void }).unref?.();
      });
    }, () => {
      if (this.#closed) return;
      entry.timer = setTimeout(() => this.#openAccount(), this.#backoff(entry.attempt++));
      (entry.timer as { unref?: () => void }).unref?.();
    });
  }

  #backoff(attempt: number): number {
    const steps = this.#o.backoffMs ?? [1_000, 2_000, 5_000, 15_000, 30_000, 60_000];
    return steps[Math.min(attempt, steps.length - 1)]!;
  }

  #log(line: string): void {
    this.#o.log?.(`[links] ${line}`);
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
