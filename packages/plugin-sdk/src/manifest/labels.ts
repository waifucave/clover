// The small labels a plugin shows for what it brings (the Plugins page's rows and detail, `clover plugin validate`'s
// report): derived from its contributions in this one place. A plugin is a box of things (spec §5.5): the labels name
// the things, never a kind of plugin, so no label says "plugin", "type" or "kind".

/** A `ui` spot's label, or none for spots a person wouldn't name (a composer button is not a thing to list). */
const UI_SPOT_LABELS: Readonly<Record<string, string>> = {
  "island.tab": "Island tab",
  "settings.section": "Settings section",
  "sidebar.app": "App page",
  avatar: "Avatar renderer",
  "pill.target": "Pill target",
  status: "Status line",
  "bot.editor.section": "Editor section",
  "file.preview": "File preview",
  "conversation.message": "Message look",
  "conversation.message.extra": "Message look",
  "conversation.message.action": "Message action",
  "tool.result": "Tool result look",
};

/** The stock right panels (the same list as `STOCK_PANEL_KEYS` in the spot catalog; kept here so the labels import nothing). */
const STOCK_PANELS: readonly string[] = ["session", "terminal", "diff", "browser", "files", "agent"];

/** The order the labels appear in, so a row reads the same everywhere. */
export const CONTRIBUTION_LABEL_ORDER = [
  "Bot", "Tools", "Skills", "Agent", "Agent backend", "Model", "Voice", "Theme", "Panel", "Island tab", "App page", "Pill target", "Settings section",
  "Editor section", "Status line", "Avatar renderer", "File preview", "Message look", "Message action", "Tool result look", "Commands", "Hooks",
  "Trigger", "Notifier", "Relay", "Companion", "Computer", "Translation",
] as const;

const nonEmpty = (v: unknown): boolean => (Array.isArray(v) ? v.length > 0 : v !== null && typeof v === "object" ? Object.keys(v).length > 0 : v !== undefined && v !== null && v !== false);

/** The labels for the contributions of these manifests (a plugin and, when wanted, its children), without repeats, in
 *  `CONTRIBUTION_LABEL_ORDER`. Anything unrecognised adds nothing. */
export function contributionLabels(manifests: readonly unknown[]): string[] {
  const found = new Set<string>();
  for (const manifest of manifests) {
    const c = (manifest as { contributes?: Record<string, unknown> } | null | undefined)?.contributes;
    if (c === undefined || c === null || typeof c !== "object") continue;
    if (nonEmpty(c.bot)) found.add("Bot");
    if (nonEmpty(c.mcpServers)) found.add("Tools");
    if (nonEmpty(c.skills)) found.add("Skills");
    if (nonEmpty(c.agents)) found.add("Agent");
    if (nonEmpty(c.agentBackends)) found.add("Agent backend");
    if (nonEmpty(c.models)) found.add("Model");
    if (nonEmpty(c.voices) || nonEmpty(c.voiceModes)) found.add("Voice");
    if (nonEmpty(c.themes)) found.add("Theme");
    if (nonEmpty(c.commands)) found.add("Commands");
    if (nonEmpty(c.hooks)) found.add("Hooks");
    if (nonEmpty(c.triggers)) found.add("Trigger");
    if (nonEmpty(c.notifiers)) found.add("Notifier");
    if (nonEmpty(c.relays)) found.add("Relay");
    if (nonEmpty(c.companions)) found.add("Companion");
    if (nonEmpty(c.computerProviders) || nonEmpty(c.computer)) found.add("Computer");
    if (nonEmpty(c.locales)) found.add("Translation");
    if (Array.isArray(c.ui)) {
      for (const e of c.ui) {
        const spot = (e as { spot?: unknown } | null)?.spot;
        // A `panel` entry with a key that isn't a stock panel's adds a panel of its own.
        const key = (e as { key?: unknown } | null)?.key;
        if (spot === "panel" && typeof key === "string" && !STOCK_PANELS.includes(key)) found.add("Panel");
        const label = typeof spot === "string" ? UI_SPOT_LABELS[spot] : undefined;
        if (label !== undefined) found.add(label);
      }
    }
  }
  return CONTRIBUTION_LABEL_ORDER.filter((l) => found.has(l));
}
