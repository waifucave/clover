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
    id: "panel/empty",
    title: "A panel no plugin fills yet",
    notes: "The host's own placeholder: the browser panel's plugin (lane L's) isn't in this build.",
    width: 640,
    height: 360,
    render: () => <PanelHost views={[{ id: "browser", title: "Browser" }]} onClose={() => undefined} onFindPlugin={() => undefined} />,
  },
  {
    id: "panel/session-level-asked",
    title: "A level change asked for",
    notes: "The pill's pick is a request: the old level stands, with the asked-for one beside it, until the sealed card is answered.",
    width: 340,
    render: () => <SessionView environment={{ ...SESSION.environment!, level: { label: "Ask before risky", requested: "Automatic" } }} />,
  },
  {
    id: "panel/session",
    title: "The session column",
    notes: "Agents and tasks, where it runs (the computer and its level, the folders, the branch), context use, connectors, outputs, and changes with the create-PR button and the PRs.",
    width: 293,
    render: () => <SessionView {...SESSION} />,
  },
  {
    id: "panel/session-minimal",
    title: "A session with only its environment",
    notes: "Every part of the column is optional; a session that made nothing shows only where it runs.",
    width: 340,
    render: () => <SessionView environment={{ ...SESSION.environment!, onSave: undefined }} />,
  },
];
