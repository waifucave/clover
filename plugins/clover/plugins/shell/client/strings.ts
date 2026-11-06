// Every string the window frame shows, in one place.
import en from "../locales/en.json" with { type: "json" };
import { translator } from "../../shell/runtime/strings";

/** This part's words: `clover.shell.` keys, English in `locales/en.json`, the user's language through the app's tables. */
const t = translator(en.strings);

export const S = {
  sessionMenu: (title: string) => t("clover.shell.sessionMenu", { title }),
  get panelToggles() {
    return t("clover.shell.panelToggles");
  },
  get statusBar() {
    return t("clover.shell.statusBar");
  },
  get dialogHeld() {
    return t("clover.shell.dialogHeld");
  },
  // The panel host and its toggles.
  views: {
    get session() {
      return t("clover.shell.views.session");
    },
    get terminal() {
      return t("clover.shell.views.terminal");
    },
    get diff() {
      return t("clover.shell.views.diff");
    },
    get browser() {
      return t("clover.shell.views.browser");
    },
    get files() {
      return t("clover.shell.views.files");
    },
    get agent() {
      return t("clover.shell.views.agent");
    },
  } as Record<string, string>,
  /** A bot's tab's slim column. */
  get botColumn() {
    return t("clover.shell.botColumn");
  },
  toggle: (label: string, open: boolean) => t(open ? "clover.shell.hide" : "clover.shell.show", { label }),
  get more() {
    return t("clover.shell.more");
  },
  close: (title: string) => t("clover.shell.close", { title }),
  expand: (title: string) => t("clover.shell.expand", { title }),
  get panel() {
    return t("clover.shell.panel");
  },
  empty: (title: string) => t("clover.shell.empty", { title: title.toLocaleLowerCase() }),
  get emptyDetail() {
    return t("clover.shell.emptyDetail");
  },
  get findPlugin() {
    return t("clover.shell.findPlugin");
  },
  // The shell's own pages.
  editBot: (name: string) => t("clover.shell.editBot", { name }),
  get settings() {
    return t("clover.shell.settings");
  },
  get plugins() {
    return t("clover.shell.plugins");
  },
  get nothingHere() {
    return t("clover.shell.nothingHere");
  },
  get nothingHereDetail() {
    return t("clover.shell.nothingHereDetail");
  },
  get loading() {
    return t("clover.shell.loading");
  },
  // An agent's live tab.
  agentStatus: {
    get starting() {
      return t("clover.shell.agentStatus.starting");
    },
    get ready() {
      return t("clover.shell.agentStatus.ready");
    },
    get prompting() {
      return t("clover.shell.agentStatus.prompting");
    },
    get cancelling() {
      return t("clover.shell.agentStatus.cancelling");
    },
    get idle() {
      return t("clover.shell.agentStatus.idle");
    },
    get stopped() {
      return t("clover.shell.agentStatus.stopped");
    },
    get failed() {
      return t("clover.shell.agentStatus.failed");
    },
  } as Record<string, string>,
  get interrupt() {
    return t("clover.shell.interrupt");
  },
  get stop() {
    return t("clover.shell.stop");
  },
  agentOn: (backend: string, computer: string) => t("clover.shell.agentOn", { backend, computer }),
};
