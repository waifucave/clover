// Every plugin index state the gallery shows.
import { useState } from "react";
import { toResults } from "../client/entry";
import { PluginIndex } from "../client/PluginIndex";
import type { InstallState } from "../client/types";
import { ENTRIES, INDEXES, NOW } from "./fixtures";
import type { Story } from "./story";

const noop = () => undefined;
const FORMAT = { locale: "en-US", timeZone: "UTC" };

export function PluginIndexDemo({ query = "", looking, installs, searching }: { query?: string; looking?: { spot: string; key?: string }; installs?: Record<string, InstallState>; searching?: boolean }) {
  const [q, setQ] = useState(query);
  const results = toResults(ENTRIES, INDEXES).filter((r) => !query || r.name.toLowerCase().includes(query.toLowerCase()) || r.description?.toLowerCase().includes(query.toLowerCase()));
  return (
    <PluginIndex
      query={q}
      onQuery={setQ}
      onSearch={noop}
      results={results}
      {...(searching ? { searching } : {})}
      indexes={INDEXES}
      {...(looking ? { looking } : {})}
      {...(installs ? { installs } : {})}
      onInstall={noop}
      onOpenInstalled={noop}
      now={NOW}
      format={FORMAT}
    />
  );
}

export const pluginIndexStories: Story[] = [
  { id: "plugin-index/all", title: "The plugin index", notes: "Everything the user's indexes hold: what's installed, what has a newer version, what isn't reviewed, and one that says it's for adults.", width: 900, height: 900, render: () => <PluginIndexDemo /> },
  { id: "plugin-index/installing", title: "Installing", notes: "Install asks for the plugin's OK on a sealed card; the row says it waits on it.", width: 900, height: 900, render: () => <PluginIndexDemo installs={{ "weather-routine": "waiting", "terminal-plus": "failed" }} /> },
  { id: "plugin-index/looking", title: "From a panel no plugin fills", notes: "Opened from the browser panel's placeholder: the page says what it's looking for and searches for it.", width: 900, height: 700, render: () => <PluginIndexDemo query="terminal" looking={{ spot: "panel", key: "terminal" }} /> },
  { id: "plugin-index/nothing", title: "Nothing matches", width: 900, height: 600, render: () => <PluginIndexDemo query="spreadsheet" /> },
];
