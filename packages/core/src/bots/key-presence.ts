// Whether the user holds a key for a bot's model (lane D's `hasKeyFor`, spec §6.1: a bot's plugin model is used only
// where the user has a key for it; otherwise the bot falls back to the user's default model). Owner: lane D.
//
// * **Read before the bots start** (`botKeyPresence` resolves once the store was read), so the first listing and the
//   first turn after a boot already see a stored key (#313 review S1).
// * **Then read again when a bot asks, at most every few seconds,** so a key added or removed reaches the next turn
//   without a restart, and an idle daemon reads nothing; and **at once on a sign-in or sign-out** (`refresh`, the
//   daemon's credential-change hook), so the first turn after one already sees it.
// * **A model plugin's own provider** (A's model plugins, a provider outside the built-in credential slots) counts as
//   keyed when a model plugin serves it AND it is signed in through that plugin, or takes no sign-in (lane A's
//   `PluginAuth.signedInProviders`, #328's check): a third party's provider with no key falls back to the default
//   model instead of a turn the plugin refuses. That answer is async, so it is kept here: read before the bots start,
//   and again on `refresh()` (the daemon calls it at a plugin's sign-in or out and at each registry change) and with
//   the stored keys every few seconds. Without `pluginSignedIn`, a served provider counts as keyed (#313 review S2).
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
  /** The third parties' model plugin providers signed in through their plugin, or taking no sign-in (lane A's
   *  `PluginAuth.signedInProviders`). */
  pluginSignedIn?(): Promise<ReadonlySet<string>>;
  now?(): number;
}

/** `hasKeyFor`, with `refresh()`: reads the stored keys and the plugins' sign-ins again now (a sign-in, a sign-out, a
 *  plugin installed or removed). */
export type BotKeyPresence = ((model: string) => boolean) & { refresh(): Promise<void> };

export async function botKeyPresence(secrets: SecretStore, home: string, opts: BotKeyPresenceOptions = {}): Promise<BotKeyPresence> {
  const now = opts.now ?? (() => Date.now());
  const pluginServes = opts.pluginServes ?? ((provider: string) => installedModelPlugins()?.snapshot?.set.byProvider.has(provider) ?? false);
  const readKeys = () => credentialPresenceFrom(secrets);
  const readPlugins = (): Promise<ReadonlySet<string> | undefined> => (opts.pluginSignedIn === undefined ? Promise.resolve(undefined) : opts.pluginSignedIn());
  // A store that fails at boot (locked, broken) reads as no key, so the bots still start; the next read heals it.
  let presence: Awaited<ReturnType<typeof credentialPresenceFrom>> = await readKeys().catch(() => ({ byProvider: {} }));
  let signedIn: ReadonlySet<string> | undefined = await readPlugins().catch(() => new Set<string>());
  let readAt = now();
  let reading: Promise<void> | undefined;
  const read = (): Promise<void> => {
    reading ??= Promise.all([
      readKeys().then((p) => { presence = p; }, () => {}),
      readPlugins().then((s) => { signedIn = s; }, () => {}),
    ]).then(() => undefined).finally(() => { readAt = now(); reading = undefined; });
    return reading;
  };
  const hasKeyFor = (model: string): boolean => {
    if (testProviderNameFor(model) !== undefined) return true;
    if (now() - readAt > BOT_KEY_PRESENCE_MS) void read();
    const selection = providerFor(model, home);
    if (selection === undefined) return false;
    if (presence.byProvider[selection.providerId] !== undefined) return true;
    // Not one of the built-in slots: a model plugin's provider, keyed when its plugin is signed in (or takes none).
    if (credentialRefFor(selection.providerId, home) !== undefined || !pluginServes(selection.providerId)) return false;
    return signedIn === undefined || signedIn.has(selection.providerId);
  };
  return Object.assign(hasKeyFor, {
    // A refresh asked while a read runs waits for that one, then reads again, so it never misses the change it's for.
    refresh: async () => {
      if (reading !== undefined) await reading;
      await read();
    },
  });
}
