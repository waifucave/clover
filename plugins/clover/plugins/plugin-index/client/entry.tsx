// The plugin index browser on the runtime: the `main` entry keyed `plugins`. It reads the indexes the user added
// (`plugin.index.list`) and searches them (`plugin.index.search`) through the core, and installs from one
// (`plugin.install`, user-only: the `clover` layer's call is the user's, §5.5). An install starts with the plugin's
// OK, a sealed card the core raises; the page says the plugin waits on it. Opened from a placeholder, `params.spot`
// and `params.key` say what the user is looking for, and the first search is for the key.
import { useCallback, useEffect, useState } from "react";
import type { CoreClient, IndexEntryView, IndexView, PluginDetail, PluginSummary } from "../../shell/runtime/types";
import { plain } from "../../shell/runtime/views";
import { Add } from "./Add";
import { Detail, Installed } from "./Installed";
import { Indexes, Updates } from "./Manage";
import { PluginIndex } from "./PluginIndex";
import { useCore, useKept } from "./sdk";
import { S } from "./strings";
import type { AddSource, DetailSetting, DetailStatus, IndexResult, IndexRow, InstalledPlugin, InstallState, PickKind, PluginDetailView, PluginsTab, SettingControl, UpdateRow } from "./types";

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

/** Clover's own tree, whose notices are the app's: never muted (a bundled bot such as `alpha` is, like any plugin). */
const CLOVER_TREE = "clover";

/** A picture's URL on the app's image-only route (`/_t/<id>/<path>`): a file of the plugin's own, never a remote one. */
export function iconUrl(id: string, path: string): string | undefined {
  if (path === "" || path.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(path) || path.split("/").some((p) => p === ".." || p === "")) return undefined;
  return `/_t/${encodeURIComponent(id)}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

/** The installed list: top plugins, each with its children's names (a child isn't a row of its own); `icons` from
 *  `plugin.ui` (each plugin's own picture, by id). */
export function toInstalled(plugins: readonly PluginSummary[], lang = "en", icons: Readonly<Record<string, string>> = {}): InstalledPlugin[] {
  const named = new Map(plugins.map((p) => [p.id, plain(p.name, lang) || p.id]));
  return plugins.filter((p) => p.parent === undefined).map((p) => {
    const url = icons[p.id] !== undefined ? iconUrl(p.id, icons[p.id]!) : undefined;
    const description = plain(p.description as never, lang);
    return {
    id: p.id,
    name: named.get(p.id)!,
    // A wrapper with no version of its own shows none (not "0.0.0").
    ...(p.source === "wrapped" && p.version === "0.0.0" ? {} : { version: p.version }),
    ...(description ? { description } : {}),
    // Clover's mark for the app's tree; the picture `plugin.ui` names for a plugin it shows; else, for one off, waiting
    // for its OK or with no UI, its manifest's icon on the app's picture-only route (`/_icon/<id>`: a raster image or
    // nothing, the puzzle then). The tree's hash rides along, so a new tree is a new URL: a load that failed (and the
    // puzzle it left) or a cached picture never outlives the tree it was for.
    ...(p.id === "clover" && p.source === "bundled" ? { icon: "clover" as const }
      : url !== undefined ? { icon: { url } }
      : typeof (p as { icon?: unknown }).icon === "string" ? { icon: { url: `/_icon/${encodeURIComponent(p.id)}${p.treeHash !== undefined ? `?v=${encodeURIComponent(p.treeHash)}` : ""}`, mayFail: true as const } } : {}),
    source: SOURCES[p.source] ?? p.source,
    state: p.state,
    ...(p.reason ? { reason: p.reason } : {}),
    enabled: p.enabled,
    dev: p.dev,
    children: p.children.map((c) => named.get(c) ?? c),
    };
  });
}

/** One of a plugin's settings as `plugin.settings.get` gives it. */
export interface SettingRow {
  key: string;
  type: string;
  title: unknown;
  description?: unknown;
  scope?: string;
  options?: (string | { value: string; title: unknown })[];
  min?: number;
  max?: number;
  value?: unknown;
  set?: boolean;
  asks?: boolean;
}

/** A setting as the detail shows it: a key only as saved or not; a plain one's value in words, and its control when
 *  the page can change it (not a bot's: one value per bot, set in that bot's settings). */
export function toDetailSetting(s: SettingRow, lang = "en"): DetailSetting {
  const title = plain(s.title as never, lang) || s.key;
  if (s.type === "secret") return { key: s.key, title, secret: true, set: s.set === true };
  const value = s.value === undefined || s.value === null ? "" : typeof s.value === "string" ? s.value : JSON.stringify(s.value);
  const control: SettingControl | undefined = s.scope === "bot" ? undefined
    : s.type === "string" ? { kind: "text", value: typeof s.value === "string" ? s.value : "" }
    : s.type === "color" ? { kind: "text", value: typeof s.value === "string" ? s.value : "", color: true }
    : s.type === "number" ? { kind: "number", value: typeof s.value === "number" ? s.value : undefined, ...(s.min !== undefined ? { min: s.min } : {}), ...(s.max !== undefined ? { max: s.max } : {}) }
    : s.type === "boolean" ? { kind: "switch", value: s.value === true }
    : s.type === "enum" ? {
      kind: "select", value: typeof s.value === "string" ? s.value : "",
      options: (s.options ?? []).map((o) => (typeof o === "string" ? { value: o, title: o } : { value: o.value, title: plain(o.title as never, lang) || o.value })),
    }
    : undefined;
  // An enum's value in words is its choice's title.
  const words = control?.kind === "select" ? control.options.find((o) => o.value === control.value)?.title ?? value : control?.kind === "switch" ? (control.value ? "On" : "Off") : value;
  return { key: s.key, title, secret: false, value: words, ...(control ? { control } : {}), ...(s.asks === true ? { asks: true } : {}) };
}

/** One plugin opened, from `plugin.get`, its settings, its sign-ins and its log. */
export function toDetail(
  d: PluginDetail,
  more: { settings?: SettingRow[]; auth?: { index: number; method: string; state: string; account?: string }[]; log?: string[]; muted?: boolean },
  lang = "en",
  icons: Readonly<Record<string, string>> = {},
): PluginDetailView {
  const [base] = toInstalled([{ ...d, parent: undefined } as PluginSummary], lang, icons);
  const m = d.manifest as { description?: unknown; contributes?: { mcpServers?: Record<string, { tools?: Record<string, unknown> }>; agents?: unknown[] } };
  // Its agent definitions (the manifest's `agents`: an entry with its name, or a file by its path), as its OK says.
  const agents = (m.contributes?.agents ?? []).flatMap((a) => {
    if (typeof a === "string") return [a.replace(/^.*\//, "").replace(/\.md$/, "").slice(0, 80)];
    const e = a as { id?: unknown; name?: unknown };
    const n = plain(e.name as never, lang) || (typeof e.id === "string" ? e.id : "");
    return n ? [n.slice(0, 80)] : [];
  });
  const servers = Object.entries(m.contributes?.mcpServers ?? {});
  const oks: string[] = [];
  for (const c of d.capabilities) {
    if (c.startsWith("network:")) continue;
    oks.push(c.startsWith("call:") ? `Runs ${c.slice(5)}'s commands` : OK_WORDS[c] ?? c);
  }
  for (const h of d.networkHosts) oks.push(`Reaches ${h}`);
  if (d.provenance.wrapped?.network === "any") oks.push("Its servers reach any host on the network");
  for (const r of d.provenance.wrapped?.reads ?? []) oks.push(`Reads ${r}`);
  const description = base!.description ?? (plain(m.description as never, lang) || undefined);
  return {
    ...base!,
    ...(description ? { description } : {}),
    provenance: PROVENANCE[d.provenance.by] ?? "",
    oks,
    tools: servers.flatMap(([, s]) => Object.keys(s.tools ?? {})),
    servers: servers.filter(([, s]) => Object.keys(s.tools ?? {}).length === 0).map(([name]) => name),
    settings: (more.settings ?? []).map((s) => toDetailSetting(s, lang)),
    signIns: (more.auth ?? []).filter((a) => a.method !== "core").map((a) => ({
      index: a.index,
      method: a.method as "api-key" | "oauth-pkce" | "custom",
      signedIn: a.state === "signed-in" || a.state === "refreshing",
      state: a.state,
      ...(a.account ? { account: a.account } : {}),
    })),
    log: more.log ?? [],
    pinned: d.pinned,
    updates: d.provenance.index !== undefined || d.provenance.npm !== undefined,
    agents,
    notifies: d.capabilities.includes("notify") && d.id.split("/")[0] !== CLOVER_TREE,
    muted: more.muted === true,
    ...(d.state === "blocked" ? { revoked: true } : {}),
  };
}

/** "12 min ago" (the Find tab's words). */
function whenAgo(at: number, now: number): string {
  const minutes = Math.round((now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}

/** Whether `notify.mutes` lists a plugin as muted (a refused read means not). */
function mutedIn(mutes: { muted: string[] } | undefined, id: string): boolean {
  return mutes?.muted.includes(id) ?? false;
}

/** A call's failure in the page's words. */
const why = (err: unknown) => (err instanceof Error ? err.message.replace(/^[a-z_]+: /, "") : String(err));

export function PluginIndexEntry({ props }: { props: PluginIndexEntryProps }) {
  const core = useCore();
  const TABS: PluginsTab[] = ["installed", "add", "updates", "find", "indexes"];
  // The tab and the open plugin are the user's place: kept across a reload of the window's document (installing,
  // turning on or updating a plugin with its own layer loads it again). Kept per route, so a link that names its own
  // tab or plugin starts there, and the same route after a reload is where the user left it.
  const place = JSON.stringify(props.params ?? {});
  const [tab, setTab] = useKept<PluginsTab>(`plugins.tab:${place}`, () => (props.params?.spot ? "find" : TABS.find((t) => t === props.params?.tab) ?? "installed"));
  const [updates, setUpdates] = useState<UpdateRow[]>([]);
  const [checking, setChecking] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<DetailStatus | undefined>(undefined);
  const [indexRows, setIndexRows] = useState<IndexRow[]>([]);
  const [indexStatus, setIndexStatus] = useState<DetailStatus | undefined>(undefined);
  const [picked, setPicked] = useState<{ kind: PickKind; token: string; name: string } | undefined>(undefined);
  const [adding, setAdding] = useState(false);
  const [addStatus, setAddStatus] = useState<DetailStatus | undefined>(undefined);
  const [installed, setInstalled] = useState<InstalledPlugin[] | undefined>(undefined);
  const [icons, setIcons] = useState<Record<string, string>>({});
  const [mine, setMine] = useState("");
  const [keptOpen, setOpen] = useKept<string | null>(`plugins.open:${place}`, () => props.params?.id ?? null);
  const open: string | undefined = keptOpen ?? undefined;
  const [detail, setDetail] = useState<PluginDetailView | undefined>(undefined);
  const [status, setStatus] = useState<DetailStatus | undefined>(undefined);
  const [revision, setRevision] = useState(0);

  // What is installed: `plugin.list` alone, never a call per plugin.
  useEffect(() => {
    if (!core) return;
    let live = true;
    void Promise.all([core.call("plugin.list", {}), core.call("plugin.ui", {}).catch(() => ({ plugins: [] }))]).then(
      ([r, ui]) => {
        if (!live) return;
        const next: Record<string, string> = {};
        for (const v of ui.plugins) if (typeof (v as { icon?: unknown }).icon === "string") next[v.pluginId] = (v as { icon: string }).icon;
        setIcons(next);
        setInstalled(toInstalled(r.plugins, "en", next));
      },
      () => live && setInstalled([]),
    );
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
      quiet(core.call("notify.mutes", {})),
    ]).then(
      ([d, settings, auth, logs, mutes]) => live && setDetail(toDetail(d.plugin, { ...(settings ? { settings: settings.settings } : {}), ...(auth ? { auth: auth.auth } : {}), ...(logs ? { log: logs.lines } : {}), muted: mutedIn(mutes, open) }, "en", icons)),
      () => live && setOpen(null),
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
      // Refused: why, and the page reads again, so a control shows what the core holds (a setting's edit goes back).
      (err: unknown) => {
        setStatus({ tone: "danger", text: S.failed(why(err)) });
        setRevision((n) => n + 1);
      },
    );
  }, []);
  useEffect(() => {
    if (!core) return;
    // A plugin appeared, changed or went (the registry's events, `plugins.watch`: ids and states only): read again.
    const again = () => setRevision((n) => n + 1);
    const offs = ["plugin_changed", "plugin_removed", "plugin_found"].map((e) => core.on(e, again));
    // A yes that couldn't do what its card asked: why, where that card's result shows (its tab's status line).
    offs.push(core.on("plugin_card_note", (e) => {
      const note = typeof e.note === "string" ? e.note : undefined;
      if (note === undefined) return;
      const shown: DetailStatus = { tone: "danger", text: note };
      const change = String(e.change ?? "");
      if (change === "plugin-update") setUpdateStatus(shown);
      else if (change === "plugin-index" || change === "plugin-index-remove") setIndexStatus(shown);
      else if (change === "dev-folder") {
        setAddStatus(shown);
        setStatus(shown);
      } else setStatus(shown);
      again();
    }));
    return () => {
      for (const off of offs) off();
    };
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

  // The Updates tab: what is newer (a read), each with why; Apply one at a time; Hold back (a pin).
  const check = useCallback(() => {
    if (!core) return;
    setChecking(true);
    void Promise.all([core.call("plugin.update", { list: true }), core.call("plugin.list", {})]).then(
      ([r, list]) => {
        setChecking(false);
        const name = new Map(list.plugins.map((p) => [p.id, plain(p.name) || p.id]));
        setUpdates((r.offered ?? []).map((u) => ({ id: u.id, name: name.get(u.id) ?? u.id, from: u.from, to: u.to, why: u.why, pinned: /pinned|held back/i.test(u.why) })));
      },
      (err: unknown) => {
        setChecking(false);
        setUpdateStatus({ tone: "danger", text: S.failed(why(err)) });
      },
    );
  }, [core]);
  useEffect(() => {
    if (tab === "updates") check();
  }, [tab, check, revision]);
  const apply = (id: string) => {
    if (!core) return;
    setUpdateStatus(undefined);
    const name = updates.find((u) => u.id === id)?.name ?? id;
    core.call("plugin.update", { id }).then(
      (r) => {
        const done = r.updated.find((u) => u.id === id);
        const offered = r.offered?.find((u) => u.id === id);
        const failed = r.failed?.find((u) => u.id === id);
        if (failed) setUpdateStatus({ tone: "danger", text: S.failed(failed.why) });
        else if (offered) setUpdateStatus({ tone: "info", text: /waiting for your yes/.test(offered.why) ? S.updateWaiting : offered.why });
        else if (done) setUpdateStatus({ tone: "info", text: S.updateApplied(name, done.to) });
        setRevision((n) => n + 1);
      },
      (err: unknown) => setUpdateStatus({ tone: "danger", text: S.failed(why(err)) }),
    );
  };
  const pin = (id: string, pinned: boolean) => {
    if (!core) return;
    core.call("plugin.pin", { id, pinned }).then(() => setRevision((n) => n + 1), (err: unknown) => setUpdateStatus({ tone: "danger", text: S.failed(why(err)) }));
  };

  // The Indexes tab: each index with its health; add by address and key (a warning card), remove (a card when plugins came from it).
  useEffect(() => {
    if (!core || tab !== "indexes") return;
    let live = true;
    core.call("plugin.index.list", {}).then((r) => live && setIndexRows(r.indexes.map((i) => ({
      url: i.url, official: i.official,
      ...(i.name ? { name: i.name } : {}), ...(i.lastCheckedAt ? { lastCheckedAt: i.lastCheckedAt } : {}), ...(i.stale ? { stale: true } : {}), ...(i.error ? { error: i.error } : {}),
      ...(i.revocations ? { revocations: { ...(i.revocations.lastCheckedAt ? { lastCheckedAt: i.revocations.lastCheckedAt } : {}), ...(i.revocations.stale ? { stale: true } : {}), ...(i.revocations.error ? { error: i.revocations.error } : {}) } } : {}),
    }))), () => undefined);
    return () => {
      live = false;
    };
  }, [core, tab, revision]);
  const now = props.now ?? Date.now();
  const health = (i: IndexRow) => {
    const parts = [i.error ? S.health.failed(i.error) : i.lastCheckedAt ? S.checked(whenAgo(i.lastCheckedAt, now)) : S.health.never];
    if (i.stale) parts.push(S.health.stale);
    parts.push(i.revocations ? (i.revocations.error ? S.health.failed(i.revocations.error) : S.health.revocations) : S.health.noRevocations);
    return parts.join(" · ");
  };
  const indexChange = (run: () => Promise<unknown>) => {
    setIndexStatus(undefined);
    run().then(
      (r) => {
        setIndexStatus({ tone: "info", text: typeof r === "object" && r !== null && (r as { applied?: unknown }).applied === false ? S.indexAsked : S.indexDone });
        setRevision((n) => n + 1);
      },
      (err: unknown) => setIndexStatus({ tone: "danger", text: S.failed(why(err)) }),
    );
  };

  // The Add tab: main's picker gives a token (never a path), which the install hands back once.
  const pick = (kind: PickKind, what: "folder" | "file") => {
    if (!core) return;
    setAddStatus(undefined);
    core.call("ui.pick", { kind: what, use: "plugin.install", ...(kind === "agent-file" ? { filters: [{ name: "Agent", extensions: ["md"] }] } : {}) }).then(
      (r) => {
        if ("cancelled" in r) {
          setPicked(undefined);
          setAddStatus({ tone: "info", text: S.pickCancelled });
        } else setPicked({ kind, token: r.token, name: r.name });
      },
      (err: unknown) => setAddStatus({ tone: "danger", text: S.failed(why(err)) }),
    );
  };
  const add = (source: AddSource) => {
    if (!core) return;
    setAdding(true);
    setAddStatus(undefined);
    const src = source.from === "picked"
      ? (source.kind === "folder" ? { from: "folder" as const, path: source.token } : { from: "wrap" as const, kind: source.kind, value: source.token })
      : source;
    core.call("plugin.install", { source: src }).then(
      (r) => {
        setAdding(false);
        setPicked(undefined);
        const waiting = [r, ...(r.more ?? [])].filter((x) => x.state === "found").length;
        setAddStatus({ tone: "info", text: waiting > 0 ? S.addAsked(waiting) : S.addInstalled });
        setRevision((n) => n + 1);
      },
      (err: unknown) => {
        setAdding(false);
        // A token is spent by its one use: a failed install asks for the folder again.
        if (source.from === "picked") setPicked(undefined);
        setAddStatus({ tone: "danger", text: S.failed(why(err)) });
      },
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
            // Its picture may come after its record (plugin.ui answers on its own).
            plugin={detail.icon === undefined && icons[detail.id] !== undefined && iconUrl(detail.id, icons[detail.id]!) !== undefined ? { ...detail, icon: { url: iconUrl(detail.id, icons[detail.id]!)! } } : detail}
            onBack={() => {
              setOpen(null);
              setStatus(undefined);
            }}
            onSwitch={(on) => act(() => core.call("plugin.setEnabled", { id, enabled: on }))}
            onRestart={() => act(() => core.call("plugin.restart", { id }))}
            onRemove={() => act(async () => {
              const r = await core.call("plugin.remove", { id });
              if ((r as { applied?: unknown }).applied !== false) setOpen(null);
              return r;
            }, S.removeAsked)}
            onKey={(target) => act(() => core.call("ui.secret", { id, ...target } as never))}
            onSignIn={(index) => act(() => core.call("plugin.auth.signIn", { id, index }))}
            onSignOut={(index) => act(() => core.call("plugin.auth.signOut", { id, index }), S.signOutAsked)}
            onRunAnyway={() => act(() => core.call("plugin.setEnabled", { id, enabled: true }), S.runAnywayAsked)}
            onPin={(pinned) => act(() => core.call("plugin.pin", { id, pinned }))}
            onMute={(muted) => act(() => core.call("notify.setMuted", { pluginId: id, muted }))}
            onSetting={(key, value, asks) => act(() => core.call("plugin.settings.set", { id, key, value }), asks ? S.settingAsked : undefined)}
            {...(status ? { status } : {})}
          />
        ) : (
          <>
            <header className="cl-plugin-index__head">
              <h1 className="cl-plugin-index__title">{S.title}</h1>
            </header>
            <p className="cl-plugin-index__intro">{S.intro}</p>
            <div className="cl-plugin-index__tabs" role="tablist" aria-label={S.tabsLabel}>
              {TABS.map((t) => (
                <button key={t} type="button" role="tab" className="cl-plugin-index__tab" aria-selected={tab === t} onClick={() => {
                  setTab(t);
                  // Each tab reads what it shows again when it is opened.
                  setRevision((n) => n + 1);
                }}>
                  {S.tabs[t]}
                </button>
              ))}
            </div>
            {tab === "installed" ? (
              <Installed plugins={installed ?? []} {...(installed === undefined ? { loading: true } : {})} query={mine} onQuery={setMine} onOpen={(p) => setOpen(p)} />
            ) : tab === "updates" ? (
              <Updates updates={updates} checking={checking} onCheck={check} onApply={apply} onPin={pin} {...(updateStatus ? { status: updateStatus } : {})} />
            ) : tab === "indexes" ? (
              <Indexes indexes={indexRows} health={health} onAdd={(url, key) => indexChange(() => core!.call("plugin.index.add", { url, keys: [key] }))} onRemove={(url) => indexChange(() => core!.call("plugin.index.remove", { url }))} {...(indexStatus ? { status: indexStatus } : {})} />
            ) : tab === "add" ? (
              <Add {...(picked ? { picked } : {})} onPick={pick} onInstall={add} onFind={() => setTab("find")} busy={adding} {...(addStatus ? { status: addStatus } : {})} />
            ) : (
              find
            )}
          </>
        )}
      </div>
    </div>
  );
}
