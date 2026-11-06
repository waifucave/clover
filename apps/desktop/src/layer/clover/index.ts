// The `clover` layer's bundle (served as `/_clover/clover.js` in the `clover` layer only): one client module per child
// plugin of `clover`, by plugin id, as each child's client entry exports it (lane F's, G's and L's parts are entries of
// the UI API's shape). Everything we ship under `clover` shares this one layer (spec §5.5). The shell is wrapped for
// the app's commands (bindings.tsx).
import * as b from "./bindings";
import * as archive from "@clover-child/archive";
import * as botEditor from "@clover-child/bot-editor";
import * as browserView from "@clover-child/browser-view";
import * as composer from "@clover-child/composer";
import * as conversation from "@clover-child/conversation";
import * as island from "@clover-child/island";
import * as panel from "@clover-child/panel";
import * as panelDiff from "@clover-child/panel-diff";
import * as panelFiles from "@clover-child/panel-files";
import * as panelTerminal from "@clover-child/panel-terminal";
import * as pill from "@clover-child/pill";
import * as pluginIndex from "@clover-child/plugin-index";
import * as settings from "@clover-child/settings";
import * as shell from "@clover-child/shell";
import * as sidebar from "@clover-child/sidebar";
import * as vrm from "@clover-child/vrm";
import type { CloverChildId } from "./ids";

export const modules: Record<CloverChildId, Record<string, unknown>> = {
  "clover/shell": { ...shell, Shell: b.Shell },
  "clover/sidebar": sidebar,
  "clover/conversation": conversation,
  "clover/composer": composer,
  "clover/panel": panel,
  "clover/panel-diff": panelDiff,
  "clover/panel-files": panelFiles,
  "clover/panel-terminal": panelTerminal,
  "clover/settings": settings,
  "clover/browser-view": browserView,
  "clover/archive": archive,
  "clover/bot-editor": botEditor,
  "clover/plugin-index": pluginIndex,
  "clover/island": island,
  "clover/pill": pill,
  "clover/vrm": vrm,
};
