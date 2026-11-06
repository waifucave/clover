// Where the lease is held (spec §6.4 "The main holds a lease"; services/handshake/PROTOCOL.md "Groups and the lease",
// "The account channel"): the waifucave handshake keeps one lease record per account, and one per group of a user's
// account-less devices (owner decision 85; the controller's ruling on three or more devices). This file is the one
// place the lease talks to the service; everything above it sees device ids.
//
// * **The account scope.** The holder is a device id; requests carry the device's account token for the handshake.
// * **The group scope.** The holder is a member key, this device's own key for the group or a peer's, which the
//   registry's group record maps back to a device (linked computers tell each other their group keys,
//   `link.group.info` in links/group.ts). A holder no record names (a member this computer isn't linked to) is `holder: null` with
//   `state: "held"` in the views: "held by another computer in your group", never "no holder", and a device never
//   guesses whose lease it is.
// * **Failures.** A refusal (`409 held`) is `conflict` with the record the service holds. Anything that keeps the
//   request from an answer (no network, a 5xx, a timeout) is `offline`: the lease never treats an unanswered request
//   as a refusal, nor the other way round.
import { ContractError } from "../contracts/common";
import type { SecretStore } from "../contracts/secret-store";
import type { FileDeviceRegistry } from "../devices/registry";
import type { AccountClient } from "../identity/account";
import { ed25519FromSecret, type Ed25519Key } from "../identity/keys";
import { groupKeyRef, HANDSHAKE_AUDIENCE, HandshakeError, type HandshakeClient, type LeaseOp, type LeaseRecord } from "../links/handshake";

/** The service's lease record, with its holder as a device id (undefined when no one this device knows holds it). */
export interface ScopeLease {
  holder: string | null;
  /** The holder as the service names it (a member key or a device id), for comparing two reads. */
  holderRaw: string | null;
  epoch: number;
  expiresAt: number | null;
}

export interface LeaseScope {
  /** `account` or `group:<id>`, for logs and views. */
  readonly id: string;
  op(op: LeaseOp, epoch: number, ttlSec: number): Promise<ScopeLease>;
  read(): Promise<ScopeLease>;
}

/** Runs a request against the service, as the lease sees its outcome. */
async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ContractError) throw err;
    if (err instanceof HandshakeError && err.code === "not_voter") {
      // Group recovery (proposal 4): a member takes the lease over only once it votes.
      throw new ContractError("refused", "this computer can be made the main computer once it votes in your devices' group (72 hours after it joined), or from the main computer now");
    }
    if (err instanceof HandshakeError && err.status >= 400 && err.status < 500 && err.status !== 429) {
      throw new ContractError(err.status === 410 ? "not_found" : "refused", `the handshake refused the lease request (${err.status} ${err.code})`);
    }
    throw new ContractError("offline", "the handshake can't be reached");
  }
}

function asScopeLease(r: LeaseRecord, deviceOf: (holder: string) => string | undefined): ScopeLease {
  return { holder: r.holder === null ? null : (deviceOf(r.holder) ?? null), holderRaw: r.holder, epoch: r.epoch, expiresAt: r.expiresAt };
}

function conflictLease(err: unknown, deviceOf: (holder: string) => string | undefined): never {
  if (err instanceof ContractError && err.code === "conflict") {
    const lease = (err.detail as { lease?: LeaseRecord } | undefined)?.lease;
    if (lease) throw new ContractError("conflict", err.message, { lease: asScopeLease(lease, deviceOf) });
  }
  throw err;
}

/** The lease of the account's devices. */
export class AccountLeaseScope implements LeaseScope {
  readonly id = "account";
  readonly #client: HandshakeClient;
  readonly #account: Pick<AccountClient, "tokens">;

  constructor(o: { client: HandshakeClient; account: Pick<AccountClient, "tokens"> }) {
    this.#client = o.client;
    this.#account = o.account;
  }

  async #token(): Promise<string> {
    const t = await this.#account.tokens.current(HANDSHAKE_AUDIENCE).catch(() => null);
    if (!t) throw new ContractError("offline", "no account token for the handshake");
    return t.value.reveal();
  }

  async op(op: LeaseOp, epoch: number, ttlSec: number): Promise<ScopeLease> {
    const token = await this.#token();
    try {
      return asScopeLease(await call(() => this.#client.accountLease(token, { op, epoch, ttl: ttlSec })), (d) => d);
    } catch (err) {
      conflictLease(err, (d) => d);
    }
  }

  async read(): Promise<ScopeLease> {
    const token = await this.#token();
    return asScopeLease((await call(() => this.#client.readAccount(token))).lease, (d) => d);
  }
}

/** The lease of the user's account-less devices, in their group. */
export class GroupLeaseScope implements LeaseScope {
  readonly id: string;
  readonly #client: HandshakeClient;
  readonly #registry: FileDeviceRegistry;
  readonly #group: string;
  readonly #key: Ed25519Key;

  private constructor(o: { client: HandshakeClient; registry: FileDeviceRegistry; group: string; key: Ed25519Key }) {
    this.#client = o.client;
    this.#registry = o.registry;
    this.#group = o.group;
    this.#key = o.key;
    this.id = `group:${o.group}`;
  }

  /** The scope of the registry's group, with this device's key for it from the secret store; undefined when this
   *  device is in no group. */
  static async open(o: { client: HandshakeClient; registry: FileDeviceRegistry; store: SecretStore }): Promise<GroupLeaseScope | undefined> {
    const g = o.registry.group();
    if (!g) return undefined;
    const stored = await o.store.get(groupKeyRef(g.id));
    if (!stored) return undefined;
    return new GroupLeaseScope({ client: o.client, registry: o.registry, group: g.id, key: ed25519FromSecret(stored.value) });
  }

  get group(): string {
    return this.#group;
  }

  /** The device a member key belongs to: this one's own, or a member the group record names. */
  deviceOf = (key: string): string | undefined => {
    const g = this.#registry.group();
    if (!g || g.id !== this.#group) return undefined;
    if (key === g.ownKey) return this.#registry.self().id;
    for (const [device, m] of Object.entries(g.members)) if (m.key === key) return device;
    return undefined;
  };

  async op(op: LeaseOp, epoch: number, ttlSec: number): Promise<ScopeLease> {
    try {
      return asScopeLease(await call(() => this.#client.lease(this.#group, this.#key, { op, epoch, ttl: ttlSec })), this.deviceOf);
    } catch (err) {
      conflictLease(err, this.deviceOf);
    }
  }

  async read(): Promise<ScopeLease> {
    return asScopeLease((await call(() => this.#client.readGroup(this.#group, this.#key))).lease, this.deviceOf);
  }
}
