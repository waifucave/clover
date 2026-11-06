// Every string the composer shows, in one place.
import en from "../locales/en.json" with { type: "json" };
import { translator } from "../../shell/runtime/strings";

/** This part's words: `clover.composer.` keys, English in `locales/en.json`, the user's language through the app's tables. */
const t = translator(en.strings);

export const S = {
  placeholder: (bot: string) => t("clover.composer.placeholder", { bot }),
  label: (bot: string) => t("clover.composer.label", { bot }),
  get send() {
    return t("clover.composer.send");
  },
  get stop() {
    return t("clover.composer.stop");
  },
  get attach() {
    return t("clover.composer.attach");
  },
  remove: (name: string) => t("clover.composer.remove", { name }),
  get holdToTalk() {
    return t("clover.composer.holdToTalk");
  },
  get listening() {
    return t("clover.composer.listening");
  },
  model: (label: string) => t("clover.composer.model", { label }),
  get modelMenu() {
    return t("clover.composer.modelMenu");
  },
  get modelSection() {
    return t("clover.composer.modelSection");
  },
  level: (computer: string, label: string, requested?: string) =>
    requested ? t("clover.composer.levelWithAsked", { computer, label, requested }) : t("clover.composer.level", { computer, label }),
  levelMenu: (computer: string) => t("clover.composer.levelMenu", { computer }),
  levelAsked: (label: string) => t("clover.composer.levelAsked", { label }),
  get levelAskedTag() {
    return t("clover.composer.levelAskedTag");
  },
  get levelNote() {
    return t("clover.composer.levelNote");
  },
  levels: {
    "read-only": {
      get label() {
        return t("clover.composer.levels.read-only.label");
      },
      get detail() {
        return t("clover.composer.levels.read-only.detail");
      },
    },
    ask: {
      get label() {
        return t("clover.composer.levels.ask.label");
      },
      get detail() {
        return t("clover.composer.levels.ask.detail");
      },
    },
    "ask-risky": {
      get label() {
        return t("clover.composer.levels.ask-risky.label");
      },
      get detail() {
        return t("clover.composer.levels.ask-risky.detail");
      },
    },
    "accept-edits": {
      get label() {
        return t("clover.composer.levels.accept-edits.label");
      },
      get detail() {
        return t("clover.composer.levels.accept-edits.detail");
      },
    },
    automatic: {
      get label() {
        return t("clover.composer.levels.automatic.label");
      },
      get detail() {
        return t("clover.composer.levels.automatic.detail");
      },
    },
  } as const,
  get effort() {
    return t("clover.composer.effort");
  },
  interruptHint: (bot: string) => t("clover.composer.interruptHint", { bot }),
  asleep: (bot: string, reason: string) => t("clover.composer.asleep", { bot, reason }),
  tooManyAttachments: (max: number) => t("clover.composer.tooManyAttachments", { count: max }),
  get dropHere() {
    return t("clover.composer.dropHere");
  },
};
