// The plugin index browser on the runtime: the `main` entry keyed `plugins`. It reads the indexes the user added
// (`plugin.index.list`) and searches them (`plugin.index.search`) through the core, and installs from one
// (`plugin.install`, user-only: the `clover` layer's call is the user's, §5.5). An install starts with the plugin's
// OK, a sealed card the core raises; the page says the plugin waits on it. Opened from a placeholder, `params.spot`
// and `params.key` say what the user is looking for, and the first search is for the key.
import { useEffect, useState } from "react";
import type { CoreClient, IndexEntryView, IndexView } from "../../shell/runtime/types";
import { plain } from "../../shell/runtime/views";
import { PluginIndex } from "./PluginIndex";
import { useCore } from "./sdk";
import type { IndexResult, InstallState } from "./types";

export interface PluginIndexEntryProps {
  route?: string;
  params?: { spot?: string; key?: string };
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

export function PluginIndexEntry({ props }: { props: PluginIndexEntryProps }) {
  const core = useCore();
  const looking = props.params?.spot ? { spot: props.params.spot, ...(props.params.key ? { key: props.params.key } : {}) } : undefined;
  const [query, setQuery] = useState(props.params?.key ?? "");
  const [asked, setAsked] = useState(props.params?.key ?? "");
  const [searching, setSearching] = useState(true);
  const [indexes, setIndexes] = useState<IndexView[]>([]);
  const [results, setResults] = useState<IndexResult[]>([]);
  const [installs, setInstalls] = useState<Record<string, InstallState>>({});

  useEffect(() => {
    if (!core) return;
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
  }, [core, asked]);

  const [gate, setGate] = useState<IndexResult | undefined>(undefined);

  // An install from the app lands as `found`, and its OK is a sealed card the core raises (the controller's ruling S1,
  // which lane B pins): this part never treats the click as the OK.
  const fetchIt = (r: IndexResult) => {
    if (!core) return;
    setInstalls((s) => ({ ...s, [r.id]: "asking" }));
    core.call("plugin.install", { source: { from: "index", id: r.id, index: r.index } }).then(
      // Only an install the core refused is a failure. Every other answer waits: the row says Installed only once the
      // index reports the plugin as installed (after its OK), never from the click's own answer (review N8).
      (done) => setInstalls((s) => ({ ...s, [r.id]: done.state === "refused" || done.state === "invalid" || done.state === "blocked" ? "failed" : "waiting" })),
      () => setInstalls((s) => ({ ...s, [r.id]: "failed" })),
    );
  };
  // An adult plugin passes the 18+ gate first (§5.7).
  const install = (r: IndexResult) => (r.adult ? setGate(r) : fetchIt(r));
  const confirmAge = () => {
    const r = gate;
    setGate(undefined);
    if (!core || !r) return;
    core.call("plugin.confirmAdult", {}).then(
      () => fetchIt(r),
      () => setInstalls((s) => ({ ...s, [r.id]: "failed" })),
    );
  };

  return (
    <PluginIndex
      query={query}
      onQuery={setQuery}
      onSearch={setAsked}
      results={results}
      searching={searching}
      indexes={indexes.map((i) => ({ url: i.url, ...(i.name ? { name: i.name } : {}), official: i.official, ...(i.lastCheckedAt ? { lastCheckedAt: i.lastCheckedAt } : {}) }))}
      {...(looking ? { looking } : {})}
      installs={installs}
      onInstall={install}
      {...(gate ? { gate: { name: gate.name, onConfirm: confirmAge, onCancel: () => setGate(undefined) } } : {})}
      {...(props.navigate ? { onOpenInstalled: () => props.navigate!({ route: "settings", params: { section: "plugins" } }) } : {})}
      now={props.now ?? Date.now()}
    />
  );
}
