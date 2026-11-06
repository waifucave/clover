// A local check of the manifests lane G ships (spec §5.9, `clover.json` format 1), until lane B's
// `clover plugin validate` exists. It checks the parts our manifests use, against the spec's types; it
// is not the registry's validator and refuses nothing the spec allows.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { checkTheme, isPluginPath } from "./theme";

const TOP_KEYS = new Set([
  "manifest", "id", "name", "version", "description", "icon", "author", "license", "homepage", "namespace",
  "engines", "platforms", "adult", "enabledByDefault", "scope", "onlyBackends", "host", "client", "helper",
  "capabilities", "settings", "auth", "addons", "contributes", "generated",
]);

const CORE_POINTS = new Set([
  "bot", "models", "mcpServers", "skills", "agents", "agentBackends", "hooks", "commands", "triggers", "voices",
  "computerProviders", "computer", "relays", "notifiers", "companions", "themes", "locales", "ui",
]);

const UI_KEYS = new Set(["spot", "id", "key", "order", "when", "component", "web", "style", "hide", "window", "declares"]);
const ID = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

export interface ManifestCheck {
  problems: string[];
  /** What the manifest says it is, worked out the way spec §5.3 does: data, web or code. */
  kind: "data" | "web" | "code";
}

function isText(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  return typeof value === "object" && value !== null && typeof (value as { en?: unknown }).en === "string";
}

/** The names a module exports, read from its source (enough for our own entries). */
export function exportedNames(source: string): Set<string> {
  const names = new Set<string>();
  for (const m of source.matchAll(/export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]!);
  for (const m of source.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1]!.split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name) names.add(name);
    }
  }
  return names;
}

function inside(folder: string, path: string): boolean {
  const full = resolve(folder, path);
  if (!existsSync(full)) return false;
  const rel = relative(realpathSync(folder), realpathSync(full));
  return !rel.startsWith("..") && !rel.startsWith("/");
}

/**
 * Checks `folder/clover.json`. `child` says the folder is a child plugin (spec §5.1): no `id`, no
 * `namespace`, and a `version` only its parent sets.
 */
export function checkManifest(folder: string, options: { child: boolean; folderName?: string }): ManifestCheck {
  const problems: string[] = [];
  const raw = JSON.parse(readFileSync(join(folder, "clover.json"), "utf8")) as Record<string, unknown>;
  for (const key of Object.keys(raw)) if (!TOP_KEYS.has(key)) problems.push(`unknown key "${key}"`);
  if (raw.manifest !== 1) problems.push(`"manifest" must be 1`);
  if (!isText(raw.name)) problems.push(`"name" is required`);
  if (options.child) {
    for (const key of ["id", "namespace", "version"]) if (key in raw) problems.push(`a child plugin has no "${key}"`);
  } else {
    if (typeof raw.id !== "string" || !ID.test(raw.id) || raw.id.length < 2 || raw.id.length > 40) problems.push(`"id" is not a plugin id`);
    if (options.folderName && raw.id !== options.folderName) problems.push(`"id" must equal the folder name`);
  }
  for (const key of ["icon"]) if (key in raw && !(isPluginPath(raw[key]) && inside(folder, raw[key] as string))) problems.push(`"${key}" is not a file inside the plugin`);

  const client = raw.client as { entry?: unknown } | undefined;
  const hasCode = Boolean(raw.host || raw.client || raw.helper);
  if (hasCode && typeof (raw.engines as { clover?: unknown } | undefined)?.clover !== "string") {
    problems.push(`a plugin with code needs "engines.clover"`);
  }
  let exports = new Set<string>();
  if (client !== undefined) {
    if (!isPluginPath(client.entry) || !inside(folder, client.entry)) problems.push(`"client.entry" is not a file inside the plugin`);
    else exports = exportedNames(readFileSync(join(folder, client.entry), "utf8"));
  }

  const contributes = (raw.contributes ?? {}) as Record<string, unknown>;
  let web = false;
  for (const [point, value] of Object.entries(contributes)) {
    if (!CORE_POINTS.has(point) && !point.includes(".")) problems.push(`contributes.${point} is not a point`);
    if (point === "themes") {
      for (const theme of value as { id?: unknown; file?: unknown }[]) {
        if (typeof theme.id !== "string" || !ID.test(theme.id)) problems.push(`a theme's id is not an id`);
        if (!isPluginPath(theme.file) || !inside(folder, theme.file)) {
          problems.push(`theme ${String(theme.id)}: its file is not inside the plugin`);
          continue;
        }
        // Its own tokens are `plugin.<top-level id>.…`: a child's top-level plugin is the folder it sits in.
        const plugin = options.child ? basename(dirname(resolve(folder))) : typeof raw.id === "string" ? raw.id : undefined;
        const themeProblems = checkTheme(JSON.parse(readFileSync(join(folder, theme.file), "utf8")), { strict: true, plugin });
        for (const p of themeProblems) problems.push(`theme ${String(theme.id)}: ${p}`);
      }
    }
    if (point === "ui") {
      const ids = new Set<string>();
      for (const entry of value as Record<string, unknown>[]) {
        if (typeof entry.spot !== "string" || entry.spot.length === 0) problems.push(`a ui entry needs a spot`);
        const id = (entry.id as string | undefined) ?? (entry.spot as string);
        if (ids.has(id)) problems.push(`two ui entries share the id ${id}`);
        ids.add(id);
        for (const key of Object.keys(entry)) if (!UI_KEYS.has(key) && typeof entry[key] === "object") problems.push(`ui ${id}: "${key}" is not a field of a ui entry`);
        const fills = ["component", "web", "style", "hide"].filter((k) => entry[k] !== undefined);
        if (fills.length !== 1) problems.push(`ui ${id}: an entry has exactly one of component, web, style or hide`);
        if (entry.component !== undefined && !exports.has(entry.component as string)) {
          problems.push(`ui ${id}: ${String(entry.component)} is not an export of client.entry`);
        }
        if (entry.web !== undefined) web = true;
      }
    }
  }
  return { problems, kind: hasCode ? "code" : web ? "web" : "data" };
}
