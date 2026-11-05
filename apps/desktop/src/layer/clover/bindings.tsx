// The `clover` layer's M1 bindings: lane F's M1 parts are plain React against mocked props (plan §4 F, M1), so until
// F-M2 puts them on the runtime, these adapters take each entry's `EntryProps` and draw F's part with `<Spot>` where
// it takes another part. They are the starting point F-M2 moves into its plugins; then this file goes.
//
// What the core doesn't hand layers yet (the plugin API's bots, conversations, sessions, settings: lanes B, D, F)
// draws empty: the default shell renders whole, with Alpha's tab, an empty conversation and a live composer.
import { useCallback, useMemo, useState } from "react";
import { Spot, SpotHints, useLayerMessage, useMountContext, type EntryProps } from "@waifucave/clover-plugin-sdk/ui";
import { BotTab as FBotTab, Window as FWindow } from "@clover-child/shell";
import { Sidebar as FSidebar, type SidebarBot, type SidebarRoute } from "@clover-child/sidebar";
import { ConversationView } from "@clover-child/conversation";
import { Composer as FComposer } from "@clover-child/composer";
import { PanelHost, PanelToggles, SessionView as FSessionView } from "@clover-child/panel";
import { DiffPanel as FDiffPanel } from "@clover-child/panel-diff";
import { FilesPanel as FFilesPanel } from "@clover-child/panel-files";
import { TerminalPanel as FTerminalPanel } from "@clover-child/panel-terminal";
import { SettingsModal as FSettingsModal } from "@clover-child/settings";
import type { SettingsSection, SettingsValues } from "@clover-child/settings";

type Props<P> = EntryProps<P>;
const noop = () => undefined;

interface BotRef {
  id: string;
  name: string;
}

/** `app.root`: the window frame, the sidebar, the open tab, the panel and the settings dialog. */
export function Window(_: Props<Record<string, never>>) {
  const ctx = useMountContext();
  const bots = ctx.bots ?? [];
  const first = bots[0]?.id ?? "alpha";
  const [route, setRoute] = useState<SidebarRoute>({ kind: "bot", botId: first });
  const [open, setOpen] = useState<string[]>([]);
  const [settings, setSettings] = useState(false);
  const bot: BotRef = useMemo(() => {
    const id = route.kind === "bot" ? route.botId : first;
    return bots.find((b) => b.id === id) ?? { id, name: id.charAt(0).toUpperCase() + id.slice(1) };
  }, [route, bots, first]);
  const session = `${bot.id}:main`;
  const navigate = useCallback((r: SidebarRoute) => {
    if (r.kind === "settings") setSettings(true);
    else setRoute(r);
  }, []);
  useLayerMessage((m) => {
    if (m.type === "command" && m.name === "open-settings") setSettings(true);
  });
  const toggle = useCallback((id: string) => setOpen((o) => (o.includes(id) ? o.filter((x) => x !== id) : [...o, id].slice(-2))), []);
  const views = open.map((id) => ({ id, title: id === "session" ? "Session" : id.charAt(0).toUpperCase() + id.slice(1), content: <Spot name="panel" spotKey={id} props={{ app: id, session }} /> }));
  return (
    <SpotHints.Provider value={{ session: "bot" }}>
      <FWindow
        sidebar={<Spot name="sidebar" props={{ route, onNavigate: navigate, onOpenSettings: () => setSettings(true) }} />}
        title={bot.name}
        toggles={<PanelToggles kind="bot" open={open} onToggle={toggle} />}
        panel={views.length > 0 ? <PanelHost kind="bot" views={views} onClose={(id) => setOpen((o) => o.filter((x) => x !== id))} /> : undefined}
        dialog={settings ? <Spot name="main" spotKey="settings" props={{ route: "settings", params: {}, onClose: () => setSettings(false) }} /> : undefined}
        onCloseDialog={() => setSettings(false)}
        translucent={ctx.material !== "none"}
      >
        <Spot name="bot.tab" spotKey={bot.id} props={{ bot }} />
      </FWindow>
    </SpotHints.Provider>
  );
}

/** `bot.tab` (asked of lane F for the shell's manifest): a bot's tab, its conversation over its composer. */
export function BotTab({ props }: Props<{ bot: BotRef }>) {
  const session = `${props.bot.id}:main`;
  return (
    <FBotTab
      conversation={<Spot name="conversation" props={{ bot: props.bot, session }} />}
      composer={<Spot name="composer" props={{ bot: props.bot, session }} />}
    />
  );
}

/** `sidebar`: the bots this computer knows; the code side waits for sessions (lane D). */
export function Sidebar({ props }: Props<{ route?: SidebarRoute; onNavigate?: (r: SidebarRoute) => void; onOpenSettings?: () => void }>) {
  const ctx = useMountContext();
  const [side, setSide] = useState<"bots" | "code">("bots");
  const bots: SidebarBot[] = (ctx.bots ?? []).map((b) => ({ id: b.id, name: b.name, state: "idle" }));
  return (
    <FSidebar
      side={side}
      onSideChange={setSide}
      route={props.route ?? { kind: "bot", botId: bots[0]?.id ?? "alpha" }}
      onNavigate={props.onNavigate ?? noop}
      bots={bots}
      account={{ name: "You", detail: "This computer" }}
      onOpenSettings={props.onOpenSettings ?? noop}
      safeMode={ctx.safeMode}
    />
  );
}

/** `conversation`: empty until the core's sessions reach layers (lane D). */
export function Conversation({ props }: Props<{ bot: BotRef; session: string }>) {
  return <ConversationView bot={props.bot} session={props.session} items={[]} />;
}

/** `composer`: a live field; sending waits for the core's sessions (lane D). */
export function Composer({ props }: Props<{ bot: BotRef; session: string }>) {
  const [value, setValue] = useState("");
  return <FComposer botName={props.bot.name} value={value} onChange={setValue} onSend={() => setValue("")} />;
}

/** `panel` keyed `session`. */
export function SessionView({ props: _ }: Props<{ app: string; session?: string }>) {
  return <FSessionView kind="bot" />;
}

/** `panel` keyed `diff`, `files`, `terminal`: code sessions only (`when.session`), drawn empty. */
export function DiffPanel(_: Props<{ app: string }>) {
  return <FDiffPanel files={[]} layout="unified" />;
}
export function FilesPanel(_: Props<{ app: string }>) {
  return <FFilesPanel root="" listing={{}} onOpen={noop} />;
}
export function TerminalPanel(_: Props<{ app: string }>) {
  return <FTerminalPanel tabs={[]} active="" chunks={[]} />;
}

const VALUES: SettingsValues = {
  account: { name: "You", main: "This computer" },
  appearance: { theme: "system", textSize: "default" },
  language: { id: "en", name: "English" },
  notifications: { needsYou: true, agentDone: true, routineFailed: true, sounds: false },
  plugins: [],
  themes: [{ id: "clover/base-theme#clover", name: "Clover" }],
  theme: "clover/base-theme#clover",
  levels: [],
  levelOptions: [],
  devices: [],
};

/** `main` keyed `settings`: shown as the window's dialog. */
export function SettingsModal({ props }: Props<{ onClose?: () => void }>) {
  const [section, setSection] = useState<SettingsSection>("appearance");
  const [values, setValues] = useState(VALUES);
  const change = (path: string, value: unknown): void => {
    const [group, key] = path.split(".");
    if (group === undefined || key === undefined) return;
    setValues((v) => ({ ...v, [group]: { ...(v as unknown as Record<string, Record<string, unknown>>)[group], [key]: value } }));
  };
  return <FSettingsModal section={section} onSection={setSection} onClose={props.onClose ?? noop} values={values} onChange={change} onOpenLanguage={noop} />;
}
