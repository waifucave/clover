// Every string the panel shows, in one place.

import en from "../locales/en.json" with { type: "json" };
import { translator } from "../../shell/runtime/strings";

/** This part's words: `clover.panel.` keys, English in `locales/en.json`, the user's language through the app's tables. */
const t = translator(en.strings);

export const S = {
  get outputLinkDetail() {
    return t("clover.panel.outputLinkDetail");
  },
  levelName: (level: string) => t(`clover.panel.level.${level}`),
  views: {
    get session() {
      return t("clover.panel.views.session");
    },
    get terminal() {
      return t("clover.panel.views.terminal");
    },
    get diff() {
      return t("clover.panel.views.diff");
    },
    get browser() {
      return t("clover.panel.views.browser");
    },
    get files() {
      return t("clover.panel.views.files");
    },
  } as const,
  /** A bot's tab's slim column. */
  get botColumn() {
    return t("clover.panel.botColumn");
  },
  toggle: (label: string, open: boolean) => t(open ? "clover.panel.hide" : "clover.panel.show", { label }),
  get more() {
    return t("clover.panel.more");
  },
  close: (title: string) => t("clover.panel.close", { title }),
  expand: (title: string) => t("clover.panel.expand", { title }),
  get panel() {
    return t("clover.panel.panel");
  },
  empty: (title: string) => t("clover.panel.empty", { title: title.toLocaleLowerCase() }),
  get emptyDetail() {
    return t("clover.panel.emptyDetail");
  },
  get findPlugin() {
    return t("clover.panel.findPlugin");
  },
  // The session column.
  get agents() {
    return t("clover.panel.agents");
  },
  get environment() {
    return t("clover.panel.environment");
  },
  get here() {
    return t("clover.panel.here");
  },
  level: (label: string) => t("clover.panel.level", { label }),
  levelRequested: (label: string) => t("clover.panel.levelRequested", { label }),
  levelRequestedTitle: (label: string) => t("clover.panel.levelRequestedTitle", { label }),
  get changeLevel() {
    return t("clover.panel.changeLevel");
  },
  changeLevelTitle: (computer: string) => t("clover.panel.changeLevelTitle", { computer }),
  get context() {
    return t("clover.panel.context");
  },
  contextUsed: (pct: number) => t("clover.panel.contextUsed", { count: pct }),
  contextLabel: (pct: number) => t("clover.panel.contextLabel", { count: pct }),
  get connectors() {
    return t("clover.panel.connectors");
  },
  connectorsState: (total: number, needSignIn: number) =>
    needSignIn > 0 ? t("clover.panel.connectorsSignIn", { count: needSignIn }) : t("clover.panel.connectorsConnected", { count: total }),
  get outputs() {
    return t("clover.panel.outputs");
  },
  outputKind: {
    get link() {
      return t("clover.panel.outputKind.link");
    },
    get page() {
      return t("clover.panel.outputKind.page");
    },
    get file() {
      return t("clover.panel.outputKind.file");
    },
    get image() {
      return t("clover.panel.outputKind.image");
    },
  } as const,
  showMore: (count: number) => t("clover.panel.showMore", { count: count }),
  get changes() {
    return t("clover.panel.changes");
  },
  diffStat: (added: number, removed: number) => t("clover.panel.diffStat", { added, removed }),
  diffStatLabel: (files: number, added: number, removed: number) => t("clover.panel.diffStatLabel", { files: t("clover.panel.files", { count: files }), added, removed }),
  agentStatus: {
    get running() {
      return t("clover.panel.agentStatus.running");
    },
    get "needs-you"() {
      return t("clover.panel.agentStatus.needs-you");
    },
    get completed() {
      return t("clover.panel.agentStatus.completed");
    },
    get failed() {
      return t("clover.panel.agentStatus.failed");
    },
    get stopped() {
      return t("clover.panel.agentStatus.stopped");
    },
    get stalled() {
      return t("clover.panel.agentStatus.stalled");
    },
  } as const,
  fold: (title: string) => t("clover.panel.fold", { title }),
  unfold: (title: string) => t("clover.panel.unfold", { title }),
};
