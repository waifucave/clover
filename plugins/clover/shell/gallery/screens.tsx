// Whole-window screens, for the owner's approval: the parts composed the way a desktop agent app lays
// them out (the sidebar on the window's material, the translucent title bar with the panel toggles, the
// conversation over the composer, the session column, the right-hand panel with up to two views, and
// dialogs over it all), on a desktop wallpaper with the macOS window controls drawn in. Each at 1440 by
// 900 and 1024 by 700, and two at the reference shots' own window size, 1512 by 950. The gallery shoots
// each in light and dark.
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
import { FilesPanel } from "../../panel-files/client/FilesPanel";
import { LISTING, OPEN_FILE, ROOT } from "../../panel-files/gallery/fixtures";
import { TerminalPanel, TerminalTabs } from "../../panel-terminal/client/TerminalPanel";
import { FEED, TABS as TERMINAL_TABS } from "../../panel-terminal/gallery/fixtures";
import { PanelHost } from "../../panel/client/PanelHost";
import { PanelToggles, toggleView } from "../../panel/client/PanelToggles";
import { SessionView } from "../../panel/client/SessionView";
import type { PanelView } from "../../panel/client/types";
import { SESSION } from "../../panel/gallery/fixtures";
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
  user(at(0, 13, 40), "Before we split the panels: which of the old worktrees can go?"),
  tool(at(0, 13, 40), { name: "Bash", detail: "git worktree list", computer: "Studio", output: "~/projects/clover  main\n~/projects/clover-a  lane/a-m1\n~/projects/clover-b  lane/b-m0" }),
  tool(at(0, 13, 41), { name: "Bash", detail: "git -C ~/projects/clover-a status --short", computer: "Studio", output: "" }),
  bot(
    at(0, 13, 42),
    "Five of them have nothing left in them. None has uncommitted changes, and all their commits are already in `main`:\n\n- `lane-a-m0`\n- `lane-c-spike-s2`\n- `lane-e-m0`\n- `lane-h-m0`\n- `scratch-ci`\n\nOnly the checked-out folders go; the branches and their commits stay in git. I'd keep `lane-f-m1`, which is the one this session works in.",
  ),
  user(at(0, 13, 44), "Good, remove those five. Then start on the panels."),
  tool(at(0, 13, 44), { name: "Bash", detail: "git worktree remove lane-a-m0 && git worktree remove lane-c-spike-s2", computer: "Studio", output: "" }),
  tool(at(0, 13, 45), { name: "Bash", detail: "git worktree prune", computer: "Studio", output: "" }),
  bot(at(0, 13, 45), "All five are gone, about 4 GB back. The panels next: I'll keep each one a plugin of its own, so the browser can arrive later from [its own plugin](https://github.com/waifucave/clover/pulls) without the host changing."),
  ...CODE_ITEMS,
];

type PanelKind = "terminal" | "diff" | "browser" | "files";

function panelView(kind: PanelKind, state: { layout: DiffLayout; setLayout: (l: DiffLayout) => void }): PanelView {
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
  /** The files panel with no file open. */
  noFile?: boolean;
}

function Screen({ config }: { config: ScreenConfig }) {
  const [open, setOpen] = useState<string[]>([...(config.session ? ["session"] : []), ...(config.panels ?? [])]);
  const [draft, setDraft] = useState(config.draft ?? "");
  const [layout, setLayout] = useState<DiffLayout>("unified");
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
  if (dialog === "settings") dialogNode = <SettingsDemo start="appearance" />;
  if (dialog === "languages") dialogNode = <LanguageChooser languages={LANGUAGES} current="en-US" onPick={() => setDialog(undefined)} onClose={() => setDialog(undefined)} />;
  const views = panels.map((p) => {
    const view = panelView(p, { layout, setLayout });
    return p === "files" && config.noFile ? { ...view, content: <FilesPanel root={ROOT} listing={LISTING} onOpen={noop} /> } : view;
  });
  return (
    <Window
      translucent
      sidebar={<SidebarDemo side={config.side} collapsed={config.rail} start={coding ? { kind: "agent", agentId: "session-panels" } : { kind: "bot", botId: "alpha" }} />}
      title={config.title}
      onTitleMenu={noop}
      toggles={<PanelToggles open={open} onToggle={(id) => setOpen((o) => toggleView(o, id))} onMore={noop} />}
      side={open.includes("session") ? <SessionView {...SESSION} /> : undefined}
      panel={views.length > 0 ? <PanelHost views={views} onClose={(id) => setOpen((o) => o.filter((v) => v !== id))} onExpand={noop} onFindPlugin={noop} /> : undefined}
      dialog={dialogNode}
      cardPending={config.cardPending}
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

/** The two laid out like the owner's reference shots, at their window size. */
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
