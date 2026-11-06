// Every panel state the gallery shows.
import { SessionView } from "../client/SessionView";
import { BOT_COLUMN, SESSION } from "./fixtures";
import type { Story } from "./story";

export const panelStories: Story[] = [
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
    render: () => <SessionView environment={SESSION.environment} />,
  },
  {
    id: "panel/bot-column",
    title: "A bot's slim column",
    notes: "Its coding agents and tasks (the open one marked), its context and its outputs. No folder, changes, files or terminal.",
    width: 293,
    render: () => <SessionView {...BOT_COLUMN} openAgent="agent-export" />,
  },
];
