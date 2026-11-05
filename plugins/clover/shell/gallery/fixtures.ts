// Mock sidebar data for the gallery and the tests.
import type { SidebarAccount, SidebarAgent, SidebarApp, SidebarBot, SidebarProject } from "../client/types";

/** A soft round portrait with an initial, standing in for a bot's avatar portrait. */
export function portrait(letter: string, from: string, to: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="56" height="56"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs><circle cx="28" cy="28" r="28" fill="url(#g)"/><text x="28" y="36" font-family="system-ui, sans-serif" font-size="24" font-weight="600" text-anchor="middle" fill="#ffffff">${letter}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export const ALPHA_AGENTS: SidebarAgent[] = [
  { id: "agent-island", title: "Rebuild the island as a plugin", backend: "Codex", computer: "Studio", status: "running" },
  { id: "agent-lint", title: "Fix the lint warnings", backend: "OpenCode", computer: "Laptop", status: "needs-you" },
  { id: "agent-docs", title: "Write the plugin SDK docs", backend: "Codex", computer: "Studio", status: "completed" },
  { id: "agent-hub", title: "Profile the hub's cold start", backend: "Gemini CLI", computer: "Cloud computer", status: "stalled" },
];

export const BOTS: SidebarBot[] = [
  { id: "alpha", name: "Alpha", portraitUrl: portrait("A", "#8ccbf0", "#3d7fb0"), status: "working", agents: ALPHA_AGENTS },
  { id: "luna", name: "Luna", portraitUrl: portrait("L", "#c9a7f2", "#6f4ab0"), status: "needs-you", needsYou: 2 },
  { id: "juniper", name: "Juniper", status: "idle", activity: "Morning brief running on Studio" },
  { id: "mira", name: "Mira", portraitUrl: portrait("M", "#f6b8a0", "#b0583d"), status: "idle", unread: true },
];

export const PROJECTS: SidebarProject[] = [
  {
    id: "clover",
    name: "clover",
    path: "home/Studio/projects/clover",
    sessions: [
      { id: "session-panels", title: "The panels as plugins", branch: "lane/f-m1", changes: 14, status: "running" },
      { id: "session-hub", title: "Hub migrations on staging", branch: "hub-staging", changes: 3, status: "needs-you", needsYou: 1 },
      { id: "session-docs", title: "README for the plugin index", branch: "main", changes: 0, status: "completed" },
    ],
  },
  {
    id: "tarot",
    name: "tarot-panel",
    path: "home/Laptop/code/tarot-panel",
    sessions: [
      { id: "session-spread", title: "Three-card spread layout", branch: "spread", changes: 6, status: "idle" },
      { id: "session-icons", title: "Card icons at every size", branch: "icons", changes: 2, status: "failed" },
    ],
  },
  { id: "keycaps", name: "keycaps", path: "home/Studio/projects/keycaps", sessions: [] },
];

/** The apps we ship, plus one a third-party plugin adds (Discord Waifus, spec §11). */
export const APPS: SidebarApp[] = [
  { id: "browser", title: "Browser", icon: { glyph: "globe" } },
  { id: "usage", title: "Usage", icon: { glyph: "chart" } },
  { id: "archive", title: "Archive", icon: { glyph: "archive" } },
  { id: "discord-waifus", title: "Discord Waifus", icon: { url: portrait("D", "#7289da", "#3b4a8c") }, badge: 3 },
];

export const BUNDLED_APPS = APPS.filter((a) => a.id !== "discord-waifus");

export const ACCOUNT: SidebarAccount = { name: "Sam", detail: "Studio" };
