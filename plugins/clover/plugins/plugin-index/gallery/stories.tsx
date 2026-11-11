// Every plugin index state the gallery shows.
import { useState } from "react";
import { toDetail, toInstalled, toResults } from "../client/entry";
import { Detail, Installed } from "../client/Installed";
import { PluginIndex } from "../client/PluginIndex";
import type { InstallState } from "../client/types";
import { ENTRIES, INDEXES, INSTALLED, INSTALLED_LOG, INSTALLED_SETTINGS, installedDetail, NOW } from "./fixtures";
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

/** The Plugins page's frame around a tab's content (the entry draws it in the app). */
function Page({ children }: { children: React.ReactNode }) {
  return (
    <div className="cl-plugin-index">
      <div className="cl-plugin-index__page">{children}</div>
    </div>
  );
}

export function InstalledDemo({ query = "" }: { query?: string }) {
  const [q, setQ] = useState(query);
  return (
    <Page>
      <header className="cl-plugin-index__head">
        <h1 className="cl-plugin-index__title">Plugins</h1>
      </header>
      <div className="cl-plugin-index__tabs" role="tablist" aria-label="Plugins">
        <button type="button" role="tab" className="cl-plugin-index__tab" aria-selected>Installed</button>
        <button type="button" role="tab" className="cl-plugin-index__tab" aria-selected={false}>Find plugins</button>
      </div>
      <Installed plugins={toInstalled(INSTALLED)} query={q} onQuery={setQ} onOpen={noop} />
    </Page>
  );
}

export function DetailDemo({ id, status }: { id: string; status?: { tone: "info" | "danger"; text: string } }) {
  const plugin = toDetail(installedDetail(id), { settings: INSTALLED_SETTINGS[id] ?? [], auth: [], log: id === "tarot-panel" ? INSTALLED_LOG : [] });
  return (
    <Page>
      <Detail plugin={plugin} onBack={noop} onSwitch={noop} onRestart={noop} onRemove={noop} onKey={noop} onSignIn={noop} onSignOut={noop} onRunAnyway={noop} {...(status ? { status } : {})} />
    </Page>
  );
}

export const pluginIndexStories: Story[] = [
  { id: "plugin-index/installed", title: "Installed plugins", notes: "What is installed, by what needs you, what is on and what is off; a plugin's parts are under it, not rows of their own.", width: 900, height: 900, render: () => <InstalledDemo /> },
  { id: "plugin-index/installed-search", title: "Installed plugins, searched", width: 900, height: 500, render: () => <InstalledDemo query="tar" /> },
  { id: "plugin-index/detail", title: "One plugin opened", notes: "Where it came from, what its OK lets it do, the tools it gives, its settings (a key only as saved, entered in the app's own key dialog) and its log.", width: 900, height: 1100, render: () => <DetailDemo id="tarot-panel" /> },
  { id: "plugin-index/detail-removing", title: "Removing one", notes: "Remove asks on a sealed card; the page says so.", width: 900, height: 700, render: () => <DetailDemo id="tarot-panel" status={{ tone: "info", text: "Answer the card to remove it." }} /> },
  { id: "plugin-index/detail-revoked", title: "A revoked plugin", notes: "Blocked, with the index's reason; running it anyway is a warning card.", width: 900, height: 700, render: () => <DetailDemo id="story-mode" /> },
  { id: "plugin-index/detail-wrapped", title: "A wrapped MCP config", width: 900, height: 700, render: () => <DetailDemo id="mcp-linear" /> },
  { id: "plugin-index/all", title: "The plugin index", notes: "Everything the user's indexes hold: what's installed, what has a newer version, what isn't reviewed, and one that says it's for adults.", width: 900, height: 900, render: () => <PluginIndexDemo /> },
  { id: "plugin-index/installing", title: "Installing", notes: "Install asks for the plugin's OK on a sealed card; the row says it waits on it.", width: 900, height: 900, render: () => <PluginIndexDemo installs={{ "weather-routine": "waiting", "terminal-plus": "failed" }} /> },
  { id: "plugin-index/looking", title: "From a panel no plugin fills", notes: "Opened from the browser panel's placeholder: the page says what it's looking for and searches for it.", width: 900, height: 700, render: () => <PluginIndexDemo query="terminal" looking={{ spot: "panel", key: "terminal" }} /> },
  { id: "plugin-index/nothing", title: "Nothing matches", width: 900, height: 600, render: () => <PluginIndexDemo query="spreadsheet" /> },
];
