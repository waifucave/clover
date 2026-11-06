// Every string the archive shows.
import en from "../locales/en.json" with { type: "json" };
import { translator } from "../../shell/runtime/strings";

/** This part's words: `clover.archive.` keys, English in `locales/en.json`, the user's language through the app's tables. */
const t = translator(en.strings);

export const S = {
  get speaker() {
    return t("clover.archive.speaker");
  },
  get title() {
    return t("clover.archive.title");
  },
  get intro() {
    return t("clover.archive.intro");
  },
  get search() {
    return t("clover.archive.search");
  },
  get sessions() {
    return t("clover.archive.sessions");
  },
  get loading() {
    return t("clover.archive.loading");
  },
  none: (query: string) => (query ? t("clover.archive.noneMatching", { query }) : t("clover.archive.none")),
  get more() {
    return t("clover.archive.more");
  },
  mode: {
    get code() {
      return t("clover.archive.mode.code");
    },
    get chat() {
      return t("clover.archive.mode.chat");
    },
    get dispatch() {
      return t("clover.archive.mode.dispatch");
    },
  } as const,
  messages: (n: number) => t("clover.archive.messages", { count: n }),
  get untitled() {
    return t("clover.archive.untitled");
  },
  get pick() {
    return t("clover.archive.pick");
  },
  get readOnly() {
    return t("clover.archive.readOnly");
  },
};
