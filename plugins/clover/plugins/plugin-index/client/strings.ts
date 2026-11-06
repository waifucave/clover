// Every string the plugin index browser shows.
import en from "../locales/en.json" with { type: "json" };
import { translator } from "../../shell/runtime/strings";

/** This part's words: `clover.pluginIndex.` keys, English in `locales/en.json`, the user's language through the app's tables. */
const t = translator(en.strings);

export const S = {
  get title() {
    return t("clover.pluginIndex.title");
  },
  get intro() {
    return t("clover.pluginIndex.intro");
  },
  get search() {
    return t("clover.pluginIndex.search");
  },
  get searchButton() {
    return t("clover.pluginIndex.searchButton");
  },
  get installed() {
    return t("clover.pluginIndex.installed");
  },
  looking: (what: string) => t("clover.pluginIndex.looking", { what }),
  get lookingDetail() {
    return t("clover.pluginIndex.lookingDetail");
  },
  panelKey: (key: string) => t("clover.pluginIndex.panelKey", { key }),
  spotKey: (spot: string, key: string) => t("clover.pluginIndex.spotKey", { spot, key }),
  get results() {
    return t("clover.pluginIndex.results");
  },
  get searching() {
    return t("clover.pluginIndex.searching");
  },
  none: (query: string) => (query ? t("clover.pluginIndex.noneMatching", { query }) : t("clover.pluginIndex.none")),
  get install() {
    return t("clover.pluginIndex.install");
  },
  installName: (name: string) => t("clover.pluginIndex.installName", { name }),
  state: {
    get asking() {
      return t("clover.pluginIndex.state.asking");
    },
    get waiting() {
      return t("clover.pluginIndex.state.waiting");
    },
    get installed() {
      return t("clover.pluginIndex.state.installed");
    },
    get failed() {
      return t("clover.pluginIndex.state.failed");
    },
  },
  installedVersion: (v: string) => t("clover.pluginIndex.installedVersion", { v }),
  update: (v: string) => t("clover.pluginIndex.update", { v }),
  get notReviewed() {
    return t("clover.pluginIndex.notReviewed");
  },
  get notReviewedDetail() {
    return t("clover.pluginIndex.notReviewedDetail");
  },
  get adult() {
    return t("clover.pluginIndex.adult");
  },
  get gateTitle() {
    return t("clover.pluginIndex.gateTitle");
  },
  gateText: (name: string) => t("clover.pluginIndex.gateText", { name }),
  get gateConfirm() {
    return t("clover.pluginIndex.gateConfirm");
  },
  get gateCancel() {
    return t("clover.pluginIndex.gateCancel");
  },
  from: (index: string) => t("clover.pluginIndex.from", { index }),
  get indexes() {
    return t("clover.pluginIndex.indexes");
  },
  get indexesDetail() {
    return t("clover.pluginIndex.indexesDetail");
  },
  get official() {
    return t("clover.pluginIndex.official");
  },
  checked: (when: string) => t("clover.pluginIndex.checked", { when }),
  get neverChecked() {
    return t("clover.pluginIndex.neverChecked");
  },
};
