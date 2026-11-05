// Every string the composer shows, in one place, for the move to `clover.` keys (plan, F-M3).
export const S = {
  placeholder: (bot: string) => `Message ${bot}`,
  label: (bot: string) => `Message to ${bot}`,
  send: "Send",
  stop: "Stop",
  attach: "Attach files",
  remove: (name: string) => `Remove ${name}`,
  holdToTalk: "Hold to talk",
  listening: "Listening… release to stop",
  model: (label: string) => `Model: ${label}`,
  modelMenu: "Model and effort",
  effort: "Effort",
  interruptHint: (bot: string) => `Sending now interrupts ${bot}.`,
  asleep: (bot: string, reason: string) => `${bot} is asleep: ${reason}. Your message waits here until it's back.`,
  tooManyAttachments: (max: number) => `A message can carry at most ${max} attachments.`,
  dropHere: "Drop files to attach them",
};
