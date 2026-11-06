// Every string the bot editor shows.
import en from "../locales/en.json" with { type: "json" };
import { translator } from "../../shell/runtime/strings";

/** This part's words: `clover.botEditor.` keys, English in `locales/en.json`, the user's language through the app's tables. */
const t = translator(en.strings);

export const S = {
  get back() {
    return t("clover.botEditor.back");
  },
  title: (name: string) => t("clover.botEditor.title", { name }),
  intro: (name: string) => t("clover.botEditor.intro", { name }),
  get reset() {
    return t("clover.botEditor.reset");
  },
  resetField: (field: string) => t("clover.botEditor.resetField", { field }),
  get save() {
    return t("clover.botEditor.save");
  },
  get waiting() {
    return t("clover.botEditor.waiting");
  },
  get name() {
    return t("clover.botEditor.name");
  },
  get nameDetail() {
    return t("clover.botEditor.nameDetail");
  },
  get instructions() {
    return t("clover.botEditor.instructions");
  },
  instructionsDetail: (name: string) => t("clover.botEditor.instructionsDetail", { name }),
  get instructionsSet() {
    return t("clover.botEditor.instructionsSet");
  },
  get instructionsPlaceholder() {
    return t("clover.botEditor.instructionsPlaceholder");
  },
  get model() {
    return t("clover.botEditor.model");
  },
  get modelDetail() {
    return t("clover.botEditor.modelDetail");
  },
  get effort() {
    return t("clover.botEditor.effort");
  },
  get avatar() {
    return t("clover.botEditor.avatar");
  },
  get avatarDetail() {
    return t("clover.botEditor.avatarDetail");
  },
  get noAvatars() {
    return t("clover.botEditor.noAvatars");
  },
  avatarFrom: (pack: string) => t("clover.botEditor.avatarFrom", { pack }),
  get voice() {
    return t("clover.botEditor.voice");
  },
  get voiceDetail() {
    return t("clover.botEditor.voiceDetail");
  },
  get noVoice() {
    return t("clover.botEditor.noVoice");
  },
  voiceOf: (provider: string, voice: string) => t("clover.botEditor.voiceOf", { provider, voice }),
  get theme() {
    return t("clover.botEditor.theme");
  },
  get themeDetail() {
    return t("clover.botEditor.themeDetail");
  },
  get themeOwn() {
    return t("clover.botEditor.themeOwn");
  },
  get layout() {
    return t("clover.botEditor.layout");
  },
  get layoutDetail() {
    return t("clover.botEditor.layoutDetail");
  },
  get layoutOwn() {
    return t("clover.botEditor.layoutOwn");
  },
  get layoutYours() {
    return t("clover.botEditor.layoutYours");
  },
  fields: {
    get name() {
      return t("clover.botEditor.fields.name");
    },
    get instructions() {
      return t("clover.botEditor.fields.instructions");
    },
    get model() {
      return t("clover.botEditor.fields.model");
    },
    get effort() {
      return t("clover.botEditor.fields.effort");
    },
    get voice() {
      return t("clover.botEditor.fields.voice");
    },
    get avatar() {
      return t("clover.botEditor.fields.avatar");
    },
    get theme() {
      return t("clover.botEditor.fields.theme");
    },
    get layout() {
      return t("clover.botEditor.fields.layout");
    },
  },
};
