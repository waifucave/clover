// Every string the sidebar shows, in one place.
import type { AgentStatus, BotStatus } from "./types";


import en from "../locales/en.json" with { type: "json" };
import { translator } from "../../shell/runtime/strings";

/** This part's words: `clover.sidebar.` keys, English in `locales/en.json`, the user's language through the app's tables. */
const t = translator(en.strings);

export const S = {
  get app() {
    return t("clover.sidebar.app");
  },
  get nav() {
    return t("clover.sidebar.nav");
  },
  get sides() {
    return t("clover.sidebar.sides");
  },
  get sideBots() {
    return t("clover.sidebar.sideBots");
  },
  get sideCode() {
    return t("clover.sidebar.sideCode");
  },
  get newSession() {
    return t("clover.sidebar.newSession");
  },
  get newChat() {
    return t("clover.sidebar.newChat");
  },
  newSessionIn: (project: string) => t("clover.sidebar.newSessionIn", { project }),
  get search() {
    return t("clover.sidebar.search");
  },
  get outputs() {
    return t("clover.sidebar.outputs");
  },
  get plugins() {
    return t("clover.sidebar.plugins");
  },
  get more() {
    return t("clover.sidebar.more");
  },
  get bots() {
    return t("clover.sidebar.bots");
  },
  get projects() {
    return t("clover.sidebar.projects");
  },
  get apps() {
    return t("clover.sidebar.apps");
  },
  get settings() {
    return t("clover.sidebar.settings");
  },
  account: (name: string) => t("clover.sidebar.account", { name }),
  get collapse() {
    return t("clover.sidebar.collapse");
  },
  get expand() {
    return t("clover.sidebar.expand");
  },
  fold: (name: string) => t("clover.sidebar.fold", { name }),
  unfold: (name: string) => t("clover.sidebar.unfold", { name }),
  close: (title: string) => t("clover.sidebar.close", { title }),
  agentsOf: (bot: string) => t("clover.sidebar.agentsOf", { bot }),
  needsYou: (count: number) => t("clover.sidebar.needsYou", { count: count }),
  get unread() {
    return t("clover.sidebar.unread");
  },
  branch: (branch: string, changes: number | undefined) =>
    changes === undefined ? t("clover.sidebar.branch", { branch }) : t("clover.sidebar.branchChanged", { branch, count: changes }),
  get noSessions() {
    return t("clover.sidebar.noSessions");
  },
  botStatus: {
    get idle() {
      return t("clover.sidebar.botStatus.idle");
    },
    get thinking() {
      return t("clover.sidebar.botStatus.thinking");
    },
    get working() {
      return t("clover.sidebar.botStatus.working");
    },
    get "needs-you"() {
      return t("clover.sidebar.botStatus.needs-you");
    },
    get asleep() {
      return t("clover.sidebar.botStatus.asleep");
    },
    get paused() {
      return t("clover.sidebar.botStatus.paused");
    },
  } satisfies Record<BotStatus, string>,
  agentStatus: {
    get running() {
      return t("clover.sidebar.agentStatus.running");
    },
    get "needs-you"() {
      return t("clover.sidebar.agentStatus.needs-you");
    },
    get completed() {
      return t("clover.sidebar.agentStatus.completed");
    },
    get failed() {
      return t("clover.sidebar.agentStatus.failed");
    },
    get stopped() {
      return t("clover.sidebar.agentStatus.stopped");
    },
    get stalled() {
      return t("clover.sidebar.agentStatus.stalled");
    },
    get idle() {
      return t("clover.sidebar.agentStatus.idle");
    },
  } satisfies Record<AgentStatus | "idle", string>,
  get safeMode() {
    return t("clover.sidebar.safeMode");
  },
  get safeModeShort() {
    return t("clover.sidebar.safeModeShort");
  },
  get pluginManager() {
    return t("clover.sidebar.pluginManager");
  },
  get paused() {
    return t("clover.sidebar.paused");
  },
  get pausedShort() {
    return t("clover.sidebar.pausedShort");
  },
  get resume() {
    return t("clover.sidebar.resume");
  },
  unreachable: (main: string) => t("clover.sidebar.unreachable", { main }),
  takeover: (main: string, here: string) => t("clover.sidebar.takeover", { main, here }),
  get offline() {
    return t("clover.sidebar.offline");
  },
  get linkShort() {
    return t("clover.sidebar.linkShort");
  },
};
