// The parts together, roughly as a window will hold them once the shell fills `app.root` (M2): the
// sidebar, a bot's tab with its conversation and composer. The header line is the gallery's own
// stand-in for the `bot.header` spot.
import { useState, type ReactNode } from "react";
import { Composer } from "../../composer/client/Composer";
import type { ComposerProps } from "../../composer/client/types";
import { MODELS } from "../../composer/gallery/stories";
import { ConversationView, type ConversationViewProps } from "../../conversation/client/ConversationView";
import { UiRuntimeProvider } from "../../conversation/client/sdk";
import type { ConversationItem } from "../../conversation/client/types";
import { APPROVAL_PENDING, BASIC, BOT, DEVICE, FORMAT, NOW, SEALED_CARDS, TOOLS, at, bot, thinking, tool } from "../../conversation/gallery/fixtures";
import { mockRuntime } from "../../conversation/gallery/mock-runtime";
import { Sidebar } from "../client/Sidebar";
import type { SidebarProps, SidebarRoute } from "../client/types";
import { APPS, BOTS, SESSIONS } from "./fixtures";
import type { Story } from "./story";

const noop = () => undefined;
const runtime = mockRuntime({ cards: SEALED_CARDS });

function Window({
  sidebar,
  title,
  subtitle,
  conversation,
  composer,
}: {
  sidebar: Partial<SidebarProps> & { start: SidebarRoute };
  title: string;
  subtitle: string;
  conversation: Partial<ConversationViewProps> & { items: readonly ConversationItem[] };
  composer: Partial<ComposerProps> & { initial?: string };
}): ReactNode {
  const [route, setRoute] = useState<SidebarRoute>(sidebar.start);
  const [draft, setDraft] = useState(composer.initial ?? "");
  return (
    <div className="g-window">
      <Sidebar bots={BOTS} sessions={SESSIONS} apps={APPS} onNewBot={noop} onNewSession={noop} {...sidebar} route={route} onNavigate={setRoute} />
      <div className="g-window__main">
        <div className="g-window__header">
          {title}
          <span>{subtitle}</span>
        </div>
        <div className="g-window__conversation">
          <UiRuntimeProvider runtime={runtime}>
            <ConversationView bot={BOT} now={NOW} device={DEVICE} format={FORMAT} onOpenLink={noop} onAnswerQuestion={noop} {...conversation} />
          </UiRuntimeProvider>
        </div>
        <Composer
          botName={conversation.bot?.name ?? BOT.name}
          value={draft}
          onChange={setDraft}
          onSend={() => setDraft("")}
          onAttach={noop}
          onStop={noop}
          model={MODELS}
          voice={{ listening: false, onPressStart: noop, onPressEnd: noop }}
          {...composer}
        />
      </div>
    </div>
  );
}

const AGENT_TAB: ConversationItem[] = [
  {
    kind: "agent-report",
    id: "brief",
    at: at(0, 10, 0),
    from: { kind: "bot", id: "alpha", name: "Alpha" },
    text: "Rebuild the island as a plugin under `plugins/clover/island`, from the Swift reference. Keep the notch geometry; add a top strip for Windows and Linux.",
  },
  thinking(at(0, 10, 1), { title: "Reading the Swift island", durationMs: 9_000 }),
  tool(at(0, 10, 1), { name: "Glob", detail: "apple/Island/**/*.swift", computer: "Studio", output: "14 files" }),
  tool(at(0, 10, 1), { name: "Read", detail: "home/Studio/projects/clover/apple/Island/IslandView.swift", computer: "Studio", output: "struct IslandView: View { … }" }),
  bot(at(0, 10, 3), "The notch geometry comes from the screen's safe area. I'll keep that in a small native add-on and draw everything else in React."),
  tool(at(0, 10, 4), { name: "Write", detail: "home/Studio/projects/clover/plugins/clover/island/client/Island.tsx", computer: "Studio", output: "Wrote 212 lines.", diff: { path: "plugins/clover/island/client/Island.tsx", added: 212, removed: 0, diffId: "i1" } }),
  tool(at(0, 10, 6), { name: "Bash", detail: "bun test plugins/clover/island", computer: "Studio", status: "running" }),
];

export const composedStories: Story[] = [
  {
    id: "composed/alpha-tab",
    title: "Alpha's tab, waiting on an approval",
    notes: "The sidebar, the conversation and the composer together; the header line is a stand-in for bot.header.",
    width: 1280,
    height: 820,
    render: () => (
      <Window
        sidebar={{ start: { kind: "bot", botId: "alpha" } }}
        title="Alpha"
        subtitle="waiting for you"
        conversation={{ items: [...BASIC.slice(2), ...APPROVAL_PENDING], turn: { running: true, phase: "waiting" } }}
        composer={{ running: true }}
      />
    ),
  },
  {
    id: "composed/agent-tab",
    title: "A background agent's live tab",
    notes: "Alpha delegated to Claude Code on Studio; the user watches it work and can type to it or stop it.",
    width: 1280,
    height: 820,
    render: () => (
      <Window
        sidebar={{ start: { kind: "agent", agentId: "agent-island" } }}
        title="Rebuild the island as a plugin"
        subtitle="Claude Code on Studio, for Alpha"
        conversation={{ bot: { id: "agent-island", name: "Claude Code" }, items: AGENT_TAB, turn: { running: true, phase: "working" } }}
        composer={{ botName: "Claude Code", running: true, initial: "Use 40 px for the strip on Windows.", model: undefined, voice: undefined }}
      />
    ),
  },
  {
    id: "composed/asleep",
    title: "The main computer can't be reached",
    notes: "The sidebar says so, the bots sleep, and the composer keeps the draft until Studio is back.",
    width: 1280,
    height: 720,
    render: () => (
      <Window
        sidebar={{
          start: { kind: "bot", botId: "alpha" },
          bots: BOTS.map((b) => ({ ...b, status: "asleep", needsYou: undefined, activity: undefined, agents: undefined })),
          sessions: [],
          link: { state: "unreachable", main: "Studio" },
        }}
        title="Alpha"
        subtitle="asleep"
        conversation={{ items: [...BASIC, ...TOOLS.slice(0, 2)] }}
        composer={{ initial: "When you're back, check the deploy logs.", asleep: { reason: "Studio can't be reached" } }}
      />
    ),
  },
];
