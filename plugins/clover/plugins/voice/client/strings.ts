// Clover Voice's words: Settings › Voice (`settings.section`), a bot's editor (`bot.editor.section`) and the stage's chip.
export const S = {
  section: "Voice",
  active: "Active voice",
  activeDetail: "The voice that speaks for your bots and hears your push-to-talk on this computer. A voice plugin you install can take its place; only the one chosen here speaks or listens.",
  activeOff: (name: string) => `${name} (not running)`,
  offNote: "Turning Clover Voice off in Plugins makes your bots text-only.",
  speak: "Speak replies",
  speakDetail: "Your bots say their replies aloud with their voices. Off, they stay text-only until you turn it back on.",
  failed: (why: string) => `That didn't work: ${why}`,
  voice: "Voice",
  voiceDetail: "Voices come with voice plugins.",
  noVoice: "None",
  voiceOf: (provider: string, voice: string) => `${voice} · ${provider}`,
  reset: "Reset",
  stopSpeaking: "Stop speaking",
  mute: "Mute spoken replies",
  unmute: "Unmute spoken replies",
} as const;
