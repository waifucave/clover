// What only the user's own settings can add to the persistence list (`autoRunPaths`, contracts/fence.ts): where git's
// templates and hooks are (`init.templateDir`, `core.hooksPath` in the global config), `$ZDOTDIR` and
// `$PYTHONSTARTUP`, and on Windows the Documents known folder, which OneDrive moves (and with it the PowerShell
// profiles). Read once per home and kept for the process: a change shows at the daemon's next start.
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { join, posix, win32 } from "node:path";
import type { Os } from "@waifucave/clover-protocol";
import type { RunLaterExtras } from "../contracts/fence";

export interface RunLaterSources {
  env: Readonly<Record<string, string | undefined>>;
  /** A file's text, or undefined when it can't be read. */
  read(path: string): string | undefined;
  /** Windows: the `User Shell Folders` value named `Personal` (the Documents folder), unexpanded; undefined if none. */
  documentsValue?(): string | undefined;
}

/** git's directories a global config names: `init.templateDir` and `core.hooksPath` (absolute, or under `~/`). A
 *  relative `hooksPath` is each repository's own and isn't a place under the home. */
export function gitConfiguredDirs(text: string, os: Os, home: string): string[] {
  const p = os === "windows" ? win32 : posix;
  const out: string[] = [];
  let section = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)[#;].*$/, "").trim();
    const head = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"[^"]*")?\s*\]$/.exec(line);
    if (head) { section = head[1]!.toLowerCase(); continue; }
    const kv = /^([A-Za-z][A-Za-z0-9-]*)\s*=\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = `${section}.${kv[1]!.toLowerCase()}`;
    if (key !== "init.templatedir" && key !== "core.hookspath") continue;
    let v = kv[2]!.trim().replace(/^"(.*)"$/, "$1");
    if (v.startsWith("~/") || v.startsWith("~\\")) v = p.join(home, v.slice(2));
    if (v.length > 0 && p.isAbsolute(v)) out.push(p.normalize(v));
  }
  return out;
}

/** The files a git config text includes (`[include] path`, and `[includeIf …] path` whatever its condition: holding
 *  more is the safe side), each absolute: `~/` expands, a relative path is the including file's folder's. */
export function gitIncludedFiles(text: string, os: Os, home: string, baseDir: string): string[] {
  const p = os === "windows" ? win32 : posix;
  const out: string[] = [];
  let section = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)[#;].*$/, "").trim();
    const head = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"[^"]*")?\s*\]$/.exec(line);
    if (head) { section = head[1]!.toLowerCase(); continue; }
    if (section !== "include" && section !== "includeif") continue;
    const kv = /^path\s*=\s*(.*)$/i.exec(line);
    if (!kv) continue;
    let v = kv[1]!.trim().replace(/^"(.*)"$/, "$1");
    if (v.startsWith("~/") || v.startsWith("~\\")) v = p.join(home, v.slice(2));
    else if (v.length > 0 && !p.isAbsolute(v)) v = p.join(baseDir, v);
    if (v.length > 0) out.push(p.normalize(v));
  }
  return out;
}

/** git's directories the global config names, following its includes (git's own depth limit, 10; each file once). */
export function gitConfiguredDirsDeep(files: readonly string[], os: Os, home: string, read: (path: string) => string | undefined): string[] {
  const p = os === "windows" ? win32 : posix;
  const seen = new Set<string>();
  const dirs: string[] = [];
  const visit = (file: string, depth: number) => {
    if (depth > 10 || seen.has(file)) return;
    seen.add(file);
    const text = read(file);
    if (text === undefined) return;
    dirs.push(...gitConfiguredDirs(text, os, home));
    for (const inc of gitIncludedFiles(text, os, home, p.dirname(file))) visit(inc, depth + 1);
  };
  for (const f of files) visit(f, 0);
  return [...new Set(dirs)];
}

/** `%NAME%` expanded from `env` (Windows names are case-insensitive); undefined if a name has no value. */
export function expandWindowsEnv(value: string, env: Readonly<Record<string, string | undefined>>): string | undefined {
  let missing = false;
  const out = value.replace(/%([^%]+)%/g, (_, name: string) => {
    const hit = Object.entries(env).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
    if (hit === undefined) missing = true;
    return hit ?? "";
  });
  return missing ? undefined : out;
}

/** The extras for `home` on `os`, from `sources`. */
export function runLaterExtrasFrom(os: Os, home: string, sources: RunLaterSources): RunLaterExtras {
  const p = os === "windows" ? win32 : posix;
  const xdg = sources.env.XDG_CONFIG_HOME;
  const gitFiles = [p.join(home, ".gitconfig"), p.join(xdg && p.isAbsolute(xdg) ? xdg : p.join(home, ".config"), "git", "config")];
  const gitDirs = gitConfiguredDirsDeep(gitFiles, os, home, sources.read);
  const envPaths: string[] = [], envFiles: string[] = [];
  for (const [name, into] of [["ZDOTDIR", envPaths], ["PYTHONSTARTUP", envFiles]] as const) {
    const v = sources.env[name];
    if (v && p.isAbsolute(v) && p.normalize(v) !== p.normalize(home)) into.push(p.normalize(v));
  }
  let documents: string | undefined;
  if (os === "windows") {
    const raw = sources.documentsValue?.();
    const expanded = raw === undefined ? undefined : expandWindowsEnv(raw, sources.env);
    if (expanded !== undefined && win32.isAbsolute(expanded)) documents = win32.normalize(expanded).replace(/\\+$/, "");
  }
  return { gitDirs, envPaths, envFiles, ...(documents === undefined ? {} : { documents }) };
}

/** Parses `reg query … /v Personal`'s output: the value after its type. */
export function parseRegValue(output: string, name: string): string | undefined {
  for (const line of output.split(/\r?\n/)) {
    const m = new RegExp(`^\\s*${name}\\s+REG_(?:EXPAND_)?SZ\\s+(.+?)\\s*$`, "i").exec(line);
    if (m) return m[1];
  }
  return undefined;
}

const cache = new Map<string, RunLaterExtras>();

/** This computer's extras for `home` (this process's environment, the real files and registry), kept per home. */
export function runLaterExtras(os: Os, home: string): RunLaterExtras {
  const key = `${os}\0${home}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const extras = runLaterExtrasFrom(os, home, {
    env: process.env,
    // Never through a link (the fence's own rule for the global git config: a planted link must not choose what is
    // fenced): a regular file, or nothing.
    read: (f) => { try { return lstatSync(f).isFile() ? readFileSync(f, "utf8") : undefined; } catch { return undefined; } },
    documentsValue: () => {
      if (process.platform !== "win32") return undefined;
      try {
        const r = spawnSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "reg.exe"),
          ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders", "/v", "Personal"],
          { encoding: "utf8", windowsHide: true, timeout: 5000 });
        return r.status === 0 ? parseRegValue(r.stdout, "Personal") : undefined;
      } catch { return undefined; }
    },
  });
  cache.set(key, extras);
  return extras;
}

/** Test seam: forget what was read. */
export function __resetRunLaterExtrasForTests(): void { cache.clear(); }

