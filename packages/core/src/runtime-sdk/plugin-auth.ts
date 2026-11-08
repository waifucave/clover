// `plugin.auth.list`, `plugin.auth.signIn` and `plugin.auth.signOut` (protocol plugins area, owner A): a plugin's
// sign-ins for Settings and the welcome guide (§3.3, §5.1), and the `plugin_auth_changed` event. Owner: lane A.
//
// A plugin's sign-ins are its `auth` entries, numbered in one list: each `models` entry's, in order, then the
// manifest's own `auth` (the welcome guide numbers the models' the same way). Where each one's key or token lives:
//
// * a bundled model plugin (`clover/model-<provider>`): its provider's keychain slot (`modelPluginSlotFor`), the one
//   the model plugins read (`keychain-tokens.ts`) and the providers' older doors wrote, so a key stored before the
//   plugins existed shows as signed in;
// * any other plugin: its own item in the secret store, `{ owner: plugin, name: <the entry's secret> }`, the one
//   `secretStoreCredentials` serves its keyed fetch from.
//
// The methods:
//
// * `api-key`: the key is checked (`credentialValueRefusal`: trimmed, printable ASCII, a size cap) and stored. It is
//   never logged, echoed or put in an error.
// * `oauth-pkce`: the core runs the sign-in (`runLoginFlow`, a loopback redirect), answers with the URL to open, and
//   finishes on the redirect in the background; `plugin_auth_changed` says how it ended. A bundled plugin's tokens
//   land in its slot as an OAuth record (Codex's refresher renews them); another plugin's access token is its secret.
// * `custom`: the plugin's handler is asked which flow to run; today a handler can only name a core flow
//   (`{ flow: "core", id }`, `clover/model-xai-oauth`'s), which runs as `core` below.
// * `core`: the core's own flows. `xai-device` (xAI's device grant, `startXaiLogin`) answers with the verification URL
//   and lands its token in the slot; the Console flows are refused here (their own doors, `provider.login`).
//
// One sign-in per entry runs at a time (`busy`). Signing out deletes the entry's secret (for Codex, every name its
// older doors used).
import { PLUGINS_METHODS, type PluginAuthView } from "@waifucave/clover-protocol";
import { startXaiLogin, type CredentialStore } from "@waifucave/clover-provider-runtime";
import { clearCredentialMaterial, readCredentialMaterial, writeCredentialMaterial } from "../auth/credential-material";
import type { SecretStore as DaemonSecretStore } from "../auth/secret-store";
import { ContractError } from "../contracts/common";
import type { PluginHost } from "../contracts/plugin-host";
import type { PluginRecord, PluginRegistry } from "../contracts/plugin-registry";
import type { SecretStore as ContractSecretStore } from "../contracts/secret-store";
import { runLoginFlow, type OAuthTokens } from "../providers/pkce";
import { credentialStoreOverSecretStore } from "../providers/credential-store";
import { handler, requireUser, type MethodHandler } from "../rpc/handler";
import { credentialValueRefusal, removeCredential } from "./credentials";
import { bundledModelProviderOf, modelPluginSlotFor } from "./model-plugins/keychain-tokens";

/** One `auth` entry as a manifest has it (the plugin SDK's `AuthSchema`), and the provider of the `models` entry it
 *  belongs to. */
export type AuthEntry =
  | { method: "api-key"; secret: string }
  | { method: "oauth-pkce"; authorizeUrl: string; tokenUrl: string; clientId: string; scopes?: string[]; secret: string }
  | { method: "custom"; handler: string }
  | { method: "core"; flow: string };

interface NumberedEntry {
  index: number;
  entry: AuthEntry;
  /** The `models` entry's provider, for an entry of one. */
  provider?: string;
}

/** A plugin's sign-ins, numbered: each `models` entry's `auth`, then the manifest's own (32 at most). */
export function authEntriesOf(record: Pick<PluginRecord, "manifest">): NumberedEntry[] {
  const manifest = record.manifest as { contributes?: { models?: { provider?: string; auth?: AuthEntry[] }[] }; auth?: AuthEntry[] } | undefined;
  const out: NumberedEntry[] = [];
  for (const m of manifest?.contributes?.models ?? []) {
    for (const entry of m.auth ?? []) out.push({ index: out.length, entry, ...(m.provider !== undefined ? { provider: m.provider } : {}) });
  }
  for (const entry of manifest?.auth ?? []) out.push({ index: out.length, entry });
  return out.slice(0, 32);
}

/** What an OAuth sign-in needs to run: the authorize URL handed back once it is known, and the tokens at the end. */
export interface OAuthRun {
  /** Resolves with the URL to open; rejects when the flow can't start. */
  authorizeUrl: Promise<string>;
  tokens: Promise<OAuthTokens>;
}

export interface PluginAuthDeps {
  registry: Pick<PluginRegistry, "get">;
  /** The plugin host, for a `custom` entry's handler. */
  host?: Pick<PluginHost, "invoke">;
  /** The daemon's own secret store: the providers' keychain slots. */
  secrets: DaemonSecretStore;
  /** The contract store: other plugins' own secrets. */
  pluginSecrets: Pick<ContractSecretStore, "get" | "set" | "delete">;
  /** After a sign-in or out: the event, to the app and the CLI. */
  changed?(id: string, auth: PluginAuthView): void;
  /** After a provider slot's key changed (a bundled plugin's): what the daemon refreshes. */
  credentialChanged?(provider: string): Promise<void> | void;
  /** Test seams: the OAuth flow (production: `runLoginFlow` on Codex's loopback port), xAI's device grant, the clock. */
  oauth?(entry: Extract<AuthEntry, { method: "oauth-pkce" }>): OAuthRun;
  xaiDevice?(store: CredentialStore, onUrl: (url: string) => void): Promise<unknown>;
  now?(): number;
  log?(line: string): void;
}

/** The loopback port the OAuth redirect comes back to: Codex's registered one (codex-rs parity). */
export const OAUTH_CALLBACK_PORT = 1455;

function defaultOAuth(entry: Extract<AuthEntry, { method: "oauth-pkce" }>): OAuthRun {
  let resolveUrl!: (url: string) => void;
  let rejectUrl!: (err: Error) => void;
  const authorizeUrl = new Promise<string>((res, rej) => { resolveUrl = res; rejectUrl = rej; });
  const tokens = runLoginFlow({
    clientId: entry.clientId, authorizeUrl: entry.authorizeUrl, tokenUrl: entry.tokenUrl, callbackPort: OAUTH_CALLBACK_PORT,
    scope: (entry.scopes ?? []).join(" "),
    // The core opens nothing itself: the app opens the URL it is handed.
    openBrowser: async (url) => { resolveUrl(url); },
  });
  tokens.catch((err: unknown) => rejectUrl(err instanceof Error ? err : new Error(String(err))));
  return { authorizeUrl, tokens };
}

/** The URL a device-flow status line carries (xAI's verification link, with the code in it when it is complete). */
function urlIn(lines: readonly string[] | undefined): string | undefined {
  for (const line of lines ?? []) {
    const m = /https:\/\/\S+/.exec(line);
    if (m !== null) return m[0].replace(/[).,]+$/, "");
  }
  return undefined;
}

/** A credential store that lands every write in one slot (xAI's login names its record by account; the model plugin
 *  reads its provider's slot). */
function storeIntoSlot(secrets: DaemonSecretStore, account: string): CredentialStore {
  const inner = credentialStoreOverSecretStore(secrets);
  const slot = { kind: "keychain" as const, account };
  return {
    get: () => inner.get(slot),
    set: (_ref, material) => inner.set(slot, material),
    delete: () => inner.delete(slot),
  } as CredentialStore;
}

export interface PluginAuth {
  list(id: string): Promise<PluginAuthView[]>;
  signIn(id: string, index: number, key?: string): Promise<{ state: PluginAuthView["state"]; authorizeUrl?: string }>;
  signOut(id: string, index: number): Promise<void>;
}

export function createPluginAuth(deps: PluginAuthDeps): PluginAuth {
  const now = deps.now ?? Date.now;
  const running = new Map<string, "refreshing" | { failed: string }>();
  const record = (id: string): PluginRecord => {
    const r = deps.registry.get(id);
    if (r === undefined) throw new ContractError("not_found", `no plugin ${id}`);
    return r;
  };
  const numbered = (id: string, index: number): { r: PluginRecord; n: NumberedEntry; provider: string | undefined } => {
    const r = record(id);
    const n = authEntriesOf(r).find((e) => e.index === index);
    if (n === undefined) throw new ContractError("not_found", `${id} has no sign-in ${index}`);
    // Only a bundled model plugin's own `models` entries map to a provider's slot.
    const bundled = bundledModelProviderOf(r);
    return { r, n, provider: bundled !== undefined && n.provider === bundled ? bundled : undefined };
  };
  const secretName = (entry: AuthEntry): string | undefined =>
    entry.method === "api-key" || entry.method === "oauth-pkce" ? entry.secret : entry.method === "custom" ? entry.handler : undefined;

  const view = async (id: string, n: NumberedEntry, provider: string | undefined): Promise<PluginAuthView> => {
    const name = secretName(n.entry);
    const base = { index: n.index, method: n.entry.method, ...(name !== undefined ? { secret: name.slice(0, 64) } : {}) };
    const run = running.get(`${id}#${n.index}`);
    if (run === "refreshing") return { ...base, state: "refreshing" };
    if (provider !== undefined) {
      const material = await readCredentialMaterial(deps.secrets, modelPluginSlotFor(provider).account).catch(() => null);
      if (material !== null) {
        const expired = material.kind === "oauth" && material.refreshToken === undefined && material.expiresAt !== undefined && material.expiresAt <= now();
        return { ...base, state: expired ? "expired" : "signed-in" };
      }
    } else if (name !== undefined) {
      const v = await deps.pluginSecrets.get({ owner: { kind: "plugin", pluginId: id }, name }).catch(() => null);
      if (v !== null) return { ...base, state: "signed-in" };
    }
    if (run !== undefined) return { ...base, state: "failed", reason: run.failed.slice(0, 2000) };
    return { ...base, state: "signed-out" };
  };
  const announce = async (id: string, index: number): Promise<void> => {
    if (deps.changed === undefined) return;
    try {
      const { n, provider } = numbered(id, index);
      deps.changed(id, await view(id, n, provider));
    } catch { /* the plugin went away meanwhile */ }
  };
  const afterSlotChange = async (provider: string | undefined): Promise<void> => {
    if (provider === undefined) return;
    try { await deps.credentialChanged?.(provider); } catch (err) { deps.log?.(`[plugin-auth] refreshing after ${provider}'s sign-in failed (${err instanceof Error ? err.name : typeof err})`); }
  };
  /** Runs a background sign-in to its end: the entry shows `refreshing` meanwhile, `failed` with the reason after. */
  const background = (id: string, index: number, provider: string | undefined, done: Promise<void>): void => {
    const key = `${id}#${index}`;
    running.set(key, "refreshing");
    void announce(id, index);
    void done.then(
      async () => { running.delete(key); await afterSlotChange(provider); await announce(id, index); },
      async (err: unknown) => {
        // The class only: a flow's message could carry what the provider sent back.
        running.set(key, { failed: `the sign-in didn't finish (${err instanceof Error ? err.message.split(/[:\n]/)[0]!.slice(0, 200) : typeof err})` });
        deps.log?.(`[plugin-auth] ${id} sign-in ${index} failed (${err instanceof Error ? err.name : typeof err})`);
        await announce(id, index);
      },
    );
  };
  const runCoreFlow = async (id: string, index: number, flow: string, provider: string | undefined): Promise<{ state: PluginAuthView["state"]; authorizeUrl?: string }> => {
    if (flow !== "xai-device") throw new ContractError("refused", `the ${flow} sign-in runs from its own door (provider.login), not here`);
    if (provider === undefined) throw new ContractError("refused", "xAI's device sign-in is for its bundled model plugin only");
    const store = storeIntoSlot(deps.secrets, modelPluginSlotFor(provider).account);
    let resolveUrl!: (url: string) => void;
    const url = new Promise<string>((res) => { resolveUrl = res; });
    const run = deps.xaiDevice !== undefined
      ? deps.xaiDevice(store, resolveUrl)
      : startXaiLogin(store, { onAuthStatus: (s) => { const u = urlIn(s.output); if (u !== undefined) resolveUrl(u); } });
    background(id, index, provider, run.then(() => undefined));
    const first = await Promise.race([url, run.then(() => undefined, () => undefined)]);
    return { state: "refreshing", ...(typeof first === "string" ? { authorizeUrl: first } : {}) };
  };

  return {
    async list(id) {
      const r = record(id);
      const bundled = bundledModelProviderOf(r);
      return Promise.all(authEntriesOf(r).map((n) => view(id, n, bundled !== undefined && n.provider === bundled ? bundled : undefined)));
    },

    async signIn(id, index, key) {
      const { n, provider } = numbered(id, index);
      const entry = n.entry;
      const runKey = `${id}#${index}`;
      if (running.get(runKey) === "refreshing") throw new ContractError("busy", "this sign-in is already running");
      if (entry.method === "api-key") {
        if (key === undefined) throw new ContractError("invalid", "an API key sign-in needs the key");
        const refusal = credentialValueRefusal(key);
        if (refusal !== undefined) throw new ContractError("invalid", refusal.message);
        const value = key.trim();
        if (provider !== undefined) await writeCredentialMaterial(deps.secrets, modelPluginSlotFor(provider).account, { kind: "api-key", key: value });
        else await deps.pluginSecrets.set({ owner: { kind: "plugin", pluginId: id }, name: entry.secret }, value);
        running.delete(runKey);
        await afterSlotChange(provider);
        await announce(id, index);
        return { state: "signed-in" };
      }
      if (key !== undefined) throw new ContractError("invalid", `a ${entry.method} sign-in takes no key`);
      if (entry.method === "oauth-pkce") {
        const flow = (deps.oauth ?? defaultOAuth)(entry);
        const stored = flow.tokens.then(async (t) => {
          if (provider !== undefined) {
            await writeCredentialMaterial(deps.secrets, modelPluginSlotFor(provider).account, {
              kind: "oauth", accessToken: t.accessToken,
              ...(t.refreshToken !== null ? { refreshToken: t.refreshToken } : {}),
              expiresAt: t.expiresAt,
              ...(t.accountId !== null ? { accountId: t.accountId } : {}),
              ...(t.idToken !== null ? { idToken: t.idToken } : {}),
            });
          } else {
            await deps.pluginSecrets.set({ owner: { kind: "plugin", pluginId: id }, name: entry.secret }, t.accessToken);
          }
        });
        background(id, index, provider, stored);
        const authorizeUrl = await flow.authorizeUrl.catch((err: unknown) => {
          throw new ContractError("refused", `the sign-in couldn't start (${err instanceof Error ? err.message.slice(0, 200) : typeof err})`);
        });
        return { state: "refreshing", authorizeUrl };
      }
      if (entry.method === "custom") {
        if (deps.host === undefined) throw new ContractError("refused", "the plugin host isn't running");
        const asked = await deps.host.invoke<unknown>({ pluginId: id, handler: entry.handler, args: {}, caller: { kind: "core" } as never });
        const named = asked as { flow?: unknown; id?: unknown } | null;
        if (named === null || typeof named !== "object" || named.flow !== "core" || typeof named.id !== "string") {
          throw new ContractError("refused", `${id}'s ${entry.handler} handler names no sign-in flow the core runs`);
        }
        return runCoreFlow(id, index, named.id, provider);
      }
      return runCoreFlow(id, index, entry.flow, provider);
    },

    async signOut(id, index) {
      const { n, provider } = numbered(id, index);
      running.delete(`${id}#${index}`);
      if (provider !== undefined) {
        if (provider === "codex-oauth") {
          const out = await removeCredential(deps.secrets, provider);
          if ("code" in out) throw new ContractError("refused", out.message);
        } else {
          await clearCredentialMaterial(deps.secrets, modelPluginSlotFor(provider).account);
        }
        await afterSlotChange(provider);
      } else {
        const name = secretName(n.entry);
        if (name !== undefined) await deps.pluginSecrets.delete({ owner: { kind: "plugin", pluginId: id }, name });
      }
      await announce(id, index);
    },
  };
}

/** The handlers lane C's server mounts. Signing in and out is the user's alone. */
export function pluginAuthMethods(auth: PluginAuth): Record<string, MethodHandler> {
  const M = PLUGINS_METHODS;
  return {
    [M.pluginAuthList.name]: handler(M.pluginAuthList, async (p) => ({ auth: await auth.list(p.id) })),
    [M.pluginAuthSignIn.name]: handler(M.pluginAuthSignIn, async (p, ctx) => {
      requireUser(ctx, "sign in");
      return auth.signIn(p.id, p.index, p.key);
    }),
    [M.pluginAuthSignOut.name]: handler(M.pluginAuthSignOut, async (p, ctx) => {
      requireUser(ctx, "sign out");
      await auth.signOut(p.id, p.index);
      return { ok: true as const };
    }),
  };
}
