// The `clover` layer's bundle (served as `/_clover/clover.js` in the `clover` layer only): one client module per child
// plugin of `clover`, by plugin id, as each child's client entry exports it (lane F's, G's and L's parts are entries of
// the UI API's shape). Everything we ship under `clover` shares this one layer (spec §5.5). Each is bound as it is: the
// shell's own `Shell` hears the app's commands itself.
import * as archive from "@waifucave/clover-plugin-archive/client";
import * as botEditor from "@waifucave/clover-plugin-bot-editor/client";
import * as character from "@waifucave/clover-plugin-character/client";
import * as browserView from "@waifucave/clover-plugin-browser-view/client";
import * as composer from "@waifucave/clover-plugin-composer/client";
import * as conversation from "@waifucave/clover-plugin-conversation/client";
import * as island from "@waifucave/clover-plugin-island/client";
import * as live2d from "@waifucave/clover-plugin-live2d/client";
import * as panel from "@waifucave/clover-plugin-panel/client";
import * as panelDiff from "@waifucave/clover-plugin-panel-diff/client";
import * as panelFiles from "@waifucave/clover-plugin-panel-files/client";
import * as panelTerminal from "@waifucave/clover-plugin-panel-terminal/client";
import * as pill from "@waifucave/clover-plugin-pill/client";
import * as pluginIndex from "@waifucave/clover-plugin-plugin-index/client";
import * as settings from "@waifucave/clover-plugin-settings/client";
import * as shell from "@waifucave/clover-plugin-shell/client";
import * as sidebar from "@waifucave/clover-plugin-sidebar/client";
import * as usage from "@waifucave/clover-plugin-usage/client";
import * as voice from "@waifucave/clover-plugin-voice/client";
import * as devices from "@waifucave/clover-plugin-devices/client";
import * as vrm from "@waifucave/clover-plugin-vrm/client";
import type { CloverChildId } from "./ids";

export const modules: Record<CloverChildId, Record<string, unknown>> = {
  "clover/shell": shell,
  "clover/character": character,
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
  "clover/usage": usage,
  // Clover Voice's parts: its player (a background part), Settings › Voice, a bot's editor section and the stage's chip.
  "clover/voice": voice,
  "clover/devices": devices,
  "clover/vrm": vrm,
  "clover/live2d": live2d,
};
