// The account's side of the device registry (spec §8.1): with a waifucave account, signing in is enough to add a
// device. This device registers its link key and box key with the account service; every device of the account is
// taken into the registry from the account's list (`{via: "account"}`), and a device revoked there is revoked here.
//
// And revocation's fan-out (§8.1, the controller's rulings): after the local revoke, which cuts the links at once,
// the revoking device tells every service that keeps state for the revoked one: the account service, the hooks
// forwarder and push (their `DELETE /v1/devices/:id`), the handshake's account scope, and for a pair without an account
// the handshake's pair (ended) and group (the member removed). A step that fails is reported and can be sent again;
// the local revoke never waits on it.
import { ContractError } from "../contracts/common";
import type { SecretStore } from "../contracts/secret-store";
import type { AccountClient } from "../identity/account";
import type { BoxKey } from "../identity/box-key";
import type { DeviceKey } from "../identity/device-key";
import { ed25519FromSecret } from "../identity/keys";
import { groupKeyRef, HANDSHAKE_AUDIENCE, type HandshakeClient, pairKeyRef, pairSecretRef } from "../links/handshake";
import type { FileDeviceRegistry } from "./registry";

/** A waifucave service that keeps per-device state, and the audience its account tokens name. */
export interface DeviceService {
  url: string;
  audience: string;
}

export const DEFAULT_DEVICE_SERVICES = {
  hooks: { url: "https://hooks.waifucave.com", audience: "hooks.waifucave.com" },
  push: { url: "https://push.waifucave.com", audience: "push.waifucave.com" },
  handshake: { url: "https://handshake.waifucave.com", audience: HANDSHAKE_AUDIENCE },
} as const satisfies Record<string, DeviceService>;

export interface AccountDevicesOptions {
  registry: FileDeviceRegistry;
  account: AccountClient;
  device: DeviceKey;
  boxKey: BoxKey;
}

/** Registers this device with the account and takes the account's devices into the registry. */
export async function syncAccountDevices(o: AccountDevicesOptions): Promise<{ added: string[]; revoked: string[] }> {
  const sub = await o.account.accountId();
  if (sub === null) throw new ContractError("refused", "not signed in");
  const self = o.registry.self();
  await o.account.registerDevice({ name: self.name, kind: self.kind, ...(self.os ? { os: self.os } : {}), boxKey: o.boxKey.publicKeyBase64Url });
  o.registry.setBoxKey(self.id, o.boxKey.publicKeyBase64Url);
  const added: string[] = [];
  const revoked: string[] = [];
  for (const d of await o.account.listDevices()) {
    if (d.id === self.id) continue;
    const local = o.registry.get(d.id);
    if (d.revokedAt !== undefined) {
      if (local && local.revokedAt === undefined) {
        await o.registry.revoke(d.id, "revoked on the account");
        revoked.push(d.id);
      }
      continue;
    }
    if (!local) {
      const runsCore = d.kind === "desktop" || d.kind === "server" || d.kind === "cloud";
      try {
        await o.registry.add({ id: d.id, name: d.name, kind: d.kind, runsCore, publicKey: d.publicKey, ...(d.os ? { os: d.os } : {}), ...(runsCore ? { computer: d.name } : {}) }, { via: "account", account: sub });
        added.push(d.id);
      } catch (err) {
        // A key revoked here stays revoked: the account can't bring it back.
        if (!(err instanceof ContractError && err.code === "refused")) throw err;
        continue;
      }
    }
    if (o.registry.get(d.id)?.revokedAt === undefined) o.registry.setBoxKey(d.id, d.boxKey);
  }
  return { added, revoked };
}

export interface RevokeOptions {
  registry: FileDeviceRegistry;
  store: Pick<SecretStore, "get" | "delete">;
  handshake?: HandshakeClient;
  account?: AccountClient;
  services?: { hooks?: DeviceService; push?: DeviceService; handshake?: DeviceService };
  fetch?: (req: Request) => Promise<Response>;
}

export type RevokeStep = "account" | "hooks" | "push" | "handshake-account" | "handshake-pair" | "handshake-group";

export interface RevokeOutcome {
  /** The steps after the local revoke, each done or failed (with a reason that never holds a secret). */
  steps: { step: RevokeStep; ok: boolean; error?: string }[];
}

/** Revokes a device here (its links drop at once), then at every service that keeps state for it. */
export async function revokeDevice(o: RevokeOptions, id: string, reason?: string): Promise<RevokeOutcome> {
  const pair = o.registry.pairWith(id);
  const group = o.registry.group();
  const memberKey = group?.members[id]?.key;
  await o.registry.revoke(id, reason);
  const steps: RevokeOutcome["steps"] = [];
  const run = async (step: RevokeStep, fn: () => Promise<void>) => {
    try {
      await fn();
      steps.push({ step, ok: true });
    } catch (err) {
      steps.push({ step, ok: false, error: err instanceof Error ? err.message : "failed" });
    }
  };
  if (pair) {
    const hs = o.handshake;
    if (hs && pair.registeredAt !== undefined) {
      await run("handshake-pair", async () => {
        const stored = await o.store.get(pairKeyRef(pair.pairId));
        if (!stored) throw new ContractError("not_found", "the pair's key is gone");
        await hs.endPair(pair.pairId, ed25519FromSecret(stored.value));
      });
    }
    await o.store.delete(pairKeyRef(pair.pairId));
    await o.store.delete(pairSecretRef(pair.pairId));
  }
  if (group && memberKey && o.handshake) {
    const hs = o.handshake;
    await run("handshake-group", async () => {
      const stored = await o.store.get(groupKeyRef(group.id));
      if (!stored) throw new ContractError("not_found", "the group's key is gone");
      await hs.removeGroupMember(group.id, ed25519FromSecret(stored.value), memberKey);
    });
  }
  const account = o.account;
  if (account && (await account.accountId()) !== null) {
    await run("account", () => account.revokeDevice(id));
    const fetcher = o.fetch ?? ((req: Request) => fetch(req));
    const del = async (svc: DeviceService, path: string) => {
      const token = await account.tokens.current(svc.audience);
      if (!token) throw new ContractError("refused", "no account token");
      const res = await fetcher(new Request(`${svc.url.replace(/\/+$/, "")}${path}`, { method: "DELETE", headers: { authorization: `Bearer ${token.value.reveal()}` } }));
      if (!res.ok && res.status !== 404) throw new ContractError("failed", `${svc.audience} answered ${res.status}`);
    };
    const s = o.services ?? DEFAULT_DEVICE_SERVICES;
    if (s.hooks) await run("hooks", () => del(s.hooks!, `/v1/devices/${encodeURIComponent(id)}`));
    if (s.push) await run("push", () => del(s.push!, `/v1/devices/${encodeURIComponent(id)}`));
    if (s.handshake) await run("handshake-account", () => del(s.handshake!, `/v1/accounts/self/devices/${encodeURIComponent(id)}`));
  }
  return { steps };
}
