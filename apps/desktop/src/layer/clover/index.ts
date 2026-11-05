// The `clover` layer's bundle (served as `/_clover/clover.js` in the `clover` layer only): one client module per child
// plugin of `clover`, by plugin id, each mapping its `ui` entries' component names to components. Everything we ship
// under `clover` shares this one layer (spec §5.5).
import * as b from "./bindings";
// Lane L's browser panel is already a component of the UI API's shape (EntryProps): its module, as it is.
import * as browserView from "@clover-child/browser-view";
import type { CloverChildId } from "./ids";

export const modules: Record<CloverChildId, Record<string, unknown>> = {
  "clover/shell": { Window: b.Window, BotTab: b.BotTab },
  "clover/sidebar": { Sidebar: b.Sidebar },
  "clover/conversation": { ConversationView: b.Conversation },
  "clover/composer": { Composer: b.Composer },
  "clover/panel": { SessionView: b.SessionView },
  "clover/panel-diff": { DiffPanel: b.DiffPanel },
  "clover/panel-files": { FilesPanel: b.FilesPanel },
  "clover/panel-terminal": { TerminalPanel: b.TerminalPanel },
  "clover/settings": { SettingsModal: b.SettingsModal },
  "clover/browser-view": browserView,
};
