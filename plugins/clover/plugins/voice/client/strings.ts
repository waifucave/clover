// The Voice section's words (the `settings.section` entry this part fills).
export const S = {
  section: "Voice",
  active: "Active voice",
  activeDetail: "The voice that speaks for your bots and hears your push-to-talk on this computer. A voice plugin you install can take its place; only the one chosen here speaks or listens.",
  activeNone: "No voice is running, so your bots are text-only. Turn on Clover Voice or another voice plugin in Plugins.",
  activeOff: (name: string) => `${name} (not running)`,
  offNote: "Turning Clover Voice off in Plugins makes your bots text-only, unless another voice plugin is chosen here.",
  failed: (why: string) => `That didn't work: ${why}`,
} as const;
