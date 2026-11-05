// Every string the sidebar shows, in one place, for the move to `clover.` keys (plan, F-M3).
import type { AgentStatus, BotStatus } from "./types";

const n = (count: number, one: string, many: string) => (count === 1 ? one : many.replace("#", String(count)));

export const S = {
  app: "Clover",
  nav: "Clover",
  bots: "Bots",
  coding: "Coding",
  apps: "Apps",
  newBot: "New bot",
  newSession: "Start a coding agent",
  plugins: "Plugins",
  settings: "Settings",
  collapse: "Hide the sidebar",
  expand: "Show the sidebar",
  close: (title: string) => `Close ${title}`,
  agentsOf: (bot: string) => `${bot}'s agents`,
  needsYou: (count: number) => n(count, "1 thing needs you", "# things need you"),
  unread: "New messages",
  botStatus: {
    idle: "",
    thinking: "Thinking…",
    working: "Working…",
    "needs-you": "Needs you",
    asleep: "Asleep",
    paused: "Paused",
  } satisfies Record<BotStatus, string>,
  agentStatus: {
    running: "Running",
    "needs-you": "Needs you",
    completed: "Done",
    failed: "Failed",
    stopped: "Stopped",
    stalled: "Stalled",
  } satisfies Record<AgentStatus, string>,
  safeMode: "Safe mode: only Clover's own plugins are running.",
  pluginManager: "Open the plugin manager",
  paused: "Every bot and routine is paused.",
  resume: "Resume",
  unreachable: (main: string) => `Can't reach your main computer, ${main}. Your bots wait for it.`,
  takeover: (main: string, here: string) => `${main} is offline, so ${here} runs your bots until it's back.`,
  offline: "Offline: other devices can't be reached.",
};
