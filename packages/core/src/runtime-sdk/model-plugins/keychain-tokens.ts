// Where a bundled model plugin's keys come from in the daemon: today's provider keychain slots. Owner: lane A.
//
// A plugin names a key by its `auth` entry (`secret`, or a `custom` entry's `handler`); the interim plugin API
// router (`plugin-api.ts`) asks `tokens(pluginId, name)` for it when the plugin's `net.fetch` needs it, and
// `secret(pluginId, name)` when a plugin in a process of its own reads it with `secrets.get`. The slots the
// providers' sign-ins and `credential.set` already write are the source, so a key a user stored before the plugins
// existed keeps working with no migration:
//
// * a bundled plugin (`clover/model-<provider>`, from the bundled tree) maps to its provider's inventory slot
//   (`credentialInventory()`: `<provider>:default`, `openai:default`, `codex-oauth:default`, `anthropic:default`,
//   `anthropic:console`), read as the daemon reads it (`readCredentialMaterial`): an api-key record gives its key,
//   an OAuth record its access token, a bearer record its token;
// * a signing plugin's own secret (Bedrock's `aws`, Vertex's `gcp-service-account`) is its provider's
//   `<provider>:default` record, handed over as stored: the plugin's own process parses it (`materialOfSecret`);
// * every other plugin's keys are its own items in the secret store, never a provider slot
//   (`secretStoreCredentials` in `plugin-api.ts`); `fallback` serves them.
//
// A 401 asks `newer(generation)`: the slot's refresher runs (Codex's refresh-token grant, the Console broker), and
// the record is read again. A generation is this process's own count of the values a slot has held.
import { readCredentialMaterial } from "../../auth/credential-material";
import type { SecretStore as DaemonSecretStore } from "../../auth/secret-store";
import type { PluginRecord, PluginRegistry } from "../../contracts/plugin-registry";
import type { ProviderRefresher } from "../host-credentials";
import { credentialInventory, DEFAULT_CREDENTIAL_ACCOUNT_ID } from "../keychain";
import { CODE_PLUGINS } from "./bundled";
import { isBundledClover } from "./load";
import type { ModelPluginApiOptions } from "./plugin-api";
import type { KeyedToken, KeyedTokenSource } from "@waifucave/clover-provider-runtime";

export interface KeychainModelPluginCredentialsOptions {
  registry: Pick<PluginRegistry, "get">;
  /** The daemon's own secret store (`KeychainSecretStore` in production). */
  secrets: DaemonSecretStore;
  /** Per slot account, how to renew it (`daemon.ts`'s `credentialRefreshers`). */
  refreshers?: Readonly<Record<string, ProviderRefresher>>;
  /** Keys of plugins that aren't bundled: their own items (`secretStoreCredentials`). */
  fallback?: Pick<ModelPluginApiOptions, "tokens" | "secret">;
  log?: (line: string) => void;
}

/** The keychain slot a bundled plugin's keys come from. */
export interface ModelPluginSlot {
  provider: string;
  account: string;
}

/** The provider a bundled clover model plugin serves (its one `models` entry), or undefined for any other plugin. */
export function bundledModelProviderOf(record: Pick<PluginRecord, "id" | "source" | "manifest"> | undefined): string | undefined {
  if (record === undefined || !isBundledClover(record)) return undefined;
  const models = record.manifest?.contributes?.models ?? [];
  return models.length === 1 ? models[0]!.provider : undefined;
}

/** The keychain slot a bundled plugin's key comes from: its provider's inventory slot, else `<provider>:default`. */
export function modelPluginSlotFor(provider: string): ModelPluginSlot {
  const slot = credentialInventory().find((s) => s.provider === provider);
  return { provider, account: slot?.secretName ?? `${provider}:${DEFAULT_CREDENTIAL_ACCOUNT_ID}` };
}

function tokenOf(material: Awaited<ReturnType<typeof readCredentialMaterial>>): string | null {
  if (material === null) return null;
  if (material.kind === "api-key") return material.key;
  if (material.kind === "oauth") return material.accessToken;
  return material.token;
}

export interface KeychainModelPluginCredentials extends Pick<ModelPluginApiOptions, "tokens" | "secret"> {
  /** Fills a code adapter's connection with what its sign-in holds beside the token (Codex's account id). */
  connectionFor<C extends { account?: string }>(pluginId: string, connection: C): C;
  /** Reads the OAuth sign-ins' account ids once (the code plugins with an `oauth-pkce` entry: Codex), so
   *  `connectionFor`, which is synchronous, has them before the first turn. Every later read refreshes them. */
  prime(): Promise<void>;
}

export function keychainModelPluginCredentials(opts: KeychainModelPluginCredentialsOptions): KeychainModelPluginCredentials {
  const generations = new Map<string, { value: string; generation: number }>();
  const accountIds = new Map<string, string>();
  const read = async (account: string): Promise<KeyedToken | null> => {
    const material = await readCredentialMaterial(opts.secrets, account);
    if (material?.kind === "oauth" && material.accountId !== undefined) accountIds.set(account, material.accountId);
    const value = tokenOf(material);
    if (value === null || value.length === 0) return null;
    const held = generations.get(account);
    if (held !== undefined && held.value === value) return { value, generation: held.generation };
    const generation = (held?.generation ?? 0) + 1;
    generations.set(account, { value, generation });
    return { value, generation };
  };
  const slotOf = (pluginId: string): ModelPluginSlot | undefined => {
    const provider = bundledModelProviderOf(opts.registry.get(pluginId));
    return provider === undefined ? undefined : modelPluginSlotFor(provider);
  };
  const none: KeyedTokenSource = { current: async () => null, newer: async () => null };
  return {
    tokens(pluginId, name) {
      const slot = slotOf(pluginId);
      if (slot === undefined) return opts.fallback?.tokens(pluginId, name) ?? none;
      return {
        current: () => read(slot.account),
        newer: async (generation) => {
          const refresh = opts.refreshers?.[slot.account];
          if (refresh !== undefined) {
            try {
              await refresh(slot.account);
            } catch (err) {
              // The refresher's own error names no material; the code alone is logged.
              opts.log?.(`[model-plugins] refreshing ${slot.account} for ${pluginId} failed (${err instanceof Error ? err.name : typeof err})`);
            }
          }
          const t = await read(slot.account);
          return t !== null && t.generation > generation ? t : null;
        },
      };
    },
    async secret(pluginId, name) {
      const slot = slotOf(pluginId);
      if (slot === undefined) return opts.fallback?.secret(pluginId, name);
      const raw = await opts.secrets.get(slot.account);
      return raw === null || raw.length === 0 ? undefined : raw;
    },
    connectionFor(pluginId, connection) {
      const slot = slotOf(pluginId);
      const id = slot === undefined ? undefined : accountIds.get(slot.account);
      return id === undefined || connection.account !== undefined ? connection : { ...connection, account: id };
    },
    async prime() {
      for (const [provider, t] of Object.entries(CODE_PLUGINS)) {
        if (!t.auth.some((a) => a.method === "oauth-pkce")) continue;
        const { account } = modelPluginSlotFor(provider);
        const material = await readCredentialMaterial(opts.secrets, account).catch(() => null);
        if (material?.kind === "oauth" && material.accountId !== undefined) accountIds.set(account, material.accountId);
      }
    },
  };
}
