// Every browser panel state the gallery shows.
import { useState } from "react";
import { BrowserPanel, BrowserTabs } from "../client/BrowserPanel";
import type { AnnotateTool } from "../client/types";
import { TABS } from "./fixtures";
import type { Story } from "./story";

const noop = () => undefined;

function Demo({ tool: initial = null }: { tool?: AnnotateTool | null }) {
  const [active, setActive] = useState("b1");
  const [tool, setTool] = useState<AnnotateTool | null>(initial);
  return (
    <div className="story-browser">
      <div className="story-browser__head">
        <BrowserTabs tabs={TABS} active={active} onSelect={setActive} onClose={noop} onNew={noop} />
      </div>
      <BrowserPanel tab={TABS.find((t) => t.id === active)} onBack={noop} onReload={noop} onNavigate={noop} annotate={{ tool, onTool: setTool }} />
    </div>
  );
}

export const browserStories: Story[] = [
  {
    id: "panel-browser/tabs",
    title: "The browser's chrome around the live page",
    notes: "Tabs, back, forward, reload, the address bar, and the annotate tools. The dashed frame is where lane L's live view goes.",
    width: 720,
    height: 480,
    render: () => <Demo />,
  },
  {
    id: "panel-browser/annotating",
    title: "Marking up the page",
    notes: "The box tool is on: the user draws on the page for the bot.",
    width: 720,
    height: 480,
    render: () => <Demo tool="box" />,
  },
];
