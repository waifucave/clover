// Whole-window screens, for the owner's approval: the parts composed the way a desktop agent app lays
// them out (the sidebar on the window's material, the translucent title bar with the panel toggles, the
// conversation over the composer, the column beside it, the right-hand panel with up to two views, and
// dialogs over it all), on a desktop wallpaper with the macOS window controls drawn in. Each at 1440 by
// 900 and 1024 by 700, and three at the reference shots' own window size, 1512 by 950. The gallery
// shoots each in light and dark.
//
// A code session has every panel: its column, the terminal, the changes, the files (its folder) and the
// browser. A bot's tab has its slim column and the browser; one of its coding agents opens in the panel.
import { useState, type ReactNode } from "react";
import { Composer } from "../../composer/client/Composer";
import { LEVEL, MODELS } from "../../composer/gallery/stories";
import { ConversationView } from "../../conversation/client/ConversationView";
import { UiRuntimeProvider } from "../../conversation/client/sdk";
import type { ConversationItem, TurnState } from "../../conversation/client/types";
import { APPROVAL_PENDING, BASIC, BOT, DEVICE, FORMAT, GREETING, NOW, SEALED_CARDS, at, bot, tool, user } from "../../conversation/gallery/fixtures";
import { mockRuntime } from "../../conversation/gallery/mock-runtime";
import { DiffLayoutSwitch, DiffPanel, DiffTitle } from "../../panel-diff/client/DiffPanel";
import type { DiffLayout } from "../../panel-diff/client/types";
import { FILES } from "../../panel-diff/gallery/fixtures";
import { FilesPanel, FilesTitle } from "../../panel-files/client/FilesPanel";
import { COMPUTER, LISTING, OPEN_FILE, ROOT } from "../../panel-files/gallery/fixtures";
import { TerminalPanel, TerminalTabs } from "../../panel-terminal/client/TerminalPanel";
import { FEED, TABS as TERMINAL_TABS } from "../../panel-terminal/gallery/fixtures";
import { PanelHost } from "../../panel/client/PanelHost";
import { belongsIn, PanelToggles, toggleView } from "../../panel/client/PanelToggles";
import { SessionView } from "../../panel/client/SessionView";
import type { PanelView, SessionKind } from "../../panel/client/types";
import { BOT_COLUMN, SESSION } from "../../panel/gallery/fixtures";
import { LanguageChooser } from "../../settings/client/LanguageChooser";
import { LANGUAGES } from "../../settings/gallery/fixtures";
import { SettingsDemo } from "../../settings/gallery/stories";
import { SidebarDemo } from "../../sidebar/gallery/stories";
import { BotTab, Window } from "../client/Window";
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
    "Done. The host now holds at most two views, one above the other, and each panel is a plugin of its own:\n\n- **Terminal**, **Changes** and **Files** each fill the `panel` spot, keyed by their name.\n- The session column stays beside the conversation, apart from the two.\n\nThe panel's tests pass. Want me to open a pull request?",
  ),
];

/** A longer session, laid out like the reference shots: enough to scroll under the title bar. */
const LONG_ITEMS: ConversationItem[] = [
  user(at(0, 13, 40), "Before the panels: the gallery job went red on Windows last night. Can you see why?"),
  tool(at(0, 13, 40), { name: "Bash", detail: "gh run view --log-failed", computer: "Studio", output: "test · windows-2025  panel-files › filter › a name under a subfolder\nexpected 1 match, got 0" }),
  tool(at(0, 13, 41), { name: "Read", detail: "plugins/clover/panel-files/client/filter.ts", computer: "Studio" }),
  bot(
    at(0, 13, 42),
    "It's the files filter. It splits paths on `/` only, so on Windows a name inside a subfolder never matched:\n\n- `visiblePaths` now splits on either separator\n- a new test covers a Windows path\n- no other part splits paths itself\n\nThe rest of the run was green. I'll push the fix with the panels, since they share the branch.",
  ),
  user(at(0, 13, 44), "Good. Then start on the panels."),
  tool(at(0, 13, 44), { name: "Edit", detail: "plugins/clover/panel-files/client/filter.ts", computer: "Studio", diff: { path: "plugins/clover/panel-files/client/filter.ts", added: 3, removed: 1, diffId: "d0" } }),
  tool(at(0, 13, 45), { name: "Bash", detail: "bun test plugins/clover/panel-files", computer: "Studio", output: "21 pass\n0 fail" }),
  bot(at(0, 13, 45), "Fixed, and the files tests pass. The panels next: I'll keep each one a plugin of its own, so the browser can arrive later from [its own plugin](https://github.com/waifucave/clover/pulls) without the host changing."),
  ...CODE_ITEMS,
];

/** A bot's tab: Alpha starts a coding agent (ACP) for the user, and it runs. */
const BOT_AGENT_ITEMS: ConversationItem[] = [
  ...GREETING,
  user(at(0, 10, 0), "The garden planner's CSV export puts every date a day early. Can you get that fixed?"),
  bot(
    at(0, 10, 1),
    "I've started **Codex** on it, in `~/projects/garden-planner` on Studio. It's working now: open it from the column to follow along or tell it something.",
  ),
];

/** The coding agent's own transcript, as the panel shows it: Alpha's ask, its run, its answer. */
const AGENT_ID = "agent-export";
const AGENT_ITEMS: ConversationItem[] = [
  user(at(0, 10, 1), "Dates in the CSV export come out a day early for anyone east of UTC. Find out why and fix it in ~/projects/garden-planner."),
  tool(at(0, 10, 2), { name: "Grep", detail: "toISOString src/export", computer: "Studio", output: "src/export/csv.ts:41:  row.date.toISOString().slice(0, 10)," }),
  tool(at(0, 10, 2), { name: "Read", detail: "src/export/csv.ts", computer: "Studio" }),
  tool(at(0, 10, 3), { name: "Edit", detail: "src/export/csv.ts", computer: "Studio", diff: { path: "src/export/csv.ts", added: 4, removed: 2, diffId: "a1" } }),
  tool(at(0, 10, 4), { name: "Bash", detail: "bun test src/export", computer: "Studio", output: "9 pass\n0 fail" }),
  bot(
    at(0, 10, 5),
    "Found it. The export wrote each date with `toISOString()`, which turns local midnight into the day before for anyone east of UTC. It now writes the date as it was entered:\n\n- `src/export/csv.ts` formats dates in the planner's own time zone\n- a new test covers a date entered in Tokyo\n\nThe export's tests pass. I'm checking the import side for the same mistake next.",
  ),
];

/** A long session with a card waiting in it and more after it, so the transcript scrolls past the card:
 *  the card pins below the title bar, never under it (spec §5.5; the gallery job checks it). */
const CARD_UNDER_BAR_ITEMS: ConversationItem[] = [
  ...LONG_ITEMS,
  ...APPROVAL_PENDING,
  user(at(0, 16, 3), "While that waits: did the docs build pass?"),
  tool(at(0, 16, 3), { name: "Bash", detail: "bun run docs:build", computer: "Studio", output: "built 42 pages in 6.1 s\nno broken links" }),
  tool(at(0, 16, 4), { name: "Bash", detail: "bun run docs:check-links --external", computer: "Studio", output: "checked 318 links\n2 redirects" }),
  bot(
    at(0, 16, 4),
    "Yes. The docs build is green:\n\n- 42 pages, built in about six seconds\n- no broken links inside the docs\n- two outside links redirect, both to the same pages under a new address\n- the plugin pages list all nine parts\n- the screenshots in the gallery guide are from this week\n\nI'll update the two redirected links after the push, so the build doesn't have to follow them.",
  ),
  user(at(0, 16, 5), "Fine. And the release notes?"),
  bot(
    at(0, 16, 6),
    "Drafted, not published. They cover the panels as plugins, the sidebar plugin, the Files panel for code sessions, and the hidden-character marks in the changes and files views. I'll put them up once the push is through and CI is green on all three systems.",
  ),
  user(at(0, 16, 7), "Add a line about the terminal's paste, too."),
  bot(
    at(0, 16, 7),
    "Added under the terminal:\n\n> A paste never goes in as keystrokes. It arrives whole, and Clover asks before a paste of several lines runs. On Windows and Linux, Ctrl+V and Ctrl+Shift+V paste; on macOS, ⌘V.\n\nThat's the last of the notes. Everything else waits on your answer to the push.",
  ),
];

type PanelKind = "terminal" | "diff" | "browser" | "files" | "agent";

interface PanelState {
  layout: DiffLayout;
  setLayout: (l: DiffLayout) => void;
  agentDraft: string;
  setAgentDraft: (d: string) => void;
}

function panelView(kind: PanelKind, state: PanelState): PanelView {
  switch (kind) {
    case "terminal":
      return {
        id: "terminal",
        title: "Terminal",
        header: <TerminalTabs tabs={TERMINAL_TABS} active="t1" onSelect={noop} onNew={noop} onClose={noop} />,
        content: <TerminalPanel tabs={TERMINAL_TABS} active="t1" chunks={FEED} onInput={noop} onPaste={noop} />,
      };
    case "diff":
      return {
        id: "diff",
        title: "Changes",
        header: <DiffTitle base="main" target="working tree" targets={["last commit"]} onTarget={noop} />,
        actions: <DiffLayoutSwitch layout={state.layout} onChange={state.setLayout} />,
        content: <DiffPanel files={FILES} layout={state.layout} initialOpen={[FILES[0]!.path]} onOpenFile={noop} notice="Large files start folded. Open one to see it whole." />,
      };
    case "browser":
      // The browser panel is lane L's plugin, not in this build: the host's placeholder shows instead.
      return { id: "browser", title: "Browser" };
    case "files":
      // The session's own folder, read from the computer that holds it.
      return {
        id: "files",
        title: "Files",
        header: <FilesTitle root={ROOT} computer={COMPUTER} />,
        content: <FilesPanel root={ROOT} listing={LISTING} initialOpen={[`${ROOT}/plugins`, `${ROOT}/plugins/clover`, `${ROOT}/plugins/clover/panel`]} onOpen={noop} open={OPEN_FILE} />,
      };
    case "agent":
      // A bot's coding agent, opened from its slim column: its transcript and a composer of its own,
      // without the code side's panels or a column of its own.
      return { id: "agent", title: "Codex · Fix the CSV export's dates", content: <AgentTab draft={state.agentDraft} setDraft={state.setAgentDraft} /> };
  }
}

function AgentTab({ draft, setDraft }: { draft: string; setDraft: (d: string) => void }) {
  return (
    <BotTab
      conversation={
        <UiRuntimeProvider runtime={runtime}>
          <ConversationView
            bot={{ id: "codex", name: "Codex" }}
            session={AGENT_ID}
            items={AGENT_ITEMS}
            turn={{ running: true, phase: "working" }}
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
      }
      composer={<Composer botName="Codex" value={draft} onChange={setDraft} onSend={() => setDraft("")} onAttach={noop} onStop={noop} running model={MODELS} />}
    />
  );
}

interface ScreenConfig {
  side: "bots" | "code";
  /** The sidebar as a rail. */
  rail?: boolean;
  items: ConversationItem[];
  turn?: TurnState;
  title: string;
  /** The column beside the conversation: a code session's, or a bot's slim one. */
  session?: boolean;
  panels?: PanelKind[];
  dialog?: "settings" | "languages";
  cardPending?: boolean;
  draft?: string;
  /** The files panel with no file open. */
  noFile?: boolean;
}

function Screen({ config }: { config: ScreenConfig }) {
  const [open, setOpen] = useState<string[]>([...(config.session ? ["session"] : []), ...(config.panels ?? [])]);
  const [draft, setDraft] = useState(config.draft ?? "");
  const [layout, setLayout] = useState<DiffLayout>("unified");
  const [agentDraft, setAgentDraft] = useState("");
  const [dialog, setDialog] = useState(config.dialog);
  // Every card this window will draw: the conversation's, and one Settings raises (a level change,
  // removing a device), which closes Settings.
  const [cardPending, setCardPending] = useState(config.cardPending ?? false);
  const raiseCard = () => setCardPending(true);
  const panels = open.filter((v): v is PanelKind => v !== "session");
  const coding = config.side === "code";
  const kind: SessionKind = coding ? "code" : "bot";
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
      cardPending={cardPending}
      model={MODELS}
      level={LEVEL}
      voice={{ listening: false, onPressStart: noop, onPressEnd: noop }}
    />
  );
  let dialogNode: ReactNode;
  if (dialog === "settings") dialogNode = <SettingsDemo start="appearance" onRequestLevel={raiseCard} onRemoveDevice={raiseCard} />;
  if (dialog === "languages") dialogNode = <LanguageChooser languages={LANGUAGES} current="en-US" onPick={() => setDialog(undefined)} onClose={() => setDialog(undefined)} />;
  const views = panels
    .map((p) => {
      const view = panelView(p, { layout, setLayout, agentDraft, setAgentDraft });
      return p === "files" && config.noFile ? { ...view, content: <FilesPanel root={ROOT} listing={LISTING} onOpen={noop} /> } : view;
    })
    .filter((v) => belongsIn(v, kind));
  const column = coding ? SESSION : BOT_COLUMN;
  return (
    <Window
      translucent
      sidebar={<SidebarDemo side={config.side} collapsed={config.rail} start={coding ? { kind: "agent", agentId: "session-panels" } : { kind: "bot", botId: "alpha" }} />}
      title={config.title}
      onTitleMenu={noop}
      toggles={<PanelToggles kind={kind} open={open} onToggle={(id) => setOpen((o) => toggleView(o, id))} onMore={noop} />}
      side={
        open.includes("session") ? (
          <SessionView {...column} openAgent={open.includes("agent") ? AGENT_ID : undefined} onOpenAgent={() => setOpen((o) => (o.includes("agent") ? o : toggleView(o, "agent")))} />
        ) : undefined
      }
      panel={views.length > 0 ? <PanelHost kind={kind} views={views} onClose={(id) => setOpen((o) => o.filter((v) => v !== id))} onExpand={noop} onFindPlugin={noop} /> : undefined}
      dialog={dialogNode}
      cardPending={cardPending}
      onCloseDialog={() => setDialog(undefined)}
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
    notes: "Alpha's tab: the conversation over the composer, the level (on Studio) and model pills under it. The sidebar lets the desktop through; the title bar lets the transcript through.",
    config: () => ({ side: "bots", items: [...GREETING, ...BASIC], title: "Alpha" }),
  },
  {
    id: "bot-column",
    title: "A bot's tab with its slim column",
    notes: "Alpha has started a coding agent. The slim column shows its agents and tasks, context and outputs; the title bar offers only the column and the browser.",
    config: () => ({ side: "bots", items: BOT_AGENT_ITEMS, title: "Alpha", session: true }),
  },
  {
    id: "bot-agent",
    title: "A bot's coding agent open in the panel",
    notes: "Picked from the slim column: the agent's own transcript, with its own composer and model picker, and none of the code side's panels.",
    config: () => ({ side: "bots", items: BOT_AGENT_ITEMS, title: "Alpha", session: true, panels: ["agent"] }),
  },
  {
    id: "code",
    title: "The code side, a run folded into one line",
    notes: "A coding session with the session column open: where it runs (the computer and its level), context, connectors, outputs, changes.",
    config: (narrow) => ({ side: "code", rail: narrow, items: CODE_ITEMS, title: "The panels as plugins", session: true }),
  },
  {
    id: "terminal",
    title: "The terminal panel open",
    notes: "panel-terminal fills the panel spot keyed terminal; its tabs sit in the panel's header.",
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
    title: "The browser panel, with no browser plugin yet",
    notes: "The browser panel is lane L's plugin. Until a plugin fills the key, the panel host says so in its place.",
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
    notes: "The settings window over the app: Clover's own sections on the left, Appearance on the right.",
    config: () => ({ side: "code", items: CODE_ITEMS, title: "The panels as plugins", session: true, dialog: "settings" }),
  },
  {
    id: "settings-pending-card",
    title: "Settings asked for while a card waits",
    notes: "No dialog opens over a waiting card (spec §5.5): settings stays shut, the title bar says why, and the card stays clickable.",
    config: () => ({ side: "bots", items: APPROVAL_PENDING, title: "Alpha", turn: { running: true, phase: "waiting" }, cardPending: true, dialog: "settings" }),
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

/** At the reference shots' window size: two laid out like them, and the card under the bar. */
const OWNER: { id: string; title: string; notes: string; config: ScreenConfig }[] = [
  {
    id: "owner-session",
    title: "Like the first reference shot: a session with its column",
    notes: "1512 × 950, the reference shots' window. The code side, a long session scrolled to its end under the title bar, and the session column.",
    config: { side: "code", items: LONG_ITEMS, title: "The panels as plugins", session: true },
  },
  {
    id: "owner-files",
    title: "Like the annotated shot: the files panel open",
    notes: "1512 × 950. The conversation beside the files panel, no file open; the sidebar's material and the title bar's blur are what the annotations point at.",
    config: { side: "code", items: LONG_ITEMS, title: "The panels as plugins", panels: ["files"], noFile: true },
  },
  {
    id: "card-under-bar",
    title: "A waiting card, the transcript scrolled past it",
    notes: "1512 × 950. The card pins just below the translucent title bar instead of scrolling under it. The gallery job scrolls this transcript and checks that the card's top stays at or below the bar and that every sealed button is what a click at its centre reaches.",
    config: { side: "code", items: CARD_UNDER_BAR_ITEMS, title: "The panels as plugins", session: true, turn: { running: true, phase: "waiting" }, cardPending: true },
  },
];

export const screenStories: Story[] = [
  ...SCREENS.flatMap((s) =>
    SIZES.map((size) => ({
      id: `screen/${s.id}-${size.tag}`,
      title: `${s.title} (${size.width} × ${size.height})`,
      notes: s.notes,
      width: size.width,
      height: size.height,
      desktop: true,
      render: () => <Screen config={s.config(size.width < 1200)} />,
    })),
  ),
  ...OWNER.map((s) => ({
    id: `screen/${s.id}-1512`,
    title: `${s.title} (1512 × 950)`,
    notes: s.notes,
    width: 1512,
    height: 950,
    desktop: true,
    render: () => <Screen config={s.config} />,
  })),
];
