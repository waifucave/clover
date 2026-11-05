// Every browser panel state the gallery shows. The container stories run the real panel over a stand-in browser API
// (`fake-api.ts`) that never draws a live view, so the frame shows its placeholder: the dashed box is where the
// browser's live view goes.
import { useState } from "react";
import { BrowserChrome } from "../client/BrowserChrome";
import { BrowserPanel } from "../client/BrowserPanel";
import { PluginApiProvider } from "../client/sdk";
import type { AnnotateTool, TabView } from "../client/types";
import { fakeBrowser } from "./fake-api";
import { TAB_VIEWS, TABS, tabView } from "./fixtures";
import type { Story } from "./story";

const noop = () => undefined;

/** The real panel, over a browser holding `tabs`. */
function Panel({ tabs }: { tabs: TabView[] }) {
  const [api] = useState(() => fakeBrowser(tabs, { shows: false }));
  return (
    <div className="story-browser">
      <PluginApiProvider api={{ browser: api }}>
        <BrowserPanel props={{ app: "browser", bot: "alpha" }} />
      </PluginApiProvider>
    </div>
  );
}

/** The chrome alone, with the annotate strip the panel does not mount yet (the API has no way to send marks). */
function Annotating({ tool: initial = null }: { tool?: AnnotateTool | null }) {
  const [tool, setTool] = useState<AnnotateTool | null>(initial);
  return (
    <div className="story-browser cl-browser-panel">
      <BrowserChrome tab={TABS[0]} onBack={noop} onReload={noop} onNavigate={noop} annotate={{ tool, onTool: setTool }} />
    </div>
  );
}

export const browserStories: Story[] = [
  {
    id: "browser-view/tabs",
    title: "The browser's chrome around the live page",
    notes: "The tab row, back, forward, reload and the address bar. The dashed frame is where the browser's live view goes.",
    width: 720,
    height: 480,
    render: () => <Panel tabs={TAB_VIEWS} />,
  },
  {
    id: "browser-view/loading-held",
    title: "A page loading, and a tab the user holds",
    notes: "The first tab's globe turns while its page loads; the second shows a hand because the user holds it in the view.",
    width: 720,
    height: 360,
    render: () => (
      <Panel
        tabs={[
          tabView("b1", { title: "Docs preview", url: "http://localhost:4321/docs/", loading: true }),
          tabView("b2", { title: "Plugin index", url: "https://plugins.clover.dev/", heldByUser: true }),
        ]}
      />
    ),
  },
  {
    id: "browser-view/no-tab",
    title: "No tab open",
    notes: "A bot's browser with no page yet: the placeholder says so, and + opens one.",
    width: 720,
    height: 360,
    render: () => <Panel tabs={[]} />,
  },
  {
    id: "browser-view/refused",
    title: "An address the browser refused",
    notes: "The reason, in plain words, on a line attached to the bar. The address stays so a typo can be fixed.",
    width: 720,
    height: 360,
    render: () => (
      <div className="story-browser cl-browser-panel">
        <BrowserChrome tab={TABS[0]} onBack={noop} onReload={noop} onNavigate={noop} error="Couldn't open that address. Pages from files on this computer aren't allowed." />
      </div>
    ),
  },
  {
    id: "browser-view/annotating",
    title: "Marking up the page",
    notes: "The box tool is on: the user draws on the page for the bot. The strip sits below the page, never over it. The panel does not mount it until the browser API can send marks.",
    width: 720,
    height: 480,
    render: () => <Annotating tool="box" />,
  },
];
