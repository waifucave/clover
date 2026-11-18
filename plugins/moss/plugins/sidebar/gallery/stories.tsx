// Every sidebar state the gallery shows.
import { useState, type ReactNode } from "react";
import { MossMark } from "../client/icons";
import { Sidebar } from "../client/Sidebar";
import type { SidebarProps, SidebarRoute } from "../client/types";
import { ACCOUNT, APPS, BUNDLED_APPS, PROJECTS } from "./fixtures";
import type { Story } from "./story";

const noop = () => undefined;

/** A sidebar holding its own route, so the gallery page can be clicked through. */
export function SidebarDemo(props: Partial<SidebarProps> & { start?: SidebarRoute }) {
  const [route, setRoute] = useState<SidebarRoute>(props.start ?? { kind: "agent", agentId: "session-panels" });
  return (
    <Sidebar
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
    id: "sidebar/code",
    title: "The code sessions",
    notes: "Sessions by project folder, each with its branch and changed files; a project folds; + starts a session in it; an empty project says so.",
    width: 247,
    height: TALL,
    render: () => <Framed><SidebarDemo start={{ kind: "agent", agentId: "session-panels" }} initialFoldedProjects={[]} /></Framed>,
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
    notes: "Collapsed, every row keeps its accessible name; banners stay as marks; the projects stay. It stays 80 px wide, the room the window's controls take.",
    width: 80,
    height: TALL,
    render: () => <Framed><SidebarDemo collapsed paused onResume={noop} link={{ state: "offline" }} /></Framed>,
  },
  {
    id: "sidebar/brand-mark",
    title: "MOSS's mark",
    notes: "The brand mark (docs/moss-brand.md) at the sidebar's 16 px and larger, on the sidebar's ground and on the card's: Night on the light theme, Paper on the dark one.",
    width: 520,
    height: 220,
    render: () => (
      <div className="story-marks">
        {(["story-marks__row", "story-marks__row story-marks__row--card"] as const).map((row) => (
          <div key={row} className={row}>
            {[16, 24, 48, 96].map((size) => (
              <span key={size} className="cl-sidebar__brand story-marks__cell">
                <MossMark size={size} />
              </span>
            ))}
          </div>
        ))}
      </div>
    ),
  },
];
