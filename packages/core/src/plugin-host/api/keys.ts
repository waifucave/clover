// `keys.publicKey`, `keys.open` and `keys.delete` (spec §5.4 "The account token and per-computer keys", item 84): a
// plugin of the bundled `clover` tree gets X25519 key pairs per computer, by name, whose private half never leaves the
// core. Owner: lane A.
//
// * **Where:** only the `clover` plugin-host process (the catalog's `where: "clover"`, which the router and the process
//   check enforce): the forwarder opens webhooks sealed to its key.
// * **Whose:** each key is its plugin's own (the plugin's id and the key's name), never another plugin's, so no
//   capability is asked: a plugin's own keys are its own data.
// * **The pair:** made on the first `publicKey(name)`, kept as a device item in the secret store (never synced, never
//   given to the plugin host, whose workers share memory, §5.2), under a name derived from the plugin's id that no
//   plugin's `secrets.get` reaches (that reads only the plugin's own items). At most KEYS_PER_PLUGIN_MAX per plugin.
// * **`open`:** HPKE base mode, single shot, DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-256-GCM (RFC 9180), the
//   forwarder's suite and the handshake boxes' (`identity/box-key.ts`). `not_found` for a key never made, `invalid`
//   for a message that doesn't open. `open` never makes a key.
// * **`delete`:** drops the pair; what was sealed to it can't be opened again.
import { createHash } from "node:crypto";
import { KEY_NAME_RE, KEYS_PER_PLUGIN_MAX } from "@waifucave/clover-plugin-sdk";
import { ContractError } from "../../contracts/common";
import type { SecretRef, SecretStore } from "../../contracts/secret-store";
import { BoxKey } from "../../identity/box-key";
import type { ApiCallContext, ApiHandlers } from "./router";

/** The largest sealed message `open` takes (a webhook's body, the forwarder's cap with room). */
export const KEYS_OPEN_MAX_BYTES = 8 * 1024 * 1024;

const ownerSlug = (pluginId: string): string => createHash("sha256").update(pluginId).digest("hex").slice(0, 24);
/** The device item a plugin's key lives in: `plugin-key:<the plugin's slug>:<name>`. */
export function pluginKeyRef(pluginId: string, name: string): SecretRef {
  return { owner: { kind: "device" }, name: `plugin-key:${ownerSlug(pluginId)}:${name}` };
}

function nameArg(args: readonly unknown[]): string {
  const name = args[0];
  if (typeof name !== "string" || !KEY_NAME_RE.test(name)) throw new ContractError("invalid", "a key's name is 1 to 64 of a-z, 0-9, '.', '_' and '-', starting with a letter or digit");
  return name;
}

function bytesOf(v: unknown, what: string, optional: boolean): Uint8Array | undefined {
  if (v === undefined && optional) return undefined;
  if (!(v instanceof Uint8Array)) throw new ContractError("invalid", `${what} is bytes (a Uint8Array)`);
  return v;
}

export function keysApi(o: { secrets: Pick<SecretStore, "get" | "set" | "delete" | "list"> }): ApiHandlers {
  /** How many keys a plugin holds now. */
  const count = async (pluginId: string): Promise<number> => {
    const prefix = `plugin-key:${ownerSlug(pluginId)}:`;
    return (await o.secrets.list({ kind: "device" })).filter((m) => m.ref.name.startsWith(prefix)).length;
  };
  const load = async (ctx: ApiCallContext, name: string, create: boolean): Promise<BoxKey | undefined> => {
    const ref = pluginKeyRef(ctx.pluginId, name);
    const scoped = { get: (_r: SecretRef) => o.secrets.get(ref), set: (_r: SecretRef, value: string, opts?: { synced?: boolean }) => o.secrets.set(ref, value, opts) };
    if (!create) return (await o.secrets.get(ref)) === null ? undefined : BoxKey.loadOrCreate(scoped);
    if ((await o.secrets.get(ref)) === null && (await count(ctx.pluginId)) >= KEYS_PER_PLUGIN_MAX) {
      throw new ContractError("refused", `${ctx.pluginId} holds ${KEYS_PER_PLUGIN_MAX} keys on this computer already: delete one first`);
    }
    return BoxKey.loadOrCreate(scoped);
  };
  return {
    "keys.publicKey": async (ctx, args) => {
      const key = (await load(ctx, nameArg(args), true))!;
      return new Uint8Array(key.publicKey);
    },
    "keys.open": async (ctx, args) => {
      const name = nameArg(args);
      const sealed = args[1] as { enc?: unknown; ciphertext?: unknown; info?: unknown; aad?: unknown } | undefined;
      if (typeof sealed !== "object" || sealed === null) throw new ContractError("invalid", "keys.open takes { enc, ciphertext, info?, aad? }");
      const enc = bytesOf(sealed.enc, "enc", false)!;
      const ciphertext = bytesOf(sealed.ciphertext, "ciphertext", false)!;
      const info = bytesOf(sealed.info, "info", true) ?? new Uint8Array(0);
      const aad = bytesOf(sealed.aad, "aad", true) ?? new Uint8Array(0);
      if (enc.length + ciphertext.length + info.length + aad.length > KEYS_OPEN_MAX_BYTES) throw new ContractError("invalid", `a sealed message is at most ${KEYS_OPEN_MAX_BYTES} bytes`);
      const key = await load(ctx, name, false);
      if (key === undefined) throw new ContractError("not_found", `${ctx.pluginId} has no key ${name} on this computer`);
      const plain = key.openParts(enc, ciphertext, aad, info);
      if (plain === undefined) throw new ContractError("invalid", "the message doesn't open with that key");
      return new Uint8Array(plain);
    },
    "keys.delete": async (ctx, args) => {
      await o.secrets.delete(pluginKeyRef(ctx.pluginId, nameArg(args)));
    },
  };
}
