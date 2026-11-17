// The `moss` layer's bundle (served as `/_moss/moss.js` in the `moss` layer only): one client module per child
// plugin of `moss`, by plugin id, as each child's client entry exports it (lane F's, G's and L's parts are entries of
// the UI API's shape). Everything we ship under `moss` shares this one layer (spec §5.5). Each is bound as it is: the
// shell's own `Shell` hears the app's commands itself.
import * as archive from "@waifucave/moss-plugin-archive/client";
import * as character from "@waifucave/moss-plugin-character/client";
import * as browserView from "@waifucave/moss-plugin-browser-view/client";
import * as composer from "@waifucave/moss-plugin-composer/client";
import * as conversation from "@waifucave/moss-plugin-conversation/client";
import * as island from "@waifucave/moss-plugin-island/client";
import * as live2d from "@waifucave/moss-plugin-live2d/client";
import * as panel from "@waifucave/moss-plugin-panel/client";
import * as panelDiff from "@waifucave/moss-plugin-panel-diff/client";
import * as panelFiles from "@waifucave/moss-plugin-panel-files/client";
import * as panelTerminal from "@waifucave/moss-plugin-panel-terminal/client";
import * as pill from "@waifucave/moss-plugin-pill/client";
import * as pluginIndex from "@waifucave/moss-plugin-plugin-index/client";
import * as settings from "@waifucave/moss-plugin-settings/client";
import * as shell from "@waifucave/moss-plugin-shell/client";
import * as sidebar from "@waifucave/moss-plugin-sidebar/client";
import * as usage from "@waifucave/moss-plugin-usage/client";
import * as voice from "@waifucave/moss-plugin-voice/client";
import * as devices from "@waifucave/moss-plugin-devices/client";
import * as vrm from "@waifucave/moss-plugin-vrm/client";
import type { MossChildId } from "./ids";

export const modules: Record<MossChildId, Record<string, unknown>> = {
  "moss/shell": shell,
  "moss/character": character,
  "moss/sidebar": sidebar,
  "moss/conversation": conversation,
  "moss/composer": composer,
  "moss/panel": panel,
  "moss/panel-diff": panelDiff,
  "moss/panel-files": panelFiles,
  "moss/panel-terminal": panelTerminal,
  "moss/settings": settings,
  "moss/browser-view": browserView,
  "moss/archive": archive,
  "moss/plugin-index": pluginIndex,
  "moss/island": island,
  "moss/pill": pill,
  "moss/usage": usage,
  // MOSS Voice's parts: its player (a background part), Settings › Voice, a bot's editor section and the stage's chip.
  "moss/voice": voice,
  "moss/devices": devices,
  "moss/vrm": vrm,
  "moss/live2d": live2d,
};
