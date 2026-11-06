// The shell's own parts in the gallery: the panel host and its toggles. (The whole-window screens are screens.tsx.)
import { useState } from "react";
import { PanelHost } from "../client/PanelHost";
import { PanelToggles, toggleView } from "../client/PanelToggles";
import type { SessionKind } from "../client/panel-types";
import type { Story } from "./story";

function Toggles({ kind, initial }: { kind: SessionKind; initial: string[] }) {
  const [open, setOpen] = useState(initial);
  return <PanelToggles kind={kind} open={open} onToggle={(id) => setOpen((o) => toggleView(o, id))} onMore={() => undefined} />;
}

function Placeholder({ label }: { label: string }) {
  return <div className="story-panel-placeholder">{label}</div>;
}

export const shellStories: Story[] = [
  {
    id: "shell/toggles",
    title: "The panel toggles in a coding session",
    notes: "Session column, terminal, changes, browser, files, and more. The terminal and the changes are open.",
    width: 320,
    render: () => <Toggles kind="coding" initial={["terminal", "diff"]} />,
  },
  {
    id: "shell/toggles-bot",
    title: "The panel toggles in a bot's tab",
    notes: "Its slim column and the browser only: the terminal, changes and files belong to coding sessions.",
    width: 320,
    render: () => <Toggles kind="bot" initial={["session"]} />,
  },
  {
    id: "shell/host-two",
    title: "Two views at once",
    notes: "One above the other, each with its header, expand and close. Each panel fills the panel spot, keyed by its id.",
    width: 640,
    height: 520,
    render: () => (
      <PanelHost
        kind="coding"
        views={[
          { id: "diff", title: "Changes", content: <Placeholder label="The changes view (panel-diff)" /> },
          { id: "terminal", title: "Terminal", content: <Placeholder label="The terminal (panel-terminal)" /> },
        ]}
        onClose={() => undefined}
        onExpand={() => undefined}
      />
    ),
  },
  {
    id: "shell/empty",
    title: "A panel no plugin fills yet",
    notes: "The host's own placeholder: the browser panel's plugin (lane L's) isn't in this build.",
    width: 640,
    height: 360,
    render: () => <PanelHost kind="coding" views={[{ id: "browser", title: "Browser" }]} onClose={() => undefined} onFindPlugin={() => undefined} />,
  },
];
