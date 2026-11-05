// Every terminal panel state the gallery shows.
import { TerminalPanel, TerminalTabs } from "../client/TerminalPanel";
import { FEED, TABS } from "./fixtures";
import type { Story } from "./story";

const noop = () => undefined;

export const terminalStories: Story[] = [
  {
    id: "panel-terminal/running",
    title: "A terminal over a PTY feed",
    notes: "The feed is mocked: styled runs of output, the prompt, the cursor. The tabs (one per terminal, and + for a new one) sit in the panel's header; F6 leaves the terminal.",
    width: 640,
    height: 380,
    render: () => (
      <div className="story-term">
        <div className="story-term__head">
          <TerminalTabs tabs={TABS} active="t1" onSelect={noop} onNew={noop} onClose={noop} />
        </div>
        <TerminalPanel tabs={TABS} active="t1" chunks={FEED} onInput={noop} onPaste={noop} />
      </div>
    ),
  },
  {
    id: "panel-terminal/exited",
    title: "A terminal whose process ended",
    width: 640,
    height: 200,
    render: () => <TerminalPanel tabs={TABS} active="t2" chunks={[{ text: "$ bun dev\nListening on 127.0.0.1:4173\n^C\n" }]} />,
  },
];
