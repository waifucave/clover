// Every string the conversation view shows, in one place, so moving them to `clover.` keys behind
// `t()` (plan, F-M3) is one mechanical change.


import en from "../locales/en.json" with { type: "json" };
import { translator } from "../../shell/runtime/strings";

/** This part's words: `clover.conversation.` keys, English in `locales/en.json`, the user's language through the app's tables. */
const t = translator(en.strings);

export const S = {
  // The archive's notes for an old session's approvals, and a turn's error.
  askedToUse: (tool: string) => t("clover.conversation.askedToUse", { tool }),
  askedToUseWhat: (tool: string, summary: string) => t("clover.conversation.askedToUseWhat", { tool, summary }),
  get aTool() {
    return t("clover.conversation.aTool");
  },
  get allowed() {
    return t("clover.conversation.allowed");
  },
  get denied() {
    return t("clover.conversation.denied");
  },
  get turnError() {
    return t("clover.conversation.turnError");
  },
  // Days and durations (format.ts).
  get today() {
    return t("clover.conversation.today");
  },
  get yesterday() {
    return t("clover.conversation.yesterday");
  },
  seconds: (n: number) => t("clover.conversation.seconds", { count: n }),
  minutes: (n: number) => t("clover.conversation.minutes", { count: n }),
  hours: (n: number) => t("clover.conversation.hours", { count: n }),
  empty: (bot: string) => t("clover.conversation.empty", { bot }),
  get showEarlier() {
    return t("clover.conversation.showEarlier");
  },
  get jumpToLatest() {
    return t("clover.conversation.jumpToLatest");
  },
  conversationLabel: (bot: string) => t("clover.conversation.conversationLabel", { bot }),
  // The turn's own status line.
  turnThinking: (bot: string) => t("clover.conversation.turnThinking", { bot }),
  turnWorking: (bot: string) => t("clover.conversation.turnWorking", { bot }),
  turnWaiting: (bot: string) => t("clover.conversation.turnWaiting", { bot }),
  get turnCompacting() {
    return t("clover.conversation.turnCompacting");
  },
  turnRetrying: (attempt: number, max: number) => t("clover.conversation.turnRetrying", { attempt, max }),
  // Messages.
  botSaid: (bot: string) => t("clover.conversation.botSaid", { bot }),
  get you() {
    return t("clover.conversation.you");
  },
  fromDevice: (device: string) => t("clover.conversation.fromDevice", { device }),
  openAttachment: (name: string) => t("clover.conversation.openAttachment", { name }),
  get arrivedLate() {
    return t("clover.conversation.arrivedLate");
  },
  get interrupted() {
    return t("clover.conversation.interrupted");
  },
  get copy() {
    return t("clover.conversation.copy");
  },
  get copied() {
    return t("clover.conversation.copied");
  },
  get copyMessage() {
    return t("clover.conversation.copyMessage");
  },
  get copyCode() {
    return t("clover.conversation.copyCode");
  },
  imageLink: (alt: string) => (alt ? t("clover.conversation.imageLinkAlt", { alt }) : t("clover.conversation.imageLink")),
  // Thinking.
  get thinkingLive() {
    return t("clover.conversation.thinkingLive");
  },
  get thinkingDone() {
    return t("clover.conversation.thinkingDone");
  },
  thinkingFor: (duration: string) => t("clover.conversation.thinkingFor", { duration }),
  get thinkingHidden() {
    return t("clover.conversation.thinkingHidden");
  },
  get thinkingTruncated() {
    return t("clover.conversation.thinkingTruncated");
  },
  // Tools.
  get toolRunning() {
    return t("clover.conversation.toolRunning");
  },
  get toolWaiting() {
    return t("clover.conversation.toolWaiting");
  },
  get toolSucceeded() {
    return t("clover.conversation.toolSucceeded");
  },
  get toolFailed() {
    return t("clover.conversation.toolFailed");
  },
  get toolInterrupted() {
    return t("clover.conversation.toolInterrupted");
  },
  get toolReviewing() {
    return t("clover.conversation.toolReviewing");
  },
  toolOnComputer: (computer: string) => t("clover.conversation.toolOnComputer", { computer }),
  get toolNoOutput() {
    return t("clover.conversation.toolNoOutput");
  },
  toolMoreLines: (count: number) => t("clover.conversation.toolMoreLines", { count: count }),
  toolMore: (count: number) => t("clover.conversation.toolMore", { count: count }),
  get toolMoreCharacters() {
    return t("clover.conversation.toolMoreCharacters");
  },
  toolOpenDiff: (path: string) => t("clover.conversation.toolOpenDiff", { path }),
  get toolShowDetails() {
    return t("clover.conversation.toolShowDetails");
  },
  get toolHideDetails() {
    return t("clover.conversation.toolHideDetails");
  },
  // Approvals.
  get approvalPending() {
    return t("clover.conversation.approvalPending");
  },
  get approvalApproved() {
    return t("clover.conversation.approvalApproved");
  },
  get approvalDenied() {
    return t("clover.conversation.approvalDenied");
  },
  get approvalExpired() {
    return t("clover.conversation.approvalExpired");
  },
  get approvalWithdrawn() {
    return t("clover.conversation.approvalWithdrawn");
  },
  get approvalCancelled() {
    return t("clover.conversation.approvalCancelled");
  },
  get approvalWithdrawnInterrupt() {
    return t("clover.conversation.approvalWithdrawnInterrupt");
  },
  answeredOn: (device: string) => t("clover.conversation.answeredOn", { device }),
  // Questions.
  questionAsks: (bot: string) => t("clover.conversation.questionAsks", { bot }),
  get questionOther() {
    return t("clover.conversation.questionOther");
  },
  get questionTypeAnswer() {
    return t("clover.conversation.questionTypeAnswer");
  },
  get questionSubmit() {
    return t("clover.conversation.questionSubmit");
  },
  get questionAnswered() {
    return t("clover.conversation.questionAnswered");
  },
  questionExpired: (bot: string) => t("clover.conversation.questionExpired", { bot }),
  get questionWithdrawn() {
    return t("clover.conversation.questionWithdrawn");
  },
  get questionWithdrawnInterrupt() {
    return t("clover.conversation.questionWithdrawnInterrupt");
  },
  get questionSendFailed() {
    return t("clover.conversation.questionSendFailed");
  },
  questionGoesOnIn: (bot: string, minutes: number) => t("clover.conversation.questionGoesOnIn", { bot, count: minutes }),
  get questionPreview() {
    return t("clover.conversation.questionPreview");
  },
  // Routines.
  routineRan: (computer: string) => t("clover.conversation.routineRan", { computer }),
  get routineFailed() {
    return t("clover.conversation.routineFailed");
  },
  get routineOpenRun() {
    return t("clover.conversation.routineOpenRun");
  },
  // Task notifications.
  taskAgentStatus: {
    get completed() {
      return t("clover.conversation.taskAgentStatus.completed");
    },
    get failed() {
      return t("clover.conversation.taskAgentStatus.failed");
    },
    get stopped() {
      return t("clover.conversation.taskAgentStatus.stopped");
    },
    get stalled() {
      return t("clover.conversation.taskAgentStatus.stalled");
    },
  } as const,
  taskCommandStatus: {
    get completed() {
      return t("clover.conversation.taskCommandStatus.completed");
    },
    get failed() {
      return t("clover.conversation.taskCommandStatus.failed");
    },
    get stopped() {
      return t("clover.conversation.taskCommandStatus.stopped");
    },
    get stalled() {
      return t("clover.conversation.taskCommandStatus.stalled");
    },
  } as const,
  taskExitCode: (code: number) => t("clover.conversation.taskExitCode", { count: code }),
  get taskOpenTab() {
    return t("clover.conversation.taskOpenTab");
  },
  get taskOpenTranscript() {
    return t("clover.conversation.taskOpenTranscript");
  },
  get showMore() {
    return t("clover.conversation.showMore");
  },
  get showLess() {
    return t("clover.conversation.showLess");
  },
  // Agent reports.
  get reportFrom() {
    return t("clover.conversation.reportFrom");
  },
  reportAgent: (backend?: string) => (backend ? t("clover.conversation.reportAgentOf", { backend }) : t("clover.conversation.reportAgent")),
  get reportBot() {
    return t("clover.conversation.reportBot");
  },
  get reportSession() {
    return t("clover.conversation.reportSession");
  },
  reportPlugin: (id: string) => t("clover.conversation.reportPlugin", { id }),
  get reportFromApp() {
    return t("clover.conversation.reportFromApp");
  },
  get reportFolded() {
    return t("clover.conversation.reportFolded");
  },
  // Notes.
  get notePluginId() {
    return t("clover.conversation.notePluginId");
  },
  get noteHookFrom() {
    return t("clover.conversation.noteHookFrom");
  },
  // Sealed cards with no UI runtime under them.
  get sealedUnavailable() {
    return t("clover.conversation.sealedUnavailable");
  },
};

export type Strings = typeof S;
