// The well-known UI spots, as lane B's catalog has them (`packages/plugin-sdk/src/catalogs/spots.ts` on `lane/b-m0`):
// each one's shape, the keys it keeps and what it hands each component. The default shell and its parts declare them
// (`clover.json`'s `declares`), and the stand-in runtime resolves entries by these shapes.
import type { SpotDecl } from "./resolve";

/** The routes `main` is keyed by (B's `MAIN_ROUTES`), plus the keys F's parts fill: `bot-editor` and `archive` (an
 *  entry may use any key; these are the ones the default shell opens). */
export const MAIN_ROUTES = ["bot", "agent", "settings", "plugins", "app", "bot-editor", "archive"] as const;

/** The message kinds `conversation.message` is keyed by (B's `MESSAGE_KINDS`). */
export const MESSAGE_KINDS = ["user", "bot", "tool", "approval", "question", "routine-result", "task-notification", "agent-report", "note"] as const;

/** The default panels, by key. `agent` is a bot's coding agent opened from its slim column (the owner's item 90). */
export const PANEL_KEYS = ["session", "terminal", "diff", "browser", "files", "agent"] as const;

export const SPOT_DECLS: Readonly<Record<string, SpotDecl & { declaredBy: string }>> = {
  "app.root": { shape: "single", declaredBy: "app" },
  "bot.tab": { shape: "keyed", declaredBy: "app" },
  sidebar: { shape: "single", declaredBy: "shell" },
  "sidebar.bot": { shape: "keyed", declaredBy: "sidebar" },
  "sidebar.app": { shape: "list", declaredBy: "sidebar" },
  main: { shape: "keyed", declaredBy: "shell" },
  panel: { shape: "keyed", declaredBy: "shell" },
  "panel.view": { shape: "keyed", declaredBy: "shell" },
  status: { shape: "list", declaredBy: "shell" },
  "settings.section": { shape: "list", declaredBy: "settings" },
  "bot.header": { shape: "single", declaredBy: "bot-tab" },
  "bot.header.action": { shape: "list", declaredBy: "bot-tab" },
  "bot.stage": { shape: "single", declaredBy: "bot-tab" },
  "bot.side": { shape: "single", declaredBy: "bot-tab" },
  conversation: { shape: "single", declaredBy: "bot-tab" },
  composer: { shape: "single", declaredBy: "bot-tab" },
  avatar: { shape: "keyed", declaredBy: "bot-stage" },
  "composer.action": { shape: "keyed", declaredBy: "composer" },
  "conversation.message": { shape: "keyed", declaredBy: "conversation", keep: ["approval"] },
  "conversation.message.extra": { shape: "list", declaredBy: "conversation" },
  "tool.result": { shape: "keyed", declaredBy: "conversation" },
  "menu.message": { shape: "list", declaredBy: "conversation" },
  "file.preview": { shape: "keyed", declaredBy: "file-view" },
};
