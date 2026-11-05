// Every string the conversation view shows, in one place, so moving them to `clover.` keys behind
// `t()` (plan, F-M3) is one mechanical change.

const n = (count: number, one: string, many: string) => (count === 1 ? one : many.replace("#", String(count)));

export const S = {
  // Days and durations (format.ts).
  today: "Today",
  yesterday: "Yesterday",
  seconds: (n: number) => `${n}s`,
  minutes: (n: number) => `${n} min`,
  hours: (n: number) => `${n} h`,

  empty: (bot: string) => `This is the start of your conversation with ${bot}.`,
  showEarlier: "Show earlier messages",
  jumpToLatest: "Jump to latest",
  conversationLabel: (bot: string) => `Conversation with ${bot}`,

  // The turn's own status line.
  turnThinking: (bot: string) => `${bot} is thinking`,
  turnWorking: (bot: string) => `${bot} is working`,
  turnWaiting: (bot: string) => `${bot} is waiting for you`,
  turnCompacting: "Compacting the conversation",
  turnRetrying: (attempt: number, max: number) => `Provider busy, retrying (${attempt} of ${max})`,

  // Messages.
  botSaid: (bot: string) => `${bot}`,
  you: "You",
  fromDevice: (device: string) => `from ${device}`,
  arrivedLate: "arrived late",
  interrupted: "Interrupted",
  copy: "Copy",
  copied: "Copied",
  copyMessage: "Copy message",
  copyCode: "Copy code",
  imageLink: (alt: string) => (alt ? `Image: ${alt}` : "Image"),

  // Thinking.
  thinkingLive: "Thinking",
  thinkingDone: "Thought",
  thinkingFor: (duration: string) => `Thought it through · ${duration}`,
  thinkingHidden: "The provider kept this reasoning hidden.",
  thinkingTruncated: "Cut short: the rest was too long to keep.",

  // Tools.
  toolRunning: "Running",
  toolWaiting: "Waiting for your OK",
  toolSucceeded: "Done",
  toolFailed: "Failed",
  toolInterrupted: "Interrupted",
  toolReviewing: "Safety check",
  toolOnComputer: (computer: string) => `on ${computer}`,
  toolNoOutput: "No output",
  toolMoreLines: (count: number) => n(count, "1 more line", "# more lines"),
  toolMore: (count: number) => n(count, "1 more", "# more"),
  toolMoreCharacters: "The rest is too long to show here.",
  toolOpenDiff: (path: string) => `Open the diff for ${path}`,
  toolShowDetails: "Show details",
  toolHideDetails: "Hide details",

  // Approvals.
  approvalPending: "Needs your OK",
  approvalApproved: "Approved",
  approvalDenied: "Denied",
  approvalExpired: "Denied: no answer in time",
  approvalWithdrawn: "Withdrawn when the turn ended",
  approvalWithdrawnInterrupt: "Withdrawn when you interrupted",
  answeredOn: (device: string) => `on ${device}`,

  // Questions.
  questionAsks: (bot: string) => `${bot} asks`,
  questionOther: "Something else",
  questionTypeAnswer: "Type your answer",
  questionSubmit: "Send answer",
  questionAnswered: "You answered",
  questionExpired: (bot: string) => `No answer in time; ${bot} went on without it.`,
  questionWithdrawn: "Withdrawn when the turn ended",
  questionWithdrawnInterrupt: "Withdrawn when you interrupted",
  questionSendFailed: "Your answer didn't go through. Try again.",
  questionGoesOnIn: (bot: string, minutes: number) =>
    n(minutes, `${bot} goes on without an answer in 1 minute`, `${bot} goes on without an answer in # minutes`),
  questionPreview: "Preview",

  // Routines.
  routineRan: (computer: string) => `ran on ${computer}`,
  routineFailed: "Failed",
  routineOpenRun: "Open run",

  // Task notifications.
  taskAgentStatus: {
    completed: "finished",
    failed: "failed",
    stopped: "was stopped",
    stalled: "stopped making progress",
  } as const,
  taskCommandStatus: {
    completed: "Background command finished",
    failed: "Background command failed",
    stopped: "Background command was stopped",
    stalled: "Background command stalled",
  } as const,
  taskExitCode: (code: number) => `exit ${code}`,
  taskOpenTab: "Open tab",
  taskOpenTranscript: "Open transcript",
  showMore: "Show more",
  showLess: "Show less",

  // Agent reports.
  reportFrom: "From",
  reportAgent: (backend?: string) => (backend ? `${backend} agent` : "agent"),
  reportBot: "bot",
  reportSession: "session",
  reportPlugin: (id: string) => `plugin ${id}`,
  reportFolded: "joined the turn",

  // Notes.
  notePluginId: "plugin",
  noteHookFrom: "Hook from",

  // Sealed cards with no UI runtime under them.
  sealedUnavailable: "This approval card can only show in Clover's own window.",
};

export type Strings = typeof S;
