// Whole-window screens, for the owner's approval: the default shell on the runtime (`<Spot name="app.root">`) in a
// pretend world (`world.tsx`), every spot filled by the entry the resolution rules pick, on a desktop wallpaper with the
// macOS window controls drawn in. The M1 screens at 1440 by 900 and 1024 by 700, three at the reference shots' own
// window size (1512 by 950), and the M2 screens (Settings' plugins, the plugin index, the bot editor, the archive, an
// agent's live tab, add-ons) at 1440 by 900. The gallery shoots each in light and dark.
//
// A code session has every panel: its column, the terminal, the changes, the files (its folder) and the browser (lane
// L's, so the host's placeholder for now). A bot's tab has its slim column and the browser; one of its coding agents
// opens in the panel as a live tab of its own (the owner's item 90).
import { useState } from "react";
import type { ConversationItem } from "../../conversation/client/types";
import { APPROVAL_PENDING, APPROVAL_PENDING_CARD, at, BASIC, bot, GREETING, tool, user } from "../../conversation/gallery/fixtures";
import { Spot, UiRuntimeProvider } from "../client/sdk";
import type { ShellStart } from "../client/Shell";
import type { EntryComponent } from "../runtime/types";
import type { Story } from "./story";
import { waitingCard, world, type WorldOptions } from "./world";

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
  bot(at(0, 10, 1), "I've started **Codex** on it, in `~/projects/garden-planner` on Studio. It's working now: open it from the column to follow along or tell it something."),
];

/** The coding agent's own transcript: Alpha's ask, its run, its answer. */
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

/** A long session with a card waiting in it and more after it, so the transcript scrolls past the card. */
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
  bot(at(0, 16, 6), "Drafted, not published. They cover the panels as plugins, the sidebar plugin, the Files panel for code sessions, and the hidden-character marks in the changes and files views. I'll put them up once the push is through and CI is green on all three systems."),
  user(at(0, 16, 7), "Add a line about the terminal's paste, too."),
  bot(
    at(0, 16, 7),
    "Added under the terminal:\n\n> A paste never goes in as keystrokes. It arrives whole, and Clover asks before a paste of several lines runs. On Windows and Linux, Ctrl+V and Ctrl+Shift+V paste; on macOS, ⌘V.\n\nThat's the last of the notes. Everything else waits on your answer to the push.",
  ),
];

// -------------------------------------------------------------------------------------------------
// An add-on plugin, for the add-ons screen: it adds to the parts without replacing them (spec §5.5)
// -------------------------------------------------------------------------------------------------

const TarotButton: EntryComponent = () => (
  <button type="button" className="cl-panel-toggle story-addon-button" aria-label="Draw a card" title="Draw a card">
    ✦
  </button>
);
const UsageStatus: EntryComponent = () => <span className="story-addon-status">Usage today: 42% of your budget · resets at midnight</span>;
const Reactions: EntryComponent = ({ props }) =>
  (props.item as { kind?: string } | undefined)?.kind === "bot" ? (
    <div className="story-addon-reactions" aria-label="Reactions">
      <span>👍 2</span>
      <span>✨ 1</span>
    </div>
  ) : null;
const Badge: EntryComponent = () => null;

const TAROT: NonNullable<WorldOptions["extra"]>[number] = {
  pluginId: "tarot-panel",
  capabilities: ["conversation.read"],
  components: { TarotButton, UsageStatus, Reactions, Badge },
  entries: [
    { id: "draw", spot: "bot.header.action", component: "TarotButton", fields: { title: "Draw a card" } },
    { id: "usage", spot: "status", component: "UsageStatus" },
    { id: "reactions", spot: "conversation.message.extra", component: "Reactions" },
    { id: "app", spot: "sidebar.app", component: "Badge", fields: { title: "Tarot", opens: "tarot" } },
  ],
};

// -------------------------------------------------------------------------------------------------
// The screens
// -------------------------------------------------------------------------------------------------

interface ScreenConfig {
  start: ShellStart;
  world?: WorldOptions;
}

const BOT_TAB = { route: "bot", params: { bot: "alpha" } };
const CODE_TAB = { route: "agent", params: { session: "session-panels" } };
const code = (panels: string[], items: readonly ConversationItem[] = CODE_ITEMS): ScreenConfig => ({ start: { route: CODE_TAB, panels }, world: { transcripts: { "session-panels": { items } } } });
const alpha = (items: readonly ConversationItem[], extra: Partial<ScreenConfig> = {}): ScreenConfig => ({
  start: { route: BOT_TAB },
  ...extra,
  world: { ...extra.world, transcripts: { s_alpha: { items }, "agent-export": { items: AGENT_ITEMS, running: true }, ...extra.world?.transcripts } },
});

function Screen({ config }: { config: ScreenConfig }) {
  // One world per screen for its life: a new one each render would start every part's loads again.
  const [runtime] = useState(() => world(config.world));
  return (
    <UiRuntimeProvider runtime={runtime}>
      <Spot name="app.root" props={{ translucent: true, start: config.start }} />
    </UiRuntimeProvider>
  );
}

const SIZES = [
  { tag: "1440", width: 1440, height: 900 },
  { tag: "1024", width: 1024, height: 700 },
] as const;

/** The M1 screens, now through the runtime. */
const SCREENS: { id: string; title: string; notes: string; config: ScreenConfig }[] = [
  { id: "bots", title: "The bot side", notes: "Alpha's tab: the conversation over the composer, the level (on Studio) and model pills under it. The sidebar lets the desktop through; the title bar lets the transcript through.", config: alpha([...GREETING, ...BASIC]) },
  { id: "bot-column", title: "A bot's tab with its slim column", notes: "Alpha has started a coding agent. The slim column shows its agents and tasks, context and outputs; the title bar offers only the column and the browser.", config: alpha(BOT_AGENT_ITEMS, { start: { route: BOT_TAB, panels: ["session"] } }) },
  { id: "bot-output", title: "An output open from a bot's column", notes: "Outputs come from the session's own outputs folder, newest first; one opens in the right panel, read only.", config: alpha(BOT_AGENT_ITEMS, { start: { route: BOT_TAB, panels: ["session", "output"], output: { path: "home/Studio/.clover/outputs/s_alpha/this-week-in-clover.md", folder: "home/Studio/.clover/outputs/s_alpha" } } }) },
  { id: "bot-agent", title: "A bot's coding agent open in the panel", notes: "Picked from the slim column: the agent's own transcript, with its own composer and model picker, and none of the code side's panels.", config: alpha(BOT_AGENT_ITEMS, { start: { route: BOT_TAB, panels: ["session", "agent"], agent: "agent-export" } }) },
  { id: "code", title: "The code side, a run folded into one line", notes: "A coding session with the session column open: where it runs (the computer and its level), context, connectors, outputs, changes.", config: code(["session"]) },
  { id: "terminal", title: "The terminal panel open", notes: "panel-terminal fills the panel spot keyed terminal; its tabs sit in the panel's header.", config: code(["terminal"]) },
  { id: "diff", title: "The changes panel open", notes: "panel-diff: main → working tree, the first file open, unified.", config: code(["diff"]) },
  { id: "browser", title: "The browser panel, with no browser plugin yet", notes: "The browser panel is lane L's plugin. Until a plugin fills the key, the panel host says so in its place, and offers to find one.", config: code(["browser"]) },
  { id: "files", title: "The files panel open", notes: "panel-files: the session's folder, read from the computer that holds it.", config: code(["files"]) },
  { id: "two-panels", title: "Two panels at once", notes: "The changes over the terminal, each with its own header.", config: code(["diff", "terminal"]) },
  { id: "settings", title: "Settings", notes: "The settings window over the app: Clover's own sections on the left, Appearance on the right.", config: { start: { route: { route: "settings", params: {} }, under: CODE_TAB, panels: ["session"] }, world: { transcripts: { "session-panels": { items: CODE_ITEMS } } } } },
  {
    id: "settings-pending-card",
    title: "Settings asked for while a card waits",
    notes: "No dialog opens over a waiting card (spec §5.5): settings stays shut, the title bar says why, and the card stays clickable.",
    config: { start: { route: { route: "settings", params: {} }, under: BOT_TAB }, world: { transcripts: { s_alpha: { items: APPROVAL_PENDING, running: true } }, cards: [waitingCard(APPROVAL_PENDING_CARD, "s_alpha")] } },
  },
  { id: "languages", title: "The language chooser", notes: "Each language in itself and in English; the current one checked.", config: { start: { route: { route: "settings", params: { section: "languages" } }, under: BOT_TAB }, world: { transcripts: { s_alpha: { items: [...GREETING, ...BASIC] } } } } },
  {
    id: "approval",
    title: "A pending approval",
    notes: "The sealed card in the conversation, one sealed button per option; the composer's pills wait while it's pending.",
    config: alpha(APPROVAL_PENDING, { world: { transcripts: { s_alpha: { items: APPROVAL_PENDING, running: true } }, cards: [waitingCard(APPROVAL_PENDING_CARD, "s_alpha")] } }),
  },
];

/** At the reference shots' window size: two laid out like them, and the card under the bar. */
const OWNER: { id: string; title: string; notes: string; config: ScreenConfig }[] = [
  { id: "owner-session", title: "Like the first reference shot: a session with its column", notes: "1512 × 950, the reference shots' window. The code side, a long session scrolled to its end under the title bar, and the session column.", config: code(["session"], LONG_ITEMS) },
  { id: "owner-files", title: "Like the annotated shot: the files panel open", notes: "1512 × 950. The conversation beside the files panel, no file open; the sidebar's material and the title bar's blur are what the annotations point at.", config: code(["files"], LONG_ITEMS) },
  {
    id: "card-under-bar",
    title: "A waiting card, the transcript scrolled past it",
    notes: "1512 × 950. The card pins just below the translucent title bar instead of scrolling under it. The gallery job scrolls this transcript and checks that the card's top stays at or below the bar and that every sealed button is what a click at its centre reaches.",
    config: { start: { route: CODE_TAB, panels: ["session"] }, world: { transcripts: { "session-panels": { items: CARD_UNDER_BAR_ITEMS, running: true } }, cards: [waitingCard(APPROVAL_PENDING_CARD, "session-panels")] } },
  },
];

/** F-M2's new screens: the pages the runtime adds, and what add-ons look like. */
const M2: { id: string; title: string; notes: string; config: ScreenConfig }[] = [
  { id: "settings-plugins", title: "Settings: the plugins and their states", notes: "Each plugin with its state (B's eight), why it is in it, the OKs it runs with in plain words, its logs and its switch.", config: { start: { route: { route: "settings", params: { section: "plugins" } }, under: BOT_TAB }, world: { transcripts: { s_alpha: { items: [...GREETING, ...BASIC] } } } } },
  { id: "settings-levels", title: "Settings: each computer's level", notes: "From the computers the core knows; a pick raises a sealed card, and Settings closes for it.", config: { start: { route: { route: "settings", params: { section: "levels" } }, under: BOT_TAB }, world: { transcripts: { s_alpha: { items: [...GREETING, ...BASIC] } } } } },
  { id: "settings-devices", title: "Settings: devices", notes: "The devices page manages them (R3): pair one by a code, remove one, choose the main computer; each change asks on a card.", config: { start: { route: { route: "settings", params: { section: "devices" } }, under: BOT_TAB }, world: { transcripts: { s_alpha: { items: [...GREETING, ...BASIC] } } } } },
  { id: "settings-device-item", title: "Settings opened at a device", notes: "How the island's Devices tab opens it (lane E's useOpen, a section and an item): the Laptop's row is brought into view and marked until you move on.", config: { start: { route: { route: "settings", params: { section: "devices", item: "dev_laptop" } }, under: BOT_TAB }, world: { transcripts: { s_alpha: { items: [...GREETING, ...BASIC] } } } } },
  { id: "plugin-index", title: "The plugin index", notes: "Search the indexes you added: what's installed, what has a newer version, what isn't reviewed. Install asks for the plugin's OK on a sealed card.", config: { start: { route: { route: "plugins", params: {} } } } },
  { id: "plugin-index-for-panel", title: "The plugin index, from a panel no plugin fills", notes: "Find a plugin, from the terminal panel's placeholder: the page says what it's looking for and searches for it.", config: { start: { route: { route: "plugins", params: { spot: "panel", key: "terminal" } } } } },
  { id: "bot-editor", title: "The bot editor", notes: "Alpha's fields, kept as your own layer over its plugin's: the theme is yours (Reset), the rest Alpha's. The avatars come from the installed packs.", config: { start: { route: { route: "bot-editor", params: { bot: "alpha" } } } } },
  { id: "archive", title: "The archive of old sessions", notes: "Readable, never a bot's history; it has its own button in the sidebar.", config: { start: { route: { route: "archive", params: {} } } } },
  { id: "archive-session", title: "An old session, read", notes: "The conversation part draws it, read only. Its approvals read as notes, since no sealed card exists for them.", config: { start: { route: { route: "archive", params: { session: "w-1" } } } } },
  { id: "agent-tab", title: "An agent's live tab", notes: "Opened from the sidebar: watch it, type to it, interrupt it, stop it. Its column and the browser are its panels.", config: { start: { route: { route: "agent", params: { session: "agent-export" } }, panels: ["session"] }, world: { transcripts: { "agent-export": { items: AGENT_ITEMS, running: true } } } } },
  {
    id: "addons",
    title: "Add-ons from another plugin",
    notes: "A plugin adds without replacing: a button in the bot's header (bot.header.action), reactions under each answer (conversation.message.extra), a status bar line (status) and an app button (sidebar.app).",
    config: alpha([...GREETING, ...BASIC], { world: { extra: [TAROT] } }),
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
      render: () => <Screen config={s.config} />,
    })),
  ),
  ...OWNER.map((s) => ({ id: `screen/${s.id}-1512`, title: `${s.title} (1512 × 950)`, notes: s.notes, width: 1512, height: 950, desktop: true, render: () => <Screen config={s.config} /> })),
  ...M2.map((s) => ({ id: `screen/${s.id}-1440`, title: `${s.title} (1440 × 900)`, notes: s.notes, width: 1440, height: 900, desktop: true, render: () => <Screen config={s.config} /> })),
];

/** The M2 screens' ids, for the gallery test. */
export const M2_SCREENS = M2.map((s) => `screen/${s.id}-1440`);
