// Every sidebar state the gallery shows.
import { useState } from "react";
import { Sidebar } from "../client/Sidebar";
import type { SidebarProps, SidebarRoute, SidebarSide } from "../client/types";
import { ACCOUNT, APPS, BOTS, BUNDLED_APPS, PROJECTS } from "./fixtures";
import type { Story } from "./story";

const noop = () => undefined;

/** A sidebar holding its own side and route, so the gallery page can be clicked through. */
export function SidebarDemo(props: Partial<SidebarProps> & { start?: SidebarRoute }) {
  const [side, setSide] = useState<SidebarSide>(props.side ?? "bots");
  const [route, setRoute] = useState<SidebarRoute>(props.start ?? { kind: "bot", botId: "alpha" });
  return (
    <Sidebar
      bots={BOTS}
      projects={PROJECTS}
      apps={BUNDLED_APPS}
      account={ACCOUNT}
      onNew={noop}
      onSearch={noop}
      onOutputs={noop}
      onCustomize={noop}
      onMore={noop}
      onNewSession={noop}
      onCloseAgent={noop}
      onOpenSettings={noop}
      onToggleCollapsed={noop}
      {...props}
      side={side}
      onSideChange={setSide}
      route={route}
      onNavigate={setRoute}
    />
  );
}

const TALL = 760;

export const stories: Story[] = [
  {
    id: "sidebar/bots",
    title: "The bots side",
    notes: "The switch, New, Search, Outputs, Customize and More; each bot with what it's doing and what needs you; Alpha's background agents as live tabs, each state before its title, Close on the finished one.",
    width: 264,
    height: TALL,
    render: () => <SidebarDemo />,
  },
  {
    id: "sidebar/code",
    title: "The code side",
    notes: "Sessions by project folder, each with its branch and changed files; a project folds; + starts a session in it; an empty project says so.",
    width: 264,
    height: TALL,
    render: () => <SidebarDemo side="code" start={{ kind: "agent", agentId: "session-panels" }} initialFoldedProjects={[]} />,
  },
  {
    id: "sidebar/banners",
    title: "Safe mode, paused, and the main computer unreachable",
    width: 264,
    height: TALL,
    render: () => <SidebarDemo safeMode paused onResume={noop} onOpenPluginManager={noop} link={{ state: "unreachable", main: "Studio" }} />,
  },
  {
    id: "sidebar/takeover",
    title: "This computer runs the bots while the main one is off",
    width: 264,
    height: TALL,
    render: () => <SidebarDemo link={{ state: "takeover", main: "Studio", here: "Laptop" }} apps={APPS} />,
  },
  {
    id: "sidebar/collapsed",
    title: "The rail",
    notes: "Collapsed, every row keeps its accessible name; banners stay as marks; the code side keeps its projects.",
    width: 56,
    height: TALL,
    render: () => <SidebarDemo collapsed paused onResume={noop} link={{ state: "offline" }} />,
  },
  {
    id: "sidebar/collapsed-code",
    title: "The rail, code side",
    width: 56,
    height: TALL,
    render: () => <SidebarDemo collapsed side="code" />,
  },
];
