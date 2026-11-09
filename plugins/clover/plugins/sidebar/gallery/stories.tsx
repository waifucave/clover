// Every sidebar state the gallery shows.
import { useState, type ReactNode } from "react";
import { CloverMark } from "../client/icons";
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
      onPlugins={noop}
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

/** The solid colour the window frame paints behind a sidebar where there's no material. */
const Framed = ({ children }: { children: ReactNode }) => <div className="story-sidebar">{children}</div>;

export const stories: Story[] = [
  {
    id: "sidebar/bots",
    title: "The bots side",
    notes: "The switch, New, Search, Outputs, Plugins and More; each bot with what it's doing and what needs you; Alpha's background agents as live tabs, each state before its title, Close on the finished one.",
    width: 247,
    height: TALL,
    render: () => <Framed><SidebarDemo /></Framed>,
  },
  {
    id: "sidebar/code",
    title: "The code side",
    notes: "Sessions by project folder, each with its branch and changed files; a project folds; + starts a session in it; an empty project says so.",
    width: 247,
    height: TALL,
    render: () => <Framed><SidebarDemo side="code" start={{ kind: "agent", agentId: "session-panels" }} initialFoldedProjects={[]} /></Framed>,
  },
  {
    id: "sidebar/banners",
    title: "Safe mode, paused, and the main computer unreachable",
    width: 247,
    height: TALL,
    render: () => <Framed><SidebarDemo safeMode paused onResume={noop} onOpenPluginManager={noop} link={{ state: "unreachable", main: "Studio" }} /></Framed>,
  },
  {
    id: "sidebar/takeover",
    title: "This computer runs the bots while the main one is off",
    width: 247,
    height: TALL,
    render: () => <Framed><SidebarDemo link={{ state: "takeover", main: "Studio", here: "Laptop" }} apps={APPS} /></Framed>,
  },
  {
    id: "sidebar/collapsed",
    title: "The rail",
    notes: "Collapsed, every row keeps its accessible name; banners stay as marks; the code side keeps its projects. It stays 80 px wide, the room the window's controls take.",
    width: 80,
    height: TALL,
    render: () => <Framed><SidebarDemo collapsed paused onResume={noop} link={{ state: "offline" }} /></Framed>,
  },
  {
    id: "sidebar/collapsed-code",
    title: "The rail, code side",
    width: 80,
    height: TALL,
    render: () => <Framed><SidebarDemo collapsed side="code" /></Framed>,
  },
  {
    id: "sidebar/brand-mark",
    title: "Clover's mark",
    notes: "The brand mark (docs/clover-brand.md) at the sidebar's 16 px and larger, on the sidebar's ground and on the card's: green on the light theme, white on the dark one.",
    width: 520,
    height: 220,
    render: () => (
      <div className="story-marks">
        {(["story-marks__row", "story-marks__row story-marks__row--card"] as const).map((row) => (
          <div key={row} className={row}>
            {[16, 24, 48, 96].map((size) => (
              <span key={size} className="cl-sidebar__brand story-marks__cell">
                <CloverMark size={size} />
              </span>
            ))}
          </div>
        ))}
      </div>
    ),
  },
];
