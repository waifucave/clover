// Whether the user holds a key for a bot's model (lane D's `hasKeyFor`, spec §6.1: a bot's plugin model is used only
// where the user has a key for it; otherwise the bot falls back to the user's default model). Owner: lane D.
//
// * **Read before the bots start** (`botKeyPresence` resolves once the store was read), so the first listing and the
//   first turn after a boot already see a stored key (#313 review S1).
// * **Then read again when a bot asks, at most every few seconds,** so a key added or removed reaches the next turn
//   without a restart, and an idle daemon reads nothing; and **at once on a sign-in or sign-out** (`refresh`, the
//   daemon's credential-change hook), so the first turn after one already sees it.
// * **A model plugin's own provider** (A's model plugins, a provider outside the built-in credential slots) counts as
//   keyed when a model plugin serves it: the plugin reaches its provider with its own key, and refuses, typed, when
//   it has none (#313 review S2).
// * The runtime's test models need no key.
import type { SecretStore } from "../auth/secret-store";
import { credentialPresenceFrom, credentialRefFor } from "../runtime-sdk/keychain";
import { installedModelPlugins } from "../runtime-sdk/model-plugins";
import { providerFor, testProviderNameFor } from "../runtime-sdk/provider-selection";

/** How old the bots' view of the stored keys may be before a bot's next look reads it again. */
export const BOT_KEY_PRESENCE_MS = 5_000;

export interface BotKeyPresenceOptions {
  /** Whether a model plugin serves the provider (the installed model plugins by default). */
  pluginServes?(provider: string): boolean;
  now?(): number;
}

/** `hasKeyFor`, and `refresh`: read the stored keys again now (a sign-in or sign-out, so the next turn sees it). */
export type BotKeyPresence = ((model: string) => boolean) & { refresh(): Promise<void> };

export async function botKeyPresence(secrets: SecretStore, home: string, opts: BotKeyPresenceOptions = {}): Promise<BotKeyPresence> {
  const now = opts.now ?? (() => Date.now());
  const pluginServes = opts.pluginServes ?? ((provider: string) => installedModelPlugins()?.snapshot?.set.byProvider.has(provider) ?? false);
  // A store that fails at boot (locked, broken) reads as no key, so the bots still start; the next read heals it.
  let presence: Awaited<ReturnType<typeof credentialPresenceFrom>> = await credentialPresenceFrom(secrets).catch(() => ({ byProvider: {} }));
  let readAt = now();
  let reading = false;
  const read = () => {
    if (reading) return;
    reading = true;
    void credentialPresenceFrom(secrets).then((p) => { presence = p; }, () => {}).finally(() => { readAt = now(); reading = false; });
  };
  const hasKeyFor = (model: string): boolean => {
    if (testProviderNameFor(model) !== undefined) return true;
    if (now() - readAt > BOT_KEY_PRESENCE_MS) read();
    const selection = providerFor(model, home);
    if (selection === undefined) return false;
    if (presence.byProvider[selection.providerId] !== undefined) return true;
    // Not one of the built-in slots: a model plugin's provider, which keeps its own key.
    return credentialRefFor(selection.providerId, home) === undefined && pluginServes(selection.providerId);
  };
  // A sign-in or sign-out reads the store again at once: the bot's next turn runs on what the user just did, never on
  // a view up to `BOT_KEY_PRESENCE_MS` old. A failed read keeps the last view.
  const refresh = async (): Promise<void> => {
    try { presence = await credentialPresenceFrom(secrets); readAt = now(); } catch { /* the last view stands */ }
  };
  return Object.assign(hasKeyFor, { refresh });
}
