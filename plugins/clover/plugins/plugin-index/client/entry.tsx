// The plugin index browser on the runtime: the `main` entry keyed `plugins`. It reads the indexes the user added
// (`plugin.index.list`) and searches them (`plugin.index.search`) through the core, and installs from one
// (`plugin.install`, user-only: the `clover` layer's call is the user's, §5.5). An install starts with the plugin's
// OK, a sealed card the core raises; the page says the plugin waits on it. Opened from a placeholder, `params.spot`
// and `params.key` say what the user is looking for, and the first search is for the key.
import { useCallback, useEffect, useState } from "react";
import type { CoreClient, IndexEntryView, IndexView, PluginDetail, PluginSummary } from "../../shell/runtime/types";
import { plain } from "../../shell/runtime/views";
import { Detail, Installed } from "./Installed";
import { PluginIndex } from "./PluginIndex";
import { useCore } from "./sdk";
import { S } from "./strings";
import type { DetailStatus, IndexResult, InstalledPlugin, InstallState, PluginDetailView, PluginsTab } from "./types";

export interface PluginIndexEntryProps {
  route?: string;
  /** `spot` and `key`: opened from a placeholder (the Find tab, searching for it); `id`: that plugin opened; `tab`. */
  params?: { spot?: string; key?: string; id?: string; tab?: string };
  navigate?: (route: { route: string; params: Record<string, string> }) => void;
  /** The clock, for "checked 5 min ago"; the device's when absent. */
  now?: number;
}

const LIMIT = 50;

/** The newest version an entry lists (the index lists them oldest first). */
const newest = (e: IndexEntryView) => e.versions[e.versions.length - 1]?.version;

export function toResults(entries: IndexEntryView[], indexes: IndexView[]): IndexResult[] {
  return entries.map((e) => {
    const index = indexes.find((i) => i.url === e.index);
    const version = newest(e);
    return {
      id: e.id,
      index: e.index,
      indexName: index?.name ?? e.index,
      official: index?.official ?? false,
      name: plain(e.name) || e.id,
      ...(e.description ? { description: plain(e.description) } : {}),
      ...(version ? { version } : {}),
      ...(e.installed ? { installed: e.installed } : {}),
      ...(e.adult ? { adult: true } : {}),
    };
  });
}

async function search(core: CoreClient, query: string) {
  const [list, found] = await Promise.all([core.call("plugin.index.list", {}), core.call("plugin.index.search", { ...(query ? { query } : {}), limit: LIMIT })]);
  return { indexes: list.indexes, results: toResults(found.entries, list.indexes) };
}

/** Where a plugin came from, in words (the Settings page's). */
export const SOURCES: Record<PluginSummary["source"], string> = {
  bundled: "Bundled",
  index: "From the plugin index",
  npm: "From npm",
  local: "From a folder",
  wrapped: "Wrapped by Clover",
  dev: "A development folder",
};

/** What each capability lets a plugin do, in plain words, as its OK says (the Settings page's words). */
const OK_WORDS: Record<string, string> = {
  "conversation.read": "Reads your bots' conversations",
  "conversation.post": "Posts notes and messages to bots",
  "memory.read": "Reads your bots' memories",
  "bots.read": "Sees your bots",
  "routines.read": "Sees your routines",
  "computers.read": "Sees your computers",
  "computers.control": "Controls the screen and input of your computers",
  approvals: "Restyles approval cards",
  files: "Reads and writes files in your folders",
  terminal: "Runs commands on your computers",
  browser: "Drives the Clover Browser",
  "usage.read": "Reads your usage",
  "logs.read": "Reads Clover's logs",
  notify: "Sends you notifications",
  audio: "Can hear your microphone",
  "devices.read": "Sees your devices",
};

const PROVENANCE: Record<PluginDetail["provenance"]["by"], string> = {
  "user-app": "You added it in the app.",
  "user-terminal": "You added it in your terminal.",
  bot: "A bot added it with its tools.",
  migration: "It came over from the old app.",
  found: "It was found on disk.",
  bundled: "It ships with Clover.",
};

/** The installed list: top plugins, each with its children's names (a child isn't a row of its own). */
export function toInstalled(plugins: readonly PluginSummary[], lang = "en"): InstalledPlugin[] {
  const named = new Map(plugins.map((p) => [p.id, plain(p.name, lang) || p.id]));
  return plugins.filter((p) => p.parent === undefined).map((p) => ({
    id: p.id,
    name: named.get(p.id)!,
    version: p.version,
    source: SOURCES[p.source] ?? p.source,
    state: p.state,
    ...(p.reason ? { reason: p.reason } : {}),
    enabled: p.enabled,
    dev: p.dev,
    children: p.children.map((c) => named.get(c) ?? c),
  }));
}

/** One plugin opened, from `plugin.get`, its settings, its sign-ins and its log. */
export function toDetail(
  d: PluginDetail,
  more: { settings?: { key: string; type: string; title: unknown; value?: unknown; set?: boolean }[]; auth?: { index: number; method: string; state: string; account?: string }[]; log?: string[] },
  lang = "en",
): PluginDetailView {
  const [base] = toInstalled([{ ...d, parent: undefined } as PluginSummary], lang);
  const m = d.manifest as { description?: unknown; contributes?: { mcpServers?: Record<string, { tools?: Record<string, unknown> }> } };
  const servers = Object.entries(m.contributes?.mcpServers ?? {});
  const oks: string[] = [];
  for (const c of d.capabilities) {
    if (c.startsWith("network:")) continue;
    oks.push(c.startsWith("call:") ? `Runs ${c.slice(5)}'s commands` : OK_WORDS[c] ?? c);
  }
  for (const h of d.networkHosts) oks.push(`Reaches ${h}`);
  if (d.provenance.wrapped?.network === "any") oks.push("Its servers reach any host on the network");
  for (const r of d.provenance.wrapped?.reads ?? []) oks.push(`Reads ${r}`);
  const description = plain(m.description as never, lang);
  return {
    ...base!,
    ...(description ? { description } : {}),
    provenance: PROVENANCE[d.provenance.by] ?? "",
    oks,
    tools: servers.flatMap(([, s]) => Object.keys(s.tools ?? {})),
    servers: servers.filter(([, s]) => Object.keys(s.tools ?? {}).length === 0).map(([name]) => name),
    settings: (more.settings ?? []).map((s) => ({
      key: s.key,
      title: plain(s.title as never, lang) || s.key,
      secret: s.type === "secret",
      ...(s.type === "secret" ? { set: s.set === true } : { value: s.value === undefined || s.value === null ? "" : typeof s.value === "string" ? s.value : JSON.stringify(s.value) }),
    })),
    signIns: (more.auth ?? []).filter((a) => a.method !== "core").map((a) => ({
      index: a.index,
      method: a.method as "api-key" | "oauth-pkce" | "custom",
      signedIn: a.state === "signed-in" || a.state === "refreshing",
      state: a.state,
      ...(a.account ? { account: a.account } : {}),
    })),
    log: more.log ?? [],
    pinned: d.pinned,
    ...(d.state === "blocked" ? { revoked: true } : {}),
  };
}

/** A call's failure in the page's words. */
const why = (err: unknown) => (err instanceof Error ? err.message.replace(/^[a-z_]+: /, "") : String(err));

export function PluginIndexEntry({ props }: { props: PluginIndexEntryProps }) {
  const core = useCore();
  const [tab, setTab] = useState<PluginsTab>(props.params?.spot || props.params?.tab === "find" ? "find" : "installed");
  const [installed, setInstalled] = useState<InstalledPlugin[] | undefined>(undefined);
  const [mine, setMine] = useState("");
  const [open, setOpen] = useState<string | undefined>(props.params?.id);
  const [detail, setDetail] = useState<PluginDetailView | undefined>(undefined);
  const [status, setStatus] = useState<DetailStatus | undefined>(undefined);
  const [revision, setRevision] = useState(0);

  // What is installed: `plugin.list` alone, never a call per plugin.
  useEffect(() => {
    if (!core) return;
    let live = true;
    core.call("plugin.list", {}).then((r) => live && setInstalled(toInstalled(r.plugins)), () => live && setInstalled([]));
    return () => {
      live = false;
    };
  }, [core, revision]);

  // The one opened: its record, settings, sign-ins and log (each may be refused: what's there is shown).
  useEffect(() => {
    if (!core || open === undefined) return setDetail(undefined);
    let live = true;
    const quiet = <T,>(p: Promise<T>) => p.catch(() => undefined);
    void Promise.all([
      core.call("plugin.get", { id: open }),
      quiet(core.call("plugin.settings.get", { id: open })),
      quiet(core.call("plugin.auth.list", { id: open })),
      quiet(core.call("plugin.logs", { id: open, lines: 200 })),
    ]).then(
      ([d, settings, auth, logs]) => live && setDetail(toDetail(d.plugin, { ...(settings ? { settings: settings.settings } : {}), ...(auth ? { auth: auth.auth } : {}), ...(logs ? { log: logs.lines } : {}) })),
      () => live && setOpen(undefined),
    );
    return () => {
      live = false;
    };
  }, [core, open, revision]);

  // A change: done (the page reads again), or asked on a sealed card (the page says so; it reads again when answered).
  const act = useCallback((run: () => Promise<unknown>, asked?: string) => {
    setStatus(undefined);
    run().then(
      (r) => {
        const pending = typeof r === "object" && r !== null && (r as { applied?: unknown }).applied === false;
        if (pending && asked) setStatus({ tone: "info", text: asked });
        setRevision((n) => n + 1);
      },
      (err: unknown) => setStatus({ tone: "danger", text: S.failed(why(err)) }),
    );
  }, []);
  useEffect(() => {
    if (!core) return;
    // A card answered (a removal, a sign-out, an OK): read again.
    return core.on("card_resolved", () => setRevision((n) => n + 1));
  }, [core]);

  const looking = props.params?.spot ? { spot: props.params.spot, ...(props.params.key ? { key: props.params.key } : {}) } : undefined;
  const [query, setQuery] = useState(props.params?.key ?? "");
  const [asked, setAsked] = useState(props.params?.key ?? "");
  const [searching, setSearching] = useState(true);
  const [indexes, setIndexes] = useState<IndexView[]>([]);
  const [results, setResults] = useState<IndexResult[]>([]);
  const [installs, setInstalls] = useState<Record<string, InstallState>>({});

  useEffect(() => {
    // The indexes are searched when the Find tab is open, not before.
    if (!core || tab !== "find") return;
    let live = true;
    setSearching(true);
    search(core, asked).then(
      (r) => {
        if (!live) return;
        setIndexes(r.indexes);
        setResults(r.results);
        setSearching(false);
      },
      () => live && setSearching(false),
    );
    return () => {
      live = false;
    };
  }, [core, asked, tab]);

  const install = (r: IndexResult) => {
    if (!core) return;
    setInstalls((s) => ({ ...s, [r.id]: "asking" }));
    core.call("plugin.install", { source: { from: "index", id: r.id, index: r.index } }).then(
      (done) => setInstalls((s) => ({ ...s, [r.id]: done.state === "found" ? "waiting" : "installed" })),
      () => setInstalls((s) => ({ ...s, [r.id]: "failed" })),
    );
  };

  const find = (
    <PluginIndex
      bare
      query={query}
      onQuery={setQuery}
      onSearch={setAsked}
      results={results}
      searching={searching}
      indexes={indexes.map((i) => ({ url: i.url, ...(i.name ? { name: i.name } : {}), official: i.official, ...(i.lastCheckedAt ? { lastCheckedAt: i.lastCheckedAt } : {}) }))}
      {...(looking ? { looking } : {})}
      installs={installs}
      onInstall={install}
      onOpenInstalled={() => setTab("installed")}
      now={props.now ?? Date.now()}
    />
  );

  const id = open;
  return (
    <div className="cl-plugin-index">
      <div className="cl-plugin-index__page">
        {id !== undefined && detail !== undefined && core ? (
          <Detail
            plugin={detail}
            onBack={() => {
              setOpen(undefined);
              setStatus(undefined);
            }}
            onSwitch={(on) => act(() => core.call("plugin.setEnabled", { id, enabled: on }))}
            onRestart={() => act(() => core.call("plugin.restart", { id }))}
            onRemove={() => act(async () => {
              const r = await core.call("plugin.remove", { id });
              if ((r as { applied?: unknown }).applied !== false) setOpen(undefined);
              return r;
            }, S.removeAsked)}
            onKey={(target) => act(() => core.call("ui.secret", { id, ...target } as never))}
            onSignIn={(index) => act(() => core.call("plugin.auth.signIn", { id, index }))}
            onSignOut={(index) => act(() => core.call("plugin.auth.signOut", { id, index }), S.signOutAsked)}
            onRunAnyway={() => act(() => core.call("plugin.setEnabled", { id, enabled: true }), S.runAnywayAsked)}
            {...(status ? { status } : {})}
          />
        ) : (
          <>
            <header className="cl-plugin-index__head">
              <h1 className="cl-plugin-index__title">{S.title}</h1>
            </header>
            <p className="cl-plugin-index__intro">{S.intro}</p>
            <div className="cl-plugin-index__tabs" role="tablist" aria-label={S.tabsLabel}>
              {(["installed", "find"] as const).map((t) => (
                <button key={t} type="button" role="tab" className="cl-plugin-index__tab" aria-selected={tab === t} onClick={() => setTab(t)}>
                  {S.tabs[t]}
                </button>
              ))}
            </div>
            {tab === "installed" ? (
              <Installed plugins={installed ?? []} {...(installed === undefined ? { loading: true } : {})} query={mine} onQuery={setMine} onOpen={(p) => setOpen(p)} />
            ) : (
              find
            )}
          </>
        )}
      </div>
    </div>
  );
}
