// Every string the terminal panel shows.
import en from "../locales/en.json" with { type: "json" };
import { translator } from "../../shell/runtime/strings";

/** This part's words: `clover.terminal.` keys, English in `locales/en.json`, the user's language through the app's tables. */
const t = translator(en.strings);

export const S = {
  get terminals() {
    return t("clover.terminal.terminals");
  },
  get newTerminal() {
    return t("clover.terminal.newTerminal");
  },
  close: (title: string) => t("clover.terminal.close", { title }),
  output: (title: string) => t("clover.terminal.output", { title }),
  exited: (code: number) => t("clover.terminal.exited", { count: code }),
  get leaveHint() {
    return t("clover.terminal.leaveHint");
  },
};
