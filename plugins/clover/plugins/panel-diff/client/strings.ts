// Every string the diff panel shows.

import en from "../locales/en.json" with { type: "json" };
import { translator } from "../../shell/runtime/strings";

/** This part's words: `clover.diff.` keys, English in `locales/en.json`, the user's language through the app's tables. */
const t = translator(en.strings);

export const S = {
  compare: (base: string, target: string) => t("clover.diff.compare", { base, target }),
  get workingTree() {
    return t("clover.diff.workingTree");
  },
  get layout() {
    return t("clover.diff.layout");
  },
  get unified() {
    return t("clover.diff.unified");
  },
  get split() {
    return t("clover.diff.split");
  },
  get files() {
    return t("clover.diff.files");
  },
  open: (path: string) => t("clover.diff.open", { path }),
  fold: (path: string) => t("clover.diff.fold", { path }),
  unfold: (path: string) => t("clover.diff.unfold", { path }),
  get tooLarge() {
    return t("clover.diff.tooLarge");
  },
  get hiddenWarning() {
    return t("clover.diff.hiddenWarning");
  },
  hiddenMark: (code: string, name: string) => t("clover.diff.hiddenMark", { code, name }),
  get binary() {
    return t("clover.diff.binary");
  },
  renamed: (from: string) => t("clover.diff.renamed", { from }),
  stat: (added: number, removed: number) => t("clover.diff.stat", { added: t("clover.diff.linesAdded", { count: added }), removed: t("clover.diff.linesRemoved", { count: removed }) }),
  status: {
    get added() {
      return t("clover.diff.status.added");
    },
    get modified() {
      return t("clover.diff.status.modified");
    },
    get deleted() {
      return t("clover.diff.status.deleted");
    },
    get renamed() {
      return t("clover.diff.status.renamed");
    },
  } as const,
  get base() {
    return t("clover.diff.base");
  },
  get target() {
    return t("clover.diff.target");
  },
  get none() {
    return t("clover.diff.none");
  },
};
