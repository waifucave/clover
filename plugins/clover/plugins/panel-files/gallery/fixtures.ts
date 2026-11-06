// A mocked code session's folder, as `files.list` would list it from the computer that holds it (lane B's
// `FileStat`, lane J's API).
import type { FileEntry } from "../client/types";

export const ROOT = "/Users/sam/projects/clover";
export const COMPUTER = "Studio";

const e = (folder: string, name: string, type: FileEntry["type"] = "file"): FileEntry => ({ path: `${folder}/${name}`, name, type });

export const LISTING: Record<string, FileEntry[]> = {
  [ROOT]: [e(ROOT, ".github", "dir"), e(ROOT, "docs", "dir"), e(ROOT, "packages", "dir"), e(ROOT, "plugins", "dir"), e(ROOT, "README.md"), e(ROOT, "package.json"), e(ROOT, ".gitignore")],
  [`${ROOT}/plugins`]: [e(`${ROOT}/plugins`, "clover", "dir")],
  [`${ROOT}/plugins/clover`]: ["composer", "conversation", "panel", "panel-diff", "panel-files", "panel-terminal", "settings", "shell", "sidebar"].map((n) => e(`${ROOT}/plugins/clover`, n, "dir")),
  [`${ROOT}/plugins/clover/panel`]: [e(`${ROOT}/plugins/clover/panel`, "client", "dir"), e(`${ROOT}/plugins/clover/panel`, "clover.json"), e(`${ROOT}/plugins/clover/panel`, "package.json")],
  [`${ROOT}/docs`]: [e(`${ROOT}/docs`, "clover-spec.md"), e(`${ROOT}/docs`, "clover-plan.md")],
};

export const OPEN_FILE = {
  path: `${ROOT}/plugins/clover/panel/clover.json`,
  text: '{\n  "manifest": 1,\n  "name": "Panel",\n  "description": "The right-hand panel: its toggles, the views it holds two at a time, and the session view.",\n  "engines": { "clover": "^1.0.0" },\n  "client": { "entry": "client/index.tsx" },\n  "capabilities": ["computers.read"]\n}',
};
