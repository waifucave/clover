// What in a plugin with a bot is inside the bot and what is beside it (spec §5.5, the owner's rule of November 14:
// "whoever owns a plug sets the rules for what plugs into it"). A plugin is a box of things, and each thing follows the
// rules of what it plugs into:
//
// * A `ui` entry (a `bot.tab` layout patch included) and a `locales` table are inside the bot unless they say
//   `"app": true`: inside, they fill only what Bots offers, on that bot's tab; beside, they follow the app's rules.
// * A tool server, a hook, a skill, an agent definition and a command are inside when their scope is `own-bot` (their
//   own, else their plugin's, else their top plugin's): that bot alone, its side threads and the agents it starts.
//   Any other scope is beside: every bot and coding agent the scope says, as usual.
// * An entry on a point another plugin declares (`island.line`, `avatar.formats`) is beside: that plug's owner sets its
//   rules, and it isn't the bot's tab. One on a point of the bot's own tree (`<its id>.…`) is inside.
// * Themes are neither: the one `bot.theme` names applies on the bot's tab, and every theme stays one the user can pick.
//
// Every part beside the bot has one switch of its own (the registry's `appParts`), so the user can keep the bot and turn
// the rest off. A plugin that holds no bot has no inside and no switch: everything it adds is the app's already.
// Pure: the validator, the OK card's lines, the registry's rules and its change check all read it.

/** A part of a plugin with a bot: where its entry is (`point`, the registry's `ref`), a key that stays the same when
 *  the manifest's lists are reordered (`key`), and what it is (`kind`: a `ui` entry's spot, else its point). */
export interface PluginPart {
  point: string;
  ref: string;
  key: string;
  kind: string;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const contributesOf = (m: unknown): Obj | undefined => (isObj(m) && isObj(m.contributes) ? m.contributes : undefined);

/** Whether a manifest holds a bot (`contributes.bot`). */
export function holdsBot(manifest: unknown): boolean {
  return contributesOf(manifest)?.bot !== undefined;
}

/** A `skills` item's glob and its own scope (an item is a glob, or `{ path, scope }`); undefined for neither. */
export function skillItem(v: unknown): { path: string; scope?: string } | undefined {
  if (typeof v === "string") return { path: v };
  if (isObj(v) && typeof v.path === "string") return { path: v.path, ...(typeof v.scope === "string" ? { scope: v.scope } : {}) };
  return undefined;
}

/** The scope a part takes: its own, else its plugin's (`manifest.scope`), else its top plugin's, else `both`. */
export function partScopeOf(entryScope: unknown, manifest: unknown, top?: unknown): string {
  const own = (m: unknown) => (isObj(m) && typeof m.scope === "string" ? m.scope : undefined);
  return (typeof entryScope === "string" ? entryScope : undefined) ?? own(manifest) ?? own(top) ?? "both";
}

/** Every part of a plugin that holds a bot, inside the bot and beside it; both empty for a plugin that holds none.
 *  `top` is the top plugin's manifest when `manifest` is a child's (its scope is the default's last step). */
export function pluginParts(manifest: unknown, top?: unknown): { inside: PluginPart[]; beside: PluginPart[] } {
  const inside: PluginPart[] = [];
  const beside: PluginPart[] = [];
  const c = contributesOf(manifest);
  if (c === undefined || c.bot === undefined) return { inside, beside };
  const put = (isBeside: boolean, part: PluginPart) => (isBeside ? beside : inside).push(part);
  const scoped = (entryScope: unknown) => partScopeOf(entryScope, manifest, top) !== "own-bot";
  if (Array.isArray(c.ui)) {
    c.ui.forEach((e, i) => {
      if (!isObj(e) || typeof e.spot !== "string") return;
      put(e.app === true, { point: "ui", ref: `ui/${i}`, key: `ui:${e.spot}#${typeof e.id === "string" ? e.id : e.spot}${typeof e.key === "string" ? `[${e.key}]` : ""}`, kind: e.spot });
    });
  }
  if (Array.isArray(c.locales)) {
    c.locales.forEach((e, i) => {
      if (!isObj(e)) return;
      put(e.app === true, { point: "locales", ref: `locales/${i}`, key: `locales:${String(e.lang)}`, kind: "locales" });
    });
  }
  if (isObj(c.mcpServers)) {
    for (const [name, s] of Object.entries(c.mcpServers)) put(scoped(isObj(s) ? s.scope : undefined), { point: "mcpServers", ref: `mcpServers/${name}`, key: `mcpServers:${name}`, kind: "mcpServers" });
  }
  if (Array.isArray(c.skills)) {
    c.skills.forEach((e, i) => {
      const item = skillItem(e);
      if (item === undefined) return;
      put(scoped(item.scope), { point: "skills", ref: `skills/${i}`, key: `skills:${item.path}`, kind: "skills" });
    });
  }
  if (Array.isArray(c.agents)) {
    c.agents.forEach((e, i) => {
      const id = typeof e === "string" ? e : isObj(e) && typeof e.id === "string" ? e.id : undefined;
      if (id === undefined) return;
      put(scoped(isObj(e) ? e.scope : undefined), { point: "agents", ref: `agents/${i}`, key: `agents:${id}`, kind: "agents" });
    });
  }
  if (Array.isArray(c.hooks)) {
    c.hooks.forEach((e, i) => {
      if (!isObj(e)) return;
      put(scoped(e.scope), { point: "hooks", ref: `hooks/${i}`, key: `hooks:${typeof e.id === "string" ? e.id : i}`, kind: "hooks" });
    });
  }
  if (Array.isArray(c.commands)) {
    c.commands.forEach((e, i) => {
      if (!isObj(e) || typeof e.name !== "string") return;
      put(scoped(e.scope), { point: "commands", ref: `commands/${i}`, key: `commands:${e.name}`, kind: "commands" });
    });
  }
  // An entry on a point another plugin declares (`island.line`, `avatar.formats`): that plug's owner sets its rules, and
  // it isn't the bot's tab, so it is beside the bot. A point of the bot's own tree (`<its id or namespace>.…`) is inside.
  const ownIds = [top, manifest].flatMap((m) => (isObj(m) ? [m.namespace, m.id] : [])).filter((v): v is string => typeof v === "string");
  for (const [point, raw] of Object.entries(c)) {
    if (!point.includes(".")) continue;
    const own = ownIds.some((p) => point.startsWith(`${p}.`));
    const list = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
    list.forEach((e, i) => {
      const id = isObj(e) && typeof e.id === "string" ? e.id : String(i);
      put(!own, { point, ref: Array.isArray(raw) ? `${point}/${i}` : point, key: `${point}:${id}`, kind: point });
    });
  }
  return { inside, beside };
}

/** The registry refs of a plugin's parts beside its bot (`pluginParts(…).beside`), for the switch. */
export function besideRefs(manifest: unknown, top?: unknown): Set<string> {
  return new Set(pluginParts(manifest, top).beside.map((p) => p.ref));
}

/** Whether a plugin with a bot says outright that it brings parts beside it: an `"app": true` entry. */
export function marksAppParts(manifest: unknown): boolean {
  const c = contributesOf(manifest);
  if (c === undefined || c.bot === undefined) return false;
  const marked = (list: unknown) => Array.isArray(list) && list.some((e) => isObj(e) && e.app === true);
  return marked(c.ui) || marked(c.locales);
}
