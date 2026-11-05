// Every panel state the gallery shows.
import { useState } from "react";
import { PanelHost } from "../client/PanelHost";
import { PanelToggles, toggleView } from "../client/PanelToggles";
import { SessionView } from "../client/SessionView";
import { SESSION } from "./fixtures";
import type { Story } from "./story";

function Toggles({ initial }: { initial: string[] }) {
  const [open, setOpen] = useState(initial);
  return <PanelToggles open={open} onToggle={(id) => setOpen((o) => toggleView(o, id))} onMore={() => undefined} />;
}

function Placeholder({ label }: { label: string }) {
  return <div className="story-panel-placeholder">{label}</div>;
}

export const panelStories: Story[] = [
  {
    id: "panel/toggles",
    title: "The panel toggles",
    notes: "Session column, terminal, changes, browser, files, and more. The terminal and the changes are open.",
    width: 320,
    render: () => <Toggles initial={["terminal", "diff"]} />,
  },
  {
    id: "panel/host-two",
    title: "Two views at once",
    notes: "One above the other, each with its header, expand and close. Each panel fills the panel spot, keyed by its id.",
    width: 640,
    height: 520,
    render: () => (
      <PanelHost
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
    id: "panel/session",
    title: "The session column",
    notes: "Agents and tasks, the environment with the phone switch, context use, connectors, outputs, and changes with the create-PR button and the PRs.",
    width: 340,
    render: () => <SessionView {...SESSION} />,
  },
  {
    id: "panel/session-minimal",
    title: "A session with only its environment",
    notes: "Every part of the column is optional; a session that made nothing shows only where it runs.",
    width: 340,
    render: () => <SessionView environment={{ ...SESSION.environment!, remote: undefined, onSave: undefined }} />,
  },
];
