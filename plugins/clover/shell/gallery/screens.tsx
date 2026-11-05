// Whole-window screens, for the owner's approval: the parts composed the way a desktop agent app lays
// them out — the sidebar, the title bar with the panel toggles, the conversation over the composer,
// the session column, the right-hand panel with up to two views, and dialogs over it all. Each at
// 1440 by 900 and 1024 by 700; the gallery shoots each in light and dark.
import { useState, type ReactNode } from "react";
import { Composer } from "../../composer/client/Composer";
import { LEVEL, MODELS } from "../../composer/gallery/stories";
import { ConversationView } from "../../conversation/client/ConversationView";
import { UiRuntimeProvider } from "../../conversation/client/sdk";
import type { ConversationItem, TurnState } from "../../conversation/client/types";
import { APPROVAL_PENDING, BASIC, BOT, DEVICE, FORMAT, GREETING, NOW, SEALED_CARDS, at, bot, tool, user } from "../../conversation/gallery/fixtures";
import { mockRuntime } from "../../conversation/gallery/mock-runtime";
import { BrowserPanel, BrowserTabs } from "../../panel-browser/client/BrowserPanel";
import type { AnnotateTool } from "../../panel-browser/client/types";
import { TABS as BROWSER_TABS } from "../../panel-browser/gallery/fixtures";
import { DiffLayoutSwitch, DiffPanel, DiffTitle } from "../../panel-diff/client/DiffPanel";
import type { DiffLayout } from "../../panel-diff/client/types";
import { FILES } from "../../panel-diff/gallery/fixtures";
import { FilesPanel } from "../../panel-files/client/FilesPanel";
import { LISTING, OPEN_FILE, ROOT } from "../../panel-files/gallery/fixtures";
import { TerminalPanel } from "../../panel-terminal/client/TerminalPanel";
import { FEED, TABS as TERMINAL_TABS } from "../../panel-terminal/gallery/fixtures";
import { PanelHost } from "../../panel/client/PanelHost";
import { PanelToggles, toggleView } from "../../panel/client/PanelToggles";
import { SessionView } from "../../panel/client/SessionView";
import type { PanelView } from "../../panel/client/types";
import { SESSION } from "../../panel/gallery/fixtures";
import { LanguageChooser } from "../../settings/client/LanguageChooser";
import { LANGUAGES } from "../../settings/gallery/fixtures";
import { SettingsDemo } from "../../settings/gallery/stories";
import { BotTab, Window } from "../client/Window";
import { SidebarDemo } from "./stories";
import type { Story } from "./story";

const noop = () => undefined;
const runtime = mockRuntime({ cards: SEALED_CARDS });

/** A coding session: the user's ask, one run of work folded into a line, and the answer. */
const CODE_ITEMS: ConversationItem[] = [
  user(at(0, 15, 2), "Split the panel host from the panels, and give each panel its own spot so a plugin can replace it."),
  tool(at(0, 15, 2), { name: "Bash", detail: "git status --short", computer: "Studio", output: " M plugins/clover/panel/client/PanelHost.tsx" }),
  tool(at(0, 15, 3), { name: "Edit", detail: "plugins/clover/panel/client/PanelHost.tsx", computer: "Studio", diff: { path: "plugins/clover/panel/client/PanelHost.tsx", added: 41, removed: 12, diffId: "d1" } }),
  tool(at(0, 15, 3), { name: "Edit", detail: "plugins/clover/panel/client/PanelToggles.tsx", computer: "Studio", diff: { path: "plugins/clover/panel/client/PanelToggles.tsx", added: 6, removed: 2, diffId: "d2" } }),
  tool(at(0, 15, 4), { name: "Read", detail: "plugins/clover/shell/client/Window.tsx", computer: "Studio" }),
  tool(at(0, 15, 4), { name: "Grep", detail: "spot: \"panel\"", computer: "Studio" }),
  tool(at(0, 15, 5), { name: "Bash", detail: "bun test plugins/clover/panel", computer: "Studio", output: "16 pass\n0 fail" }),
  bot(
    at(0, 15, 6),
    "Done. The host now holds at most two views, one above the other, and each panel is a plugin of its own:\n\n- **Terminal**, **Changes**, **Browser** and **Files** each fill the `panel` spot, keyed by their name.\n- The session column stays beside the conversation, apart from the two.\n\nThe panel's tests pass. Want me to open a pull request?",
  ),
];

type PanelKind = "terminal" | "diff" | "browser" | "files";

function panelView(kind: PanelKind, state: { layout: DiffLayout; setLayout: (l: DiffLayout) => void; tab: string; setTab: (t: string) => void; tool: AnnotateTool | null; setTool: (t: AnnotateTool | null) => void }): PanelView {
  switch (kind) {
    case "terminal":
      return { id: "terminal", title: "Terminal", content: <TerminalPanel tabs={TERMINAL_TABS} active="t1" chunks={FEED} onInput={noop} onSelect={noop} onNew={noop} onClose={noop} /> };
    case "diff":
      return {
        id: "diff",
        title: "Changes",
        header: <DiffTitle base="main" target="working tree" targets={["last commit"]} onTarget={noop} />,
        actions: <DiffLayoutSwitch layout={state.layout} onChange={state.setLayout} />,
        content: <DiffPanel files={FILES} layout={state.layout} initialOpen={[FILES[0]!.path]} onOpenFile={noop} notice="Large files start folded. Open one to see it whole." />,
      };
    case "browser":
      return {
        id: "browser",
        title: "Browser",
        header: <BrowserTabs tabs={BROWSER_TABS} active={state.tab} onSelect={state.setTab} onClose={noop} onNew={noop} />,
        content: <BrowserPanel tab={BROWSER_TABS.find((t) => t.id === state.tab)} onBack={noop} onReload={noop} onNavigate={noop} annotate={{ tool: state.tool, onTool: state.setTool }} />,
      };
    case "files":
      return {
        id: "files",
        title: "Files",
        content: <FilesPanel root={ROOT} listing={LISTING} initialOpen={[`${ROOT}/plugins`, `${ROOT}/plugins/clover`, `${ROOT}/plugins/clover/panel`]} onOpen={noop} open={OPEN_FILE} />,
      };
  }
}

interface ScreenConfig {
  side: "bots" | "code";
  /** The sidebar as a rail. */
  rail?: boolean;
  items: ConversationItem[];
  turn?: TurnState;
  title: string;
  /** The session column. */
  session?: boolean;
  panels?: PanelKind[];
  dialog?: "settings" | "languages";
  cardPending?: boolean;
  draft?: string;
}

function Screen({ config }: { config: ScreenConfig }) {
  const [open, setOpen] = useState<string[]>([...(config.session ? ["session"] : []), ...(config.panels ?? [])]);
  const [draft, setDraft] = useState(config.draft ?? "");
  const [layout, setLayout] = useState<DiffLayout>("unified");
  const [tab, setTab] = useState("b1");
  const [tool, setTool] = useState<AnnotateTool | null>(null);
  const [dialog, setDialog] = useState(config.dialog);
  const panels = open.filter((v): v is PanelKind => v !== "session");
  const coding = config.side === "code";
  const conversation = (
    <UiRuntimeProvider runtime={runtime}>
      <ConversationView
        bot={coding ? { id: "session-panels", name: "Codex" } : BOT}
        session={coding ? "session-panels" : "s_alpha"}
        items={config.items}
        turn={config.turn}
        now={NOW}
        device={DEVICE}
        format={FORMAT}
        onOpenLink={noop}
        onOpenFile={noop}
        onOpenDiff={noop}
        onAnswerQuestion={noop}
        onCopy={noop}
      />
    </UiRuntimeProvider>
  );
  const composer = (
    <Composer
      botName={coding ? "Codex" : BOT.name}
      value={draft}
      onChange={setDraft}
      onSend={() => setDraft("")}
      onAttach={noop}
      onStop={noop}
      running={config.turn?.running}
      cardPending={config.cardPending}
      model={MODELS}
      level={LEVEL}
      voice={{ listening: false, onPressStart: noop, onPressEnd: noop }}
    />
  );
  let dialogNode: ReactNode;
  if (dialog === "settings") dialogNode = <SettingsDemo start="code" />;
  if (dialog === "languages") dialogNode = <LanguageChooser languages={LANGUAGES} current="en-US" onPick={() => setDialog(undefined)} onClose={() => setDialog(undefined)} />;
  return (
    <Window
      sidebar={<SidebarDemo side={config.side} collapsed={config.rail} start={coding ? { kind: "agent", agentId: "session-panels" } : { kind: "bot", botId: "alpha" }} />}
      title={config.title}
      onTitleMenu={noop}
      toggles={<PanelToggles open={open} onToggle={(id) => setOpen((o) => toggleView(o, id))} onMore={noop} />}
      side={open.includes("session") ? <SessionView {...SESSION} /> : undefined}
      panel={
        panels.length > 0 ? (
          <PanelHost views={panels.map((p) => panelView(p, { layout, setLayout, tab, setTab, tool, setTool }))} onClose={(id) => setOpen((o) => o.filter((v) => v !== id))} onExpand={noop} />
        ) : undefined
      }
      dialog={dialogNode}
    >
      <BotTab conversation={conversation} composer={composer} />
    </Window>
  );
}

const SIZES = [
  { tag: "1440", width: 1440, height: 900 },
  { tag: "1024", width: 1024, height: 700 },
] as const;

const SCREENS: { id: string; title: string; notes: string; config: (narrow: boolean) => ScreenConfig }[] = [
  {
    id: "bots",
    title: "The bot side",
    notes: "Alpha's tab: the conversation over the composer, the level and model pills under it.",
    config: () => ({ side: "bots", items: [...GREETING, ...BASIC], title: "Alpha" }),
  },
  {
    id: "code",
    title: "The code side, a run folded into one line",
    notes: "A coding session with the session column open: environment, context, connectors, outputs, changes.",
    config: (narrow) => ({ side: "code", rail: narrow, items: CODE_ITEMS, title: "The panels as plugins", session: true }),
  },
  {
    id: "terminal",
    title: "The terminal panel open",
    notes: "panel-terminal fills the panel spot keyed terminal.",
    config: (narrow) => ({ side: "code", rail: narrow, items: CODE_ITEMS, title: "The panels as plugins", panels: ["terminal"] }),
  },
  {
    id: "diff",
    title: "The changes panel open",
    notes: "panel-diff: main → working tree, the first file open, unified.",
    config: (narrow) => ({ side: "code", rail: narrow, items: CODE_ITEMS, title: "The panels as plugins", panels: ["diff"] }),
  },
  {
    id: "browser",
    title: "The browser panel open",
    notes: "panel-browser draws the chrome; the dashed frame is where lane L's live view goes.",
    config: (narrow) => ({ side: "code", rail: narrow, items: CODE_ITEMS, title: "The panels as plugins", panels: ["browser"] }),
  },
  {
    id: "files",
    title: "The files panel open",
    notes: "panel-files: the open file beside the filtered tree.",
    config: (narrow) => ({ side: "code", rail: narrow, items: CODE_ITEMS, title: "The panels as plugins", panels: ["files"] }),
  },
  {
    id: "two-panels",
    title: "Two panels at once",
    notes: "The changes over the terminal, each with its own header.",
    config: (narrow) => ({ side: "code", rail: narrow, items: CODE_ITEMS, title: "The panels as plugins", panels: ["diff", "terminal"] }),
  },
  {
    id: "settings",
    title: "Settings",
    notes: "The settings window over the app: sections on the left, the Code page on the right.",
    config: () => ({ side: "code", items: CODE_ITEMS, title: "The panels as plugins", session: true, dialog: "settings" }),
  },
  {
    id: "languages",
    title: "The language chooser",
    notes: "Each language in itself and in English; the current one checked.",
    config: () => ({ side: "bots", items: [...GREETING, ...BASIC], title: "Alpha", dialog: "languages" }),
  },
  {
    id: "approval",
    title: "A pending approval",
    notes: "The sealed card in the conversation, one sealed button per option; the composer's pills wait while it's pending.",
    config: () => ({ side: "bots", items: APPROVAL_PENDING, title: "Alpha", turn: { running: true, phase: "waiting" }, cardPending: true }),
  },
];

export const screenStories: Story[] = SCREENS.flatMap((s) =>
  SIZES.map((size) => ({
    id: `screen/${s.id}-${size.tag}`,
    title: `${s.title} (${size.width} × ${size.height})`,
    notes: s.notes,
    width: size.width,
    height: size.height,
    render: () => <Screen config={s.config(size.width < 1200)} />,
  })),
);
