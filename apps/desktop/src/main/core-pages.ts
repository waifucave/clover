// The core's own pages in a window's root (spec §5.8: "the welcome setup guide" and safe mode's "core plugin manager"
// are core, not plugins): what they show, read from the daemon, and the few calls they make. The root draws them
// (src/core/pages.ts) with no plugin code anywhere near; it reaches the daemon only through these calls, which the main
// process checks by name and shape. Pure apart from the client it is handed, so the tests drive it under Bun.
//
// The welcome guide (§3.3) lists the model providers (`models` entries), shows each one's terms before its sign-in
// (§5.7), and signs in with an API key or the provider's own browser sign-in (`plugin.auth.signIn`). A key goes to the
// daemon's credential store and nowhere else: never into a log line or an error message here.
// The plugin manager lists every plugin but the app's own and turns one off or removes it; turning plugins on waits
// for a normal start, where its OK is a sealed card.
import type { PluginAuthView, PluginSummary, PointView } from "@waifucave/clover-protocol";
import { SAFE_MODE_PLUGINS } from "./ui/model";
import type { KeyTarget } from "./ui/tree-calls";
import { textIn } from "./ui/strings";

export interface PageClient {
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
}

export type CorePage = "welcome" | "plugins" | "key";

export interface ProviderView {
  id: string;
  name: string;
  /** The provider's terms, shown before sign-in: a link, or a short text. */
  terms?: { url: string } | { text: string };
  auth: { index: number; method: PluginAuthView["method"]; state: PluginAuthView["state"]; account?: string; help?: string }[];
}

interface ModelEntry {
  name?: unknown;
  terms?: unknown;
  auth?: { method?: unknown; help?: unknown }[];
}

/** The model providers, with their terms and sign-ins, in a language. */
export async function listProviders(client: PageClient, lang: string): Promise<ProviderView[]> {
  const { points } = await client.request<{ points: PointView[] }>("point.list");
  const models = points.find((p) => p.name === "models");
  const ids = [...new Set((models?.occupants ?? []).map((o) => o.pluginId))];
  const out: ProviderView[] = [];
  for (const id of ids) {
    const [detail, auth] = await Promise.all([
      client.request<{ plugin: { name: unknown; manifest: Record<string, unknown> } }>("plugin.get", { id }),
      client.request<{ auth: PluginAuthView[] }>("plugin.auth.list", { id }).catch(() => ({ auth: [] as PluginAuthView[] })),
    ]);
    const entries = ((detail.plugin.manifest.contributes as { models?: ModelEntry[] } | undefined)?.models ?? []) as ModelEntry[];
    const first = entries[0];
    const helps = entries.flatMap((e) => e.auth ?? []).map((a) => (typeof a.help === "string" ? a.help : undefined));
    const terms = typeof first?.terms === "string" ? (/^https:\/\//.test(first.terms) ? { url: first.terms } : { text: first.terms }) : undefined;
    out.push({
      id,
      name: textIn(first?.name ?? detail.plugin.name, lang) || id,
      ...(terms !== undefined ? { terms } : {}),
      auth: auth.auth.map((a) => ({ index: a.index, method: a.method, state: a.state, ...(a.account !== undefined ? { account: a.account } : {}), ...(helps[a.index] !== undefined ? { help: helps[a.index]! } : {}) })),
    });
  }
  return out;
}

/** Whether a provider is signed in already (then the guide doesn't open by itself). */
export function anyReady(providers: readonly ProviderView[]): boolean {
  return providers.some((p) => p.auth.some((a) => a.state === "signed-in" || a.state === "refreshing"));
}

export interface ManagedPlugin {
  id: string;
  name: string;
  state: string;
  enabled: boolean;
  source: string;
  reason?: string;
  dev: boolean;
  /** A child plugin: it is removed with its parent. */
  child: boolean;
}

/** Every plugin but the app's own (`clover`, `alpha`, which safe mode runs), for the plugin manager. */
export async function listManaged(client: PageClient, lang: string): Promise<ManagedPlugin[]> {
  const { plugins } = await client.request<{ plugins: PluginSummary[] }>("plugin.list");
  return plugins
    .filter((p) => !SAFE_MODE_PLUGINS.includes(p.id.split("/")[0]!))
    .map((p) => ({
      id: p.id,
      name: textIn(p.name, lang) || p.id,
      state: p.state,
      enabled: p.enabled,
      source: p.source,
      ...(p.reason !== undefined ? { reason: p.reason } : {}),
      dev: p.dev,
      child: p.parent !== undefined,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export interface PageDeps {
  client(): PageClient | undefined;
  lang(): string;
  /** Opens a page in the user's own browser (a provider's sign-in or terms). */
  openExternal(url: string): Promise<void>;
  /** The guide is done (or skipped): it doesn't open by itself again. */
  welcomeDone(): void;
  /** The page the root should show now, and closing it. */
  page(): CorePage | null;
  closePage(): void;
  /** The key the app's own key dialog is for (`ui.secret` from the Plugins page): a plugin and one of its secret
   *  settings, named by main, never by the dialog. */
  keyTarget?(): { target: KeyTarget; session: string } | undefined;
  /** Whether the daemon has answered with its registry open (its plugin list is not the empty one it gives while opening). */
  registryReady(): boolean;
  /** Set when the app has had no daemon for a long time (the pair's `stuck`): the root says Clover can't start. */
  daemonDown?(): boolean;
}

/** The calls the root's pages make, by name. Anything else is refused. */
export const PAGE_CALLS = ["page.current", "registry.state", "page.close", "welcome.providers", "welcome.signIn", "welcome.openTerms", "welcome.done", "plugins.list", "plugins.turnOff", "plugins.remove", "key.view", "key.save", "key.remove"] as const;
export type PageCall = (typeof PAGE_CALLS)[number];

const ID_RE = /^[a-z][a-z0-9-]*(\/[a-z][a-z0-9-]*)?$/;

/** A daemon error as the root sees it: its message, with anything the user typed taken out. */
function scrub(err: unknown, secret?: string): Error {
  let message = err instanceof Error ? err.message : String(err);
  if (secret !== undefined && secret !== "") message = message.split(secret).join("…");
  return new Error(message.slice(0, 500));
}

/** One call from a root page, checked by name and shape. */
export async function pageCall(name: string, params: unknown, deps: PageDeps): Promise<unknown> {
  if (!(PAGE_CALLS as readonly string[]).includes(name)) throw new Error("not a call the core's pages make");
  const p = (params !== null && typeof params === "object" ? params : {}) as Record<string, unknown>;
  if (name === "page.current") return { page: deps.page() };
  if (name === "registry.state") return { ready: deps.registryReady(), ...(deps.daemonDown?.() === true ? { down: true } : {}) };
  if (name === "page.close") {
    deps.closePage();
    return { ok: true };
  }
  if (name === "welcome.done") {
    deps.welcomeDone();
    deps.closePage();
    return { ok: true };
  }
  const client = deps.client();
  if (client === undefined) throw new Error("Clover isn't running");
  const id = typeof p.id === "string" && ID_RE.test(p.id) ? p.id : undefined;
  switch (name as PageCall) {
    case "welcome.providers":
      return { providers: await listProviders(client, deps.lang()) };
    case "welcome.openTerms": {
      if (id === undefined) throw new Error("which provider?");
      const provider = (await listProviders(client, deps.lang())).find((x) => x.id === id);
      if (provider?.terms === undefined || !("url" in provider.terms)) throw new Error("no terms to open");
      await deps.openExternal(provider.terms.url);
      return { ok: true };
    }
    case "welcome.signIn": {
      const index = typeof p.index === "number" && Number.isInteger(p.index) && p.index >= 0 && p.index < 32 ? p.index : undefined;
      const key = typeof p.key === "string" && p.key.trim() !== "" ? p.key.trim() : undefined;
      if (id === undefined || index === undefined) throw new Error("which sign-in?");
      if (key !== undefined && key.length > 8192) throw new Error("that key is too long");
      let r: { state: string; authorizeUrl?: string };
      try {
        r = await client.request<{ state: string; authorizeUrl?: string }>("plugin.auth.signIn", { id, index, ...(key !== undefined ? { key } : {}) }, 30_000);
      } catch (err) {
        throw scrub(err, key);
      }
      // The provider's own sign-in page, in the user's browser; the core finishes on its redirect.
      let opened = false;
      if (typeof r.authorizeUrl === "string" && /^https:\/\//.test(r.authorizeUrl)) {
        await deps.openExternal(r.authorizeUrl);
        opened = true;
      }
      return { state: r.state, opened };
    }
    case "plugins.list":
      return { plugins: await listManaged(client, deps.lang()) };
    case "plugins.turnOff":
      if (id === undefined || SAFE_MODE_PLUGINS.includes(id.split("/")[0]!)) throw new Error("not a plugin the manager turns off");
      return client.request("plugin.setEnabled", { id, enabled: false });
    case "key.view":
    case "key.save":
    case "key.remove": {
      // The plugin and the key are main's (keyTarget), never the page's; the field must be a secret by the manifest.
      const open = deps.page() === "key" ? deps.keyTarget?.() : undefined;
      if (open === undefined) throw new Error("no key is being entered");
      const { target, session } = open;
      // The dialog that saves or removes is the one main opened for this key (a stale dialog's session is refused).
      if (name !== "key.view" && p.session !== session) throw new Error("this key dialog is out of date: close it and open it again");
      const view = { session, ...(await keyView(client, target, deps.lang())) };
      if (name === "key.view") return view;
      if (name === "key.remove") {
        if (!view.set) return view;
        // The user's own dialog, not a part: no further card for taking their own key out.
        if ("key" in target) await client.request("plugin.settings.set", { id: target.id, key: target.key, value: null });
        else await client.request("plugin.auth.signOut", { id: target.id, index: target.index });
        return { session, ...(await keyView(client, target, deps.lang())) };
      }
      const value = typeof p.value === "string" ? p.value.trim() : "";
      if (value === "") throw new Error("type or paste the key first");
      if (value.length > 8192) throw new Error("that key is too long");
      try {
        if ("key" in target) await client.request("plugin.settings.set", { id: target.id, key: target.key, value });
        else await client.request("plugin.auth.signIn", { id: target.id, index: target.index, key: value }, 30_000);
      } catch (err) {
        throw scrub(err, value);
      }
      return { session, ...(await keyView(client, target, deps.lang())) };
    }
    case "plugins.remove":
      if (id === undefined || id.includes("/") || SAFE_MODE_PLUGINS.includes(id)) throw new Error("not a plugin the manager removes");
      return client.request("plugin.remove", { id });
    default:
      throw new Error("not a call the core's pages make");
  }
}

/** What the key dialog shows: the plugin's name and the field's label (or the sign-in's) from the registry, and whether
 *  a key is stored. */
export async function keyView(client: PageClient, target: KeyTarget, lang: string): Promise<{ plugin: string; label: string; set: boolean }> {
  const { plugin } = await client.request<{ plugin: { name: unknown; manifest: Record<string, unknown> } }>("plugin.get", { id: target.id });
  const name = textIn(plugin.name, lang) || target.id;
  if ("index" in target) {
    const { auth } = await client.request<{ auth: PluginAuthView[] }>("plugin.auth.list", { id: target.id });
    const entry = auth.find((a) => a.index === target.index);
    if (entry?.method !== "api-key") throw new Error("that sign-in doesn't take a key");
    // The dialog names an empty label in its own words ("API key").
    return { plugin: name, label: "", set: entry.state === "signed-in" || entry.state === "refreshing" };
  }
  const field = ((plugin.manifest.settings ?? {}) as Record<string, { type?: unknown; title?: unknown }>)[target.key];
  if (field?.type !== "secret") throw new Error("that isn't one of the plugin's keys");
  const { settings } = await client.request<{ settings: { key: string; set?: boolean }[] }>("plugin.settings.get", { id: target.id });
  return { plugin: name, label: textIn(field.title, lang) || target.key, set: settings.find((x) => x.key === target.key)?.set === true };
}
