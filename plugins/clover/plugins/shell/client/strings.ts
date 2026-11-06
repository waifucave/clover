// Every string the window frame shows, in one place.
import en from "../locales/en.json" with { type: "json" };
import { translator } from "../../shell/runtime/strings";

/** This part's words: `clover.shell.` keys, English in `locales/en.json`, the user's language through the app's tables. */
const t = translator(en.strings);

export const S = {
  get output() {
    return t("clover.shell.output");
  },
  get paletteBot() {
    return t("clover.shell.paletteBot");
  },
  get paletteSession() {
    return t("clover.shell.paletteSession");
  },
  get noCore() {
    return t("clover.shell.noCore");
  },
  // The command palette.
  get paletteKeyTaken() {
    return t("clover.shell.paletteKeyTaken");
  },
  get palette() {
    return t("clover.shell.palette");
  },
  get paletteSearch() {
    return t("clover.shell.paletteSearch");
  },
  get paletteResults() {
    return t("clover.shell.paletteResults");
  },
  get paletteNone() {
    return t("clover.shell.paletteNone");
  },
  get paletteGo() {
    return t("clover.shell.paletteGo");
  },
  get paletteRun() {
    return t("clover.shell.paletteRun");
  },
  get paletteBack() {
    return t("clover.shell.paletteBack");
  },
  get paletteChoose() {
    return t("clover.shell.paletteChoose");
  },
  paletteRequired: (field: string) => t("clover.shell.paletteRequired", { field }),
  get paletteRequiredMark() {
    return t("clover.shell.paletteRequiredMark");
  },
  paletteNumber: (field: string) => t("clover.shell.paletteNumber", { field }),
  paletteTooSmall: (field: string, limit: number) => t("clover.shell.paletteTooSmall", { field, limit }),
  paletteTooBig: (field: string, limit: number) => t("clover.shell.paletteTooBig", { field, limit }),
  paletteTooFew: (field: string, count: number, of: "characters" | "items") => t(`clover.shell.paletteTooFew.${of}`, { field, count }),
  paletteTooMany: (field: string, count: number, of: "characters" | "items") => t(`clover.shell.paletteTooMany.${of}`, { field, count }),
  paletteUnknownField: (field: string) => t("clover.shell.paletteUnknownField", { field }),
  paletteInvalid: (field: string) => t("clover.shell.paletteInvalid", { field }),
  get paletteArgsInvalid() {
    return t("clover.shell.paletteArgsInvalid");
  },
  get paletteSchemaUnreadable() {
    return t("clover.shell.paletteSchemaUnreadable");
  },
  paletteJson: (field: string) => t("clover.shell.paletteJson", { field }),
  paletteArgsFor: (command: string) => t("clover.shell.paletteArgsFor", { command }),
  paletteRunning: (command: string) => t("clover.shell.paletteRunning", { command }),
  paletteFailed: (command: string, why: string) => t("clover.shell.paletteFailed", { command, why }),
  get palettePressKeys() {
    return t("clover.shell.palettePressKeys");
  },
  paletteRebind: (command: string) => t("clover.shell.paletteRebind", { command }),
  paletteUnbind: (command: string) => t("clover.shell.paletteUnbind", { command }),
  get paletteChangeKey() {
    return t("clover.shell.paletteChangeKey");
  },
  get paletteRemoveKey() {
    return t("clover.shell.paletteRemoveKey");
  },
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
