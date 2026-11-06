// Every string the files panel shows.
import en from "../locales/en.json" with { type: "json" };
import { translator } from "../../shell/runtime/strings";

/** This part's words: `clover.files.` keys, English in `locales/en.json`, the user's language through the app's tables. */
const t = translator(en.strings);

export const S = {
  get tree() {
    return t("clover.files.tree");
  },
  get filter() {
    return t("clover.files.filter");
  },
  get filterHint() {
    return t("clover.files.filterHint");
  },
  get noMatch() {
    return t("clover.files.noMatch");
  },
  matches: (query: string) => t("clover.files.matches", { query }),
  noInside: (query: string) => t("clover.files.noInside", { query }),
  get truncated() {
    return t("clover.files.truncated");
  },
  match: (path: string, line: number) => t("clover.files.match", { path, line }),
  get emptyTitle() {
    return t("clover.files.emptyTitle");
  },
  get emptyText() {
    return t("clover.files.emptyText");
  },
  title: (folder: string, computer: string) => t("clover.files.title", { folder, computer }),
  on: (computer: string) => t("clover.files.on", { computer }),
  get hiddenWarning() {
    return t("clover.files.hiddenWarning");
  },
  hiddenMark: (code: string, name: string) => t("clover.files.hiddenMark", { code, name }),
  get loading() {
    return t("clover.files.loading");
  },
  viewer: (path: string) => t("clover.files.viewer", { path }),
  fold: (name: string) => t("clover.files.fold", { name }),
  unfold: (name: string) => t("clover.files.unfold", { name }),
};
