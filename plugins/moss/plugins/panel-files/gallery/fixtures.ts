// A mocked coding session's folder, by its tree path, as `files.list` would list it: the computer that holds it serves
// it over the link, behind its own fence (lane B's `FileStat`, lane J's tree; no mounts).
import type { FileEntry } from "../client/types";

export const ROOT = "home/Studio/projects/moss";
export const COMPUTER = "Studio";

const e = (folder: string, name: string, type: FileEntry["type"] = "file"): FileEntry => ({ path: `${folder}/${name}`, name, type });

export const LISTING: Record<string, FileEntry[]> = {
  [ROOT]: [e(ROOT, ".github", "dir"), e(ROOT, "docs", "dir"), e(ROOT, "packages", "dir"), e(ROOT, "plugins", "dir"), e(ROOT, "README.md"), e(ROOT, "package.json"), e(ROOT, ".gitignore")],
  [`${ROOT}/plugins`]: [e(`${ROOT}/plugins`, "moss", "dir")],
  [`${ROOT}/plugins/moss`]: ["composer", "conversation", "panel", "panel-diff", "panel-files", "panel-terminal", "settings", "shell", "sidebar"].map((n) => e(`${ROOT}/plugins/moss`, n, "dir")),
  [`${ROOT}/plugins/moss/panel`]: [e(`${ROOT}/plugins/moss/panel`, "client", "dir"), e(`${ROOT}/plugins/moss/panel`, "moss.json"), e(`${ROOT}/plugins/moss/panel`, "package.json")],
  [`${ROOT}/docs`]: [e(`${ROOT}/docs`, "moss-spec.md"), e(`${ROOT}/docs`, "moss-plan.md")],
};

export const OPEN_FILE = {
  path: `${ROOT}/plugins/moss/panel/moss.json`,
  text: '{\n  "manifest": 1,\n  "name": "Panel",\n  "description": "The right-hand panel: its toggles, the views it holds two at a time, and the session view.",\n  "engines": { "moss": "^1.0.0" },\n  "client": { "entry": "client/index.tsx" },\n  "capabilities": ["computers.read"]\n}',
};
