// Every sidebar state the gallery shows.
import { useState } from "react";
import { Sidebar } from "../client/Sidebar";
import type { SidebarProps, SidebarRoute } from "../client/types";
import { APPS, BOTS, BUNDLED_APPS, SESSIONS } from "./fixtures";
import type { Story } from "./story";

const noop = () => undefined;

/** A sidebar that follows its own clicks, so the gallery page can be clicked through. */
function Demo(props: Partial<SidebarProps> & { start?: SidebarRoute }) {
  const [route, setRoute] = useState<SidebarRoute>(props.start ?? { kind: "bot", botId: "alpha" });
  const [collapsed, setCollapsed] = useState(props.collapsed ?? false);
  return (
    <Sidebar
      bots={BOTS}
      sessions={SESSIONS}
      apps={APPS}
      onNewBot={noop}
      onNewSession={noop}
      onCloseAgent={noop}
      {...props}
      route={route}
      onNavigate={setRoute}
      collapsed={collapsed}
      onToggleCollapsed={() => setCollapsed((c) => !c)}
    />
  );
}

const W = 264;

export const stories: Story[] = [
  {
    id: "sidebar/default",
    title: "Bots, their agents, coding sessions and apps",
    notes: "Alpha is working with four background agents as live tabs; Luna needs you twice; Juniper runs a routine; Mira has news.",
    width: W,
    render: () => <Demo />,
  },
  {
    id: "sidebar/agent-open",
    title: "An agent's live tab open",
    width: W,
    render: () => <Demo start={{ kind: "agent", agentId: "agent-lint" }} />,
  },
  {
    id: "sidebar/first-run",
    title: "First run: only Alpha",
    width: W,
    render: () => <Demo bots={[{ id: "alpha", name: "Alpha", status: "idle" }]} sessions={[]} apps={BUNDLED_APPS} />,
  },
  {
    id: "sidebar/unreachable",
    title: "The main computer can't be reached",
    notes: "The app says so instead of taking over; the bots are asleep and wait for it.",
    width: W,
    render: () => (
      <Demo
        bots={BOTS.map((b) => ({ ...b, status: "asleep", needsYou: undefined, activity: undefined, agents: undefined }))}
        sessions={[]}
        link={{ state: "unreachable", main: "Studio" }}
      />
    ),
  },
  {
    id: "sidebar/takeover",
    title: "This computer runs the bots while the main is offline",
    width: W,
    render: () => <Demo sessions={[]} link={{ state: "takeover", main: "Studio", here: "Laptop" }} />,
  },
  {
    id: "sidebar/offline",
    title: "Offline",
    width: W,
    render: () => <Demo bots={BOTS.slice(0, 2).map((b) => ({ ...b, agents: undefined }))} sessions={[]} link={{ state: "offline" }} />,
  },
  {
    id: "sidebar/paused",
    title: "Every bot and routine paused",
    width: W,
    render: () => (
      <Demo
        bots={BOTS.map((b) => ({ ...b, status: "paused", needsYou: undefined, activity: undefined, agents: undefined }))}
        sessions={[]}
        paused
        onResume={noop}
      />
    ),
  },
  {
    id: "sidebar/safe-mode",
    title: "Safe mode",
    notes: "Only Clover's own plugins run, so the third-party app is gone.",
    width: W,
    render: () => <Demo bots={BOTS.slice(0, 1).map((b) => ({ ...b, status: "idle", agents: undefined }))} sessions={[]} apps={BUNDLED_APPS} safeMode onOpenPluginManager={noop} />,
  },
  {
    id: "sidebar/collapsed",
    title: "Collapsed to a rail",
    width: 64,
    render: () => <Demo collapsed />,
  },
  {
    id: "sidebar/settings-open",
    title: "Settings open",
    width: W,
    render: () => <Demo start={{ kind: "settings" }} />,
  },
  {
    id: "sidebar/replaced-bot-row",
    title: "A plugin dressing the bot rows",
    notes: "sidebar.bot in use: a plugin draws each bot's row with a mood line.",
    width: W,
    render: () => (
      <Demo
        sessions={[]}
        bots={BOTS.slice(1, 4)}
        start={{ kind: "bot", botId: "luna" }}
        renderBot={(bot, standard) => (
          <div className="story-mood">
            {standard}
            <div className="story-mood__line">{bot.name === "Luna" ? "☾ feeling mysterious" : "☀ in a good mood"}</div>
          </div>
        )}
      />
    ),
  },
];
