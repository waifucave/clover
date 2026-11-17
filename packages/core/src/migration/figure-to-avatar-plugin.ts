// The figure left the core for the bundled avatar plugin (`moss/character`, spec revision 19, G7): a bot's user layer no
// longer has an `avatar` field, and the core keeps no models of the person's own. What the person had goes with it, once:
//
//   * each model they imported (`user:<folder>/<entry>` in a bot's layer, its files under
//     `<home>/user-layers/avatars/<bot>/<folder>/`) is copied into the avatar plugin's own data folder,
//     `<home>/plugin-data/moss/character/shared/own/<bot>/<folder>/` (what it shares with its own pages: served to its layer
//     alone at `/_d/moss%2Fcharacter/own/…`), and listed in its
//     `ownModels` setting with its format and the person's credit note;
//   * the figure they chose becomes the plugin's `figure` setting: Alpha's when she had one, else the first bot's in
//     name order (an own model as `own:<format>:<path>`, any other file as `url:<file>`, matched to the pack that has it);
//   * the `avatar` field leaves each layer (a layer left empty is removed). The copied originals stay where they were.
//
// Every boot, under the lock, before anything reads them; in effect once (the field it moves is gone afterwards); a value
// the plugin's settings already hold is never overwritten; a link is never followed or copied; never throws.
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { userLayersDir } from "../bots/paths";
import { filePluginSettings } from "../plugin-host/api/settings";
import { pluginDataFolder } from "../plugin-host/paths";
import { removeFileDurably, writeJsonAtomic } from "../sessions/atomic-file";
import { botSegment } from "../sessions/ids";

export const AVATAR_PLUGIN = "moss/character";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const plainPart = (s: string) => s !== "" && s !== "." && s !== ".." && !s.startsWith(".") && !s.includes("\\") && !s.includes("\0");

interface OwnModel { name: string; format: string; file: string; credit?: string }

/** Copies `from` to `to` (a new folder), files and folders only: a link anywhere in it is left out. */
function copyPlain(from: string, to: string): void {
  const staging = `${to}.staging`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(join(staging, ".."), { recursive: true });
  cpSync(from, staging, { recursive: true, dereference: false, verbatimSymlinks: true, filter: (src) => !lstatSync(src).isSymbolicLink() });
  renameSync(staging, to);
}

/** Moves every layer's figure; the lines it logged, without the `migration: ` prefix. */
export function moveFigureToAvatarPlugin(home: string, o: { log?: (line: string) => void } = {}): string[] {
  const lines: string[] = [];
  try {
    let names: string[] = [];
    try {
      names = readdirSync(userLayersDir(home)).filter((n) => n.endsWith(".json")).sort();
    } catch {
      return lines;
    }
    const layers: { path: string; stored: { bot: string; fields: Record<string, unknown> } }[] = [];
    for (const n of names) {
      const path = join(userLayersDir(home), n);
      let stored: unknown;
      try {
        stored = JSON.parse(readFileSync(path, "utf8"));
      } catch {
        continue;
      }
      if (isObject(stored) && typeof stored.bot === "string" && isObject(stored.fields) && stored.fields.avatar !== undefined) layers.push({ path, stored: stored as (typeof layers)[number]["stored"] });
    }
    if (layers.length === 0) return lines;

    const store = filePluginSettings(home);
    const settings = store.read(AVATAR_PLUGIN);
    let own: OwnModel[] = [];
    try {
      const was = JSON.parse(typeof settings.account.ownModels === "string" ? settings.account.ownModels : "[]");
      if (Array.isArray(was)) own = was as OwnModel[];
    } catch {
      own = [];
    }
    const data = join(pluginDataFolder(home, AVATAR_PLUGIN), "shared");
    const picks = new Map<string, string>();

    for (const l of layers) {
      const bot = l.stored.bot;
      const av = l.stored.fields.avatar;
      if (isObject(av) && typeof av.file === "string" && typeof av.format === "string" && /^[a-z0-9-]{1,32}$/.test(av.format)) {
        const credit = typeof av.credit === "string" && av.credit !== "" ? av.credit.slice(0, 300) : undefined;
        if (av.file.startsWith("user:")) {
          const parts = av.file.slice(5).split("/");
          const seg = botSegment(bot);
          const from = join(userLayersDir(home), "avatars", seg, parts[0] ?? "");
          if (parts.length >= 2 && parts.every(plainPart) && existsSync(from) && !lstatSync(from).isSymbolicLink() && lstatSync(from).isDirectory()) {
            const rel = ["own", seg, ...parts].join("/");
            const to = join(data, "own", seg, parts[0]!);
            if (!existsSync(to)) copyPlain(from, to);
            if (!own.some((m) => m.file === rel)) own.push({ name: parts.at(-1)!.replace(/\.(model3\.json|json|vrm|glb)$/i, ""), format: av.format, file: rel, ...(credit !== undefined ? { credit } : {}) });
            picks.set(bot, `own:${av.format}:${rel}`);
            lines.push(`${bot}'s own figure (${av.format}) → ${AVATAR_PLUGIN}'s data folder, ${rel}`);
          } else {
            lines.push(`${bot}'s own figure was not found where MOSS kept it; it was left out`);
          }
        } else if (av.file !== "") {
          picks.set(bot, `url:${av.file}`);
        }
      }
      delete l.stored.fields.avatar;
    }

    // The figure shown: Alpha's, else the first bot's that had one; never over a pick already made.
    const pick = picks.get("alpha") ?? [...picks.values()][0];
    const account = settings.account;
    if (pick !== undefined && (typeof account.figure !== "string" || account.figure === "")) {
      account.figure = pick;
      lines.push(`the figure shown → ${AVATAR_PLUGIN}'s setting figure (${pick.split(":")[0]})`);
    }
    if (own.length > 0) account.ownModels = JSON.stringify(own);
    // The plugin's settings first: a crash between the two leaves the layers' fields, and the next boot moves them again
    // (never over what was already moved; a folder already copied is not copied again).
    store.write(AVATAR_PLUGIN, settings);
    for (const l of layers) {
      if (Object.keys(l.stored.fields).length === 0) removeFileDurably(l.path);
      else writeJsonAtomic(l.path, l.stored);
    }
  } catch (err) {
    o.log?.(`migration: moving the figure to the avatar plugin failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  for (const line of lines) o.log?.(`migration: ${line}`);
  return lines;
}
