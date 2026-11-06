// Every string the settings window shows.
import type { PluginState, SettingsSection } from "./types";

import en from "../locales/en.json" with { type: "json" };
import { translator } from "../../shell/runtime/strings";

/** This part's words: `clover.settings.` keys, English in `locales/en.json`, the user's language through the app's tables. */
const t = translator(en.strings);

export const S = {
  /** What a capability lets a plugin do, in plain words (the capability's own name when it has none). */
  okWord: (capability: string) => {
    const key = `clover.settings.ok.${capability}`;
    const text = t(key);
    return text === key ? capability : text;
  },
  okCall: (plugin: string) => t("clover.settings.okCall", { plugin }),
  okHost: (host: string) => t("clover.settings.okHost", { host }),
  source: (source: string) => t(`clover.settings.source.${source}`),
  levelName: (level: string) => t(`clover.settings.level.${level}`),
  get title() {
    return t("clover.settings.title");
  },
  get close() {
    return t("clover.settings.close");
  },
  get search() {
    return t("clover.settings.search");
  },
  get sections() {
    return t("clover.settings.sections");
  },
  section: {
    get account() {
      return t("clover.settings.section.account");
    },
    get devices() {
      return t("clover.settings.section.devices");
    },
    get appearance() {
      return t("clover.settings.section.appearance");
    },
    get notifications() {
      return t("clover.settings.section.notifications");
    },
    get plugins() {
      return t("clover.settings.section.plugins");
    },
    get levels() {
      return t("clover.settings.section.levels");
    },
    get bots() {
      return t("clover.settings.section.bots");
    },
  } satisfies Record<SettingsSection, string>,
  get later() {
    return t("clover.settings.later");
  },
  get laterDetail() {
    return t("clover.settings.laterDetail");
  },
  get noMatch() {
    return t("clover.settings.noMatch");
  },
  // Account.
  get name() {
    return t("clover.settings.name");
  },
  get nameDetail() {
    return t("clover.settings.nameDetail");
  },
  get main() {
    return t("clover.settings.main");
  },
  get mainDetail() {
    return t("clover.settings.mainDetail");
  },
  // Devices.
  get devices() {
    return t("clover.settings.devices");
  },
  get devicesDetail() {
    return t("clover.settings.devicesDetail");
  },
  get thisDevice() {
    return t("clover.settings.thisDevice");
  },
  get mainDevice() {
    return t("clover.settings.mainDevice");
  },
  remove: (name: string) => t("clover.settings.remove", { name }),
  makeMain: (name: string) => t("clover.settings.makeMain", { name }),
  get makeMainLabel() {
    return t("clover.settings.makeMainLabel");
  },
  get pairTitle() {
    return t("clover.settings.pairTitle");
  },
  get pairDetail() {
    return t("clover.settings.pairDetail");
  },
  get pairBegin() {
    return t("clover.settings.pairBegin");
  },
  get pairJoinLabel() {
    return t("clover.settings.pairJoinLabel");
  },
  get pairJoin() {
    return t("clover.settings.pairJoin");
  },
  get pairCodeNote() {
    return t("clover.settings.pairCodeNote");
  },
  get pairWords() {
    return t("clover.settings.pairWords");
  },
  get pairConfirm() {
    return t("clover.settings.pairConfirm");
  },
  get pairConfirming() {
    return t("clover.settings.pairConfirming");
  },
  get pairCancel() {
    return t("clover.settings.pairCancel");
  },
  get pairExpired() {
    return t("clover.settings.pairExpired");
  },
  pairFailed: (reason: string) => (reason ? t("clover.settings.pairFailedWhy", { reason }) : t("clover.settings.pairFailed")),
  get pairClose() {
    return t("clover.settings.pairClose");
  },
  get removeLabel() {
    return t("clover.settings.removeLabel");
  },
  // Appearance.
  get theme() {
    return t("clover.settings.theme");
  },
  get themeDetail() {
    return t("clover.settings.themeDetail");
  },
  themes: {
    get light() {
      return t("clover.settings.themes.light");
    },
    get dark() {
      return t("clover.settings.themes.dark");
    },
    get system() {
      return t("clover.settings.themes.system");
    },
  } as const,
  get themePlugin() {
    return t("clover.settings.themePlugin");
  },
  get themePluginDetail() {
    return t("clover.settings.themePluginDetail");
  },
  get textSize() {
    return t("clover.settings.textSize");
  },
  textSizes: {
    get small() {
      return t("clover.settings.textSizes.small");
    },
    get default() {
      return t("clover.settings.textSizes.default");
    },
    get large() {
      return t("clover.settings.textSizes.large");
    },
  } as const,
  get language() {
    return t("clover.settings.language");
  },
  get languageDetail() {
    return t("clover.settings.languageDetail");
  },
  get change() {
    return t("clover.settings.change");
  },
  // Notifications.
  get notifyNeedsYou() {
    return t("clover.settings.notifyNeedsYou");
  },
  get notifyNeedsYouDetail() {
    return t("clover.settings.notifyNeedsYouDetail");
  },
  get notifyAgentDone() {
    return t("clover.settings.notifyAgentDone");
  },
  get notifyRoutineFailed() {
    return t("clover.settings.notifyRoutineFailed");
  },
  get notifySounds() {
    return t("clover.settings.notifySounds");
  },
  // Plugins.
  get plugins() {
    return t("clover.settings.plugins");
  },
  get pluginsDetail() {
    return t("clover.settings.pluginsDetail");
  },
  pluginState: {
    get found() {
      return t("clover.settings.pluginState.found");
    },
    get refused() {
      return t("clover.settings.pluginState.refused");
    },
    get invalid() {
      return t("clover.settings.pluginState.invalid");
    },
    get off() {
      return t("clover.settings.pluginState.off");
    },
    get waiting() {
      return t("clover.settings.pluginState.waiting");
    },
    get running() {
      return t("clover.settings.pluginState.running");
    },
    get stopped() {
      return t("clover.settings.pluginState.stopped");
    },
    get blocked() {
      return t("clover.settings.pluginState.blocked");
    },
  } satisfies Record<PluginState, string>,
  pluginOks: (oks: string[]) => (oks.length === 0 ? t("clover.settings.asksNothing") : oks.join(t("clover.settings.listSeparator"))),
  get pluginLogs() {
    return t("clover.settings.pluginLogs");
  },
  get reviewOk() {
    return t("clover.settings.reviewOk");
  },
  reviewOkFor: (name: string) => t("clover.settings.reviewOkFor", { name }),
  get pluginBuiltIn() {
    return t("clover.settings.pluginBuiltIn");
  },
  get back() {
    return t("clover.settings.back");
  },
  get noLogs() {
    return t("clover.settings.noLogs");
  },
  get botsTitle() {
    return t("clover.settings.botsTitle");
  },
  get botsDetail() {
    return t("clover.settings.botsDetail");
  },
  get edit() {
    return t("clover.settings.edit");
  },
  editBot: (name: string) => t("clover.settings.editBot", { name }),
  pluginLogsFor: (name: string) => t("clover.settings.pluginLogsFor", { name }),
  get pluginManager() {
    return t("clover.settings.pluginManager");
  },
  // Levels.
  get levels() {
    return t("clover.settings.levels");
  },
  get levelsDetail() {
    return t("clover.settings.levelsDetail");
  },
  levelFor: (computer: string) => t("clover.settings.levelFor", { computer }),
  levelAsked: (label: string) => t("clover.settings.levelAsked", { label }),
  // The language chooser.
  get chooseLanguage() {
    return t("clover.settings.chooseLanguage");
  },
  get searchLanguages() {
    return t("clover.settings.searchLanguages");
  },
  get closeLanguages() {
    return t("clover.settings.closeLanguages");
  },
  get noLanguage() {
    return t("clover.settings.noLanguage");
  },
};
