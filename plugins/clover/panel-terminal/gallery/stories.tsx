// Every terminal panel state the gallery shows.
import { TerminalPanel } from "../client/TerminalPanel";
import { FEED, TABS } from "./fixtures";
import type { Story } from "./story";

const noop = () => undefined;

export const terminalStories: Story[] = [
  {
    id: "panel-terminal/running",
    title: "A terminal over a PTY feed",
    notes: "The feed is mocked: styled runs of output, the prompt, the cursor. Tabs for each terminal, and + for a new one.",
    width: 640,
    height: 380,
    render: () => <TerminalPanel tabs={TABS} active="t1" chunks={FEED} onInput={noop} onSelect={noop} onNew={noop} onClose={noop} />,
  },
  {
    id: "panel-terminal/exited",
    title: "A terminal whose process ended",
    width: 640,
    height: 200,
    render: () => <TerminalPanel tabs={TABS} active="t2" chunks={[{ text: "$ bun dev\nListening on 127.0.0.1:4173\n^C\n" }]} onSelect={noop} />,
  },
];
