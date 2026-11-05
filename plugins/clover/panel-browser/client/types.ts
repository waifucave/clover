// The browser panel's props: the chrome around the Clover Browser's live view. The view itself is lane
// L's tab host; this panel draws the tabs, the address bar and the annotate tools, and leaves the frame
// that L's view fills through `panel.view` keyed `browser` (until the runtime places spots, the host
// passes `renderView`).
// Tabs follow lane B's `TabView` (`id`, `url`, `title`, `loading`).
import type { ReactNode } from "react";

export interface BrowserTab {
  id: string;
  title: string;
  url: string;
  loading?: boolean;
}

export type AnnotateTool = "pointer" | "pen" | "box" | "text";

export interface BrowserTabsProps {
  tabs: BrowserTab[];
  active: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew?: () => void;
}

export interface BrowserPanelProps {
  tab: BrowserTab | undefined;
  onBack?: () => void;
  onForward?: () => void;
  onReload?: () => void;
  /** What the user typed in the address bar, on Enter. The browser decides what it opens. */
  onNavigate?: (input: string) => void;
  /** Mark up the page for the bot: point, draw, box or write on it. */
  annotate?: { tool: AnnotateTool | null; onTool: (tool: AnnotateTool | null) => void };
  /** Lane L's live view of the tab. Absent: a placeholder frame says what goes there. */
  renderView?: (tab: BrowserTab) => ReactNode;
}
