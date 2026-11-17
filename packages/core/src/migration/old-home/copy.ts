// The one-time COPY of the old install's home into this one (spec §12, item 125; the controller's rulings 1, 3 to 6).
//
// The old home is only ever READ: every file is opened read-only without following a link, no SQLite database is opened
// where it lies (SQLite would make a `-shm` there), its lock is never taken, and nothing there is written, renamed or
// deleted. The copy goes to `<home>/migration/old-home/staging/` and is marked whole only at the end
// (`staging.complete.json`); the next start swaps it in (`swap.ts`). A copy cut short leaves the home as it was, and
// the next start offers the copy again.
//
// What comes over, and how (`names.ts` holds the table of what is renamed):
//   * every file and folder of the old home, as it is, but for what is left out below;
//   * each SQLite database (any file that starts with SQLite's header): its file and its write-ahead log are copied
//     raw into a scratch folder in THIS home, opened there, and written to the staging folder with `VACUUM INTO`, so the
//     staged database is one consistent file holding what was committed (never a raw file beside a live WAL);
//   * the record stores (settings, levels, trust, connectors, user layers, the runtime home's config) with each stored
//     old-root plugin id and old standing-server tool name mapped; the saved "always" rules re-hashed where the
//     display string proves the key;
//   * the third-party plugins in `plugins/`, through the rename's content map (`PLUGIN_CONTENT_MAP`): their trees change,
//     so each asks for its OK again on the normal card;
//   * the old home's own path, wherever a record or a database stores it, as this home's path, so nothing copied leads
//     back into the old home; past conversations, transcripts and memory are copied as they are;
//   * links: one into the old home points at the same place in this home; one that leads anywhere else is left out.
//
// Left out: the old engine's run files, logs, caches, binaries, its login item and update state (`run/`, `logs/`,
// `cache/`, `bin/`, `login/`, `update/`, `install.json`); its secret store's index and its device registry (the secrets
// and the device key are in the old Keychain, which MOSS never reads: `left-behind.ts` names what to set up again);
// its plugin registry's signed records (carried instead, `carry.ts`); its runtimes folder but for `runtime-state.db`;
// its migration records but for Migration C's layout mark.
import { Database } from "bun:sqlite";
import {
  chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, readSync,
  realpathSync, rmSync, symlinkSync, writeFileSync, writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ruleDisplay, ruleKeyHash } from "../../approvals/strings";
import { writeJsonAtomic } from "../../sessions/atomic-file";
import { carryFromOldRegistry, type RegistryCarry } from "./carry";
import { leftBehindFrom, type LeftBehind } from "./left-behind";
import { mapHomePath, mapPluginText, mapStoredString, mapToolName, OLD_SDK_CONFIG, pluginPathMap } from "./names";
import { oldHomePaths } from "./paths";

/** The old engine is running on its home: nothing is copied (ruling 3). */
export class OldEngineRunning extends Error {
  readonly code = "old_engine_running";
  constructor(readonly how: string) {
    super(`the old engine is running on its home (${how}): quit it first`);
    this.name = "OldEngineRunning";
  }
}

export interface CopyOptions {
  oldHome: string;
  home: string;
  /** Asked before the copy starts and again when it is done (`alive.ts`). */
  alive: () => Promise<{ alive: boolean; how?: string }>;
  log?: (line: string) => void;
  now?: () => number;
  /** A test seam: called after each file is staged, to cut a copy short. */
  afterFile?: (rel: string) => void;
}

export interface CopyReport {
  v: 1;
  from: string;
  at: number;
  files: number;
  bytes: number;
  databases: string[];
  renamed: { from: string; to: string }[];
  mappedRecords: string[];
  rehashedRules: number;
  plugins: string[];
  linksPointedHere: string[];
  linksLeftOut: string[];
  leftOut: string[];
  /** Files whose stored copies of the old home's path now name this home. */
  pathsRewritten: string[];
}

/** Top-level entries of the old home that never travel (see the file's header). */
export const LEFT_OUT_TOP: readonly string[] = ["run", "logs", "cache", "bin", "login", "update", "install.json", "credentials", "devices", "plugins-state"];
/** The one file of `runtimes/` and the marks of `migration/` that do travel. */
const KEPT_UNDER: Readonly<Record<string, readonly string[]>> = {
  runtimes: ["runtimes/runtime-state.db"],
  migration: ["migration/c/CURRENT_LAYOUT", "migration/c/COMPLETE"],
};

/** The record stores whose stored ids and tool names are mapped (`mapStoredString`). */
const RECORD_STORES: readonly string[] = ["settings.json", "settings/", "levels/", "trust/", "connectors/", "user-layers/", `sdk/${OLD_SDK_CONFIG}`];
/** History and memory, copied as they are: the old home's path inside them is left as it was written. */
const AS_WRITTEN: readonly RegExp[] = [/^sessions\/.*\.jsonl$/, /^transcripts\//, /^memory\//, /^bots\/[^/]+\/memory\//, /^sdk\/projects\/.*\.jsonl$/, /^audit\.jsonl$/];
/** Files read as text for the path rewrite and the record mapping, by extension. */
const TEXT_EXT = /\.(?:json|jsonl|md|txt|toml|ya?ml|ini|conf)$/i;
/** A plugin's source files the content map applies to, by extension. */
const PLUGIN_TEXT_EXT = /\.(?:[cm]?[jt]sx?|json|css|html?)$/i;
/** The largest file read as text (larger ones are copied as they are). */
const TEXT_MAX = 64 * 1024 * 1024;
const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "latin1");
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;

/** Reads a file of the old home: opened read-only, never following a link; `undefined` when it is no regular file. */
function readOld(path: string, max = Number.MAX_SAFE_INTEGER): Buffer | undefined {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | NO_FOLLOW);
  } catch {
    return undefined;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > max) return undefined;
    const buf = Buffer.alloc(st.size);
    let n = 0;
    while (n < buf.length) {
      const got = readSync(fd, buf, n, buf.length - n, null);
      if (got === 0) break;
      n += got;
    }
    return n === buf.length ? buf : buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

/** Copies a file of the old home with plain reads (read-only, no link followed) into a new file. */
function copyOld(from: string, to: string, mode: number): number {
  const fd = openSync(from, constants.O_RDONLY | NO_FOLLOW);
  let bytes = 0;
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`${from} isn't a file`);
    mkdirSync(dirname(to), { recursive: true });
    const out = openSync(to, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW, 0o600);
    try {
      const buf = Buffer.alloc(1024 * 1024);
      for (;;) {
        const n = readSync(fd, buf, 0, buf.length, null);
        if (n === 0) break;
        let off = 0;
        while (off < n) off += writeSync(out, buf, off, n - off);
        bytes += n;
      }
    } finally {
      closeSync(out);
    }
  } finally {
    closeSync(fd);
  }
  if (process.platform !== "win32") chmodSync(to, mode & 0o777);
  return bytes;
}

function isSqlite(path: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | NO_FOLLOW);
  } catch {
    return false;
  }
  try {
    const head = Buffer.alloc(16);
    return readSync(fd, head, 0, 16, 0) === 16 && head.equals(SQLITE_HEADER);
  } finally {
    closeSync(fd);
  }
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Every spelling of the old home's path a record may hold, longest first. */
function oldHomeSpellings(oldHome: string): string[] {
  const out = new Set([resolve(oldHome)]);
  try {
    out.add(realpathSync(oldHome));
  } catch {
    /* the copy fails on its own below */
  }
  return [...out].sort((a, b) => b.length - a.length);
}

/** `text` with the old home's path (as a whole path, or a path's start) as this home's. */
function rewriteHomePath(text: string, olds: readonly string[], home: string): string {
  let out = text;
  for (const old of olds) out = out.replace(new RegExp(`${escapeRe(old)}(?=$|[\\\\/"'\\s,;:)\\]}])`, "g"), home);
  return out;
}

/** A JSON value with every key and string mapped (`mapStoredString`); `changed` says whether any was. */
function mapJson(value: unknown, changed: { v: boolean }): unknown {
  if (typeof value === "string") {
    const m = mapStoredString(value);
    if (m !== value) changed.v = true;
    return m;
  }
  if (Array.isArray(value)) return value.map((v) => mapJson(v, changed));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const mk = mapStoredString(k);
      if (mk !== k) changed.v = true;
      out[mk] = mapJson(v, changed);
    }
    return out;
  }
  return value;
}

/** The saved rules with each rule whose display string IS its key (its hash proves it) re-keyed through
 *  `mapToolName`; any other rule as it is. */
export function mapSavedRules(text: string): { text: string; rehashed: number } {
  let doc: { version?: unknown; rules?: unknown };
  try {
    doc = JSON.parse(text) as typeof doc;
  } catch {
    return { text, rehashed: 0 };
  }
  if (!Array.isArray(doc.rules)) return { text, rehashed: 0 };
  let rehashed = 0;
  const rules = doc.rules.map((r: unknown) => {
    const rule = r as { keyHash?: unknown; display?: unknown } | null;
    if (rule === null || typeof rule !== "object" || typeof rule.keyHash !== "string" || typeof rule.display !== "string") return r;
    const key = rule.display;
    const mapped = mapToolName(key);
    if (mapped === key || ruleKeyHash(key) !== rule.keyHash) return r;
    rehashed++;
    return { ...rule, keyHash: ruleKeyHash(mapped), display: ruleDisplay(mapped) };
  });
  return rehashed === 0 ? { text, rehashed } : { text: `${JSON.stringify({ ...doc, rules }, null, 2)}\n`, rehashed };
}

const inside = (path: string, root: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
const posixRel = (p: string) => p.split(sep).join("/");

/** Makes the staged copy (see the file's header). Throws `OldEngineRunning` when the old engine runs, before or after;
 *  any other failure throws too, and in both cases the staging folder is removed. */
export async function copyOldHome(o: CopyOptions): Promise<CopyReport> {
  const log = o.log ?? (() => {});
  const p = oldHomePaths(o.home);
  const before = await o.alive();
  if (before.alive) throw new OldEngineRunning(before.how ?? "it answers");
  const oldRoot = realpathSync(o.oldHome);
  if (!lstatSync(oldRoot).isDirectory()) throw new Error(`${o.oldHome} isn't a folder`);
  const home = resolve(o.home);
  if (inside(home, oldRoot) || inside(oldRoot, home)) throw new Error("the old home and this home hold each other");
  const olds = oldHomeSpellings(o.oldHome);
  const report: CopyReport = {
    v: 1, from: o.oldHome, at: (o.now ?? Date.now)(), files: 0, bytes: 0, databases: [], renamed: [], mappedRecords: [], rehashedRules: 0, plugins: [],
    linksPointedHere: [], linksLeftOut: [], leftOut: [], pathsRewritten: [],
  };
  rmSync(p.staging, { recursive: true, force: true });
  rmSync(p.scratch, { recursive: true, force: true });
  rmSync(p.complete, { force: true });
  mkdirSync(p.staging, { recursive: true, mode: 0o700 });
  mkdirSync(p.scratch, { recursive: true, mode: 0o700 });
  try {
    const stageFile = (rel: string, data: Buffer | string, mode: number) => {
      const to = join(p.staging, ...rel.split("/"));
      mkdirSync(dirname(to), { recursive: true });
      writeFileSync(to, data, { mode: 0o600, flag: "wx" });
      if (process.platform !== "win32") chmodSync(to, mode & 0o777);
    };
    const pluginTop = (rel: string): string | undefined => {
      const parts = rel.split("/");
      return parts[0] === "plugins" && parts.length >= 3 && !parts[1]!.startsWith(".") ? parts[1] : undefined;
    };
    const copyDb = (src: string, rel: string, to: string) => {
      const scratchDb = join(p.scratch, `${report.databases.length}.db`);
      copyOld(src, scratchDb, 0o600);
      // Its write-ahead log (what was committed since the last checkpoint), or a rollback journal left by a cut-short
      // write (SQLite rolls it back on open): read from the scratch copies, never where they lie.
      for (const side of ["-wal", "-journal"]) if (existsSync(`${src}${side}`) && lstatSync(`${src}${side}`).isFile()) copyOld(`${src}${side}`, `${scratchDb}${side}`, 0o600);
      const target = join(p.staging, ...to.split("/"));
      mkdirSync(dirname(target), { recursive: true });
      const db = new Database(scratchDb);
      try {
        db.run("VACUUM INTO ?", [target]);
      } finally {
        db.close();
      }
      const staged = new Database(target);
      try {
        const tables = staged.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
        for (const { name } of tables) {
          const cols = staged.query(`PRAGMA table_info("${name.replace(/"/g, '""')}")`).all() as { name: string }[];
          for (const c of cols) {
            const t = `"${name.replace(/"/g, '""')}"`, col = `"${c.name.replace(/"/g, '""')}"`;
            for (const old of olds) {
              try {
                const r = staged.run(`UPDATE ${t} SET ${col} = ? || substr(${col}, ?) WHERE typeof(${col}) = 'text' AND (${col} = ? OR substr(${col}, 1, ?) = ?)`, [home, old.length + 1, old, old.length + 1, `${old}/`]);
                if (r.changes > 0 && !report.pathsRewritten.includes(rel)) report.pathsRewritten.push(rel);
              } catch {
                // A virtual table's or a constrained column: left as it is.
              }
            }
          }
        }
        const ok = staged.query("PRAGMA quick_check").get() as Record<string, unknown> | null;
        if (ok === null || Object.values(ok)[0] !== "ok") throw new Error(`the copy of ${rel} doesn't check`);
      } finally {
        staged.close();
      }
      if (process.platform !== "win32") chmodSync(target, 0o600);
      rmSync(scratchDb, { force: true });
      rmSync(`${scratchDb}-wal`, { force: true });
      rmSync(`${scratchDb}-shm`, { force: true });
      rmSync(`${scratchDb}-journal`, { force: true });
      report.databases.push(to);
    };
    // The engine answers its clients while a large home copies: the walk lets the event loop run every few files.
    let sinceYield = 0;
    const breathe = async () => {
      if (++sinceYield < 32) return;
      sinceYield = 0;
      await new Promise((r) => setImmediate(r));
    };
    const walk = async (relDir: string): Promise<void> => {
      const dirAbs = relDir === "" ? oldRoot : join(oldRoot, ...relDir.split("/"));
      for (const name of readdirSync(dirAbs).sort()) {
        const rel = relDir === "" ? name : `${relDir}/${name}`;
        const top = rel.split("/")[0]!;
        if (relDir === "" && LEFT_OUT_TOP.includes(name)) {
          report.leftOut.push(name);
          continue;
        }
        const keep = KEPT_UNDER[top];
        if (keep !== undefined && !keep.some((k) => k === rel || k.startsWith(`${rel}/`))) {
          if (relDir === "" || !report.leftOut.includes(top)) report.leftOut.push(relDir === "" ? name : top);
          continue;
        }
        if (relDir === "plugins" && name.startsWith(".")) {
          report.leftOut.push(rel);
          continue;
        }
        const abs = join(dirAbs, name);
        const st = lstatSync(abs);
        const top2 = pluginTop(rel);
        const to = top2 !== undefined ? pluginPathMap(rel) : mapHomePath(rel);
        if (to !== rel) report.renamed.push({ from: rel, to });
        if (st.isSymbolicLink()) {
          const target = readlinkSync(abs);
          const resolved = isAbsolute(target) ? resolve(target) : resolve(dirname(abs), target);
          const into = olds.find((old) => inside(resolved, old)) ?? (inside(resolved, oldRoot) ? oldRoot : undefined);
          if (into === undefined) {
            report.linksLeftOut.push(rel);
            continue;
          }
          const targetRel = posixRel(relative(into, resolved));
          const mappedTarget = targetRel === "" ? home : join(home, ...mapHomePath(targetRel).split("/"));
          const linkAt = join(p.staging, ...to.split("/"));
          mkdirSync(dirname(linkAt), { recursive: true });
          // Relative when it was, pointing where the same place is in this home once swapped in.
          const finalAt = join(home, ...to.split("/"));
          symlinkSync(isAbsolute(target) ? mappedTarget : relative(dirname(finalAt), mappedTarget) || ".", linkAt);
          report.linksPointedHere.push(rel);
          continue;
        }
        if (st.isDirectory()) {
          mkdirSync(join(p.staging, ...to.split("/")), { recursive: true });
          if (process.platform !== "win32") chmodSync(join(p.staging, ...to.split("/")), (st.mode & 0o777) | 0o700);
          await walk(rel);
          continue;
        }
        if (!st.isFile()) continue; // a socket or a pipe: never copied
        await breathe();
        // A database's own sidecars travel inside it (`VACUUM INTO`).
        if (/-(?:wal|shm|journal)$/.test(name) && existsSync(abs.replace(/-(?:wal|shm|journal)$/, "")) && isSqlite(abs.replace(/-(?:wal|shm|journal)$/, ""))) continue;
        if (isSqlite(abs)) {
          copyDb(abs, rel, to);
          report.files++;
          o.afterFile?.(rel);
          continue;
        }
        if (top2 !== undefined) {
          const inModules = rel.split("/").includes("node_modules");
          if (!report.plugins.includes(top2)) report.plugins.push(top2);
          if (!inModules && PLUGIN_TEXT_EXT.test(name) && st.size <= TEXT_MAX) {
            const text = readOld(abs, TEXT_MAX);
            if (text !== undefined) {
              stageFile(to, mapPluginText(text.toString("utf8")), st.mode);
              report.files++;
              report.bytes += st.size;
              o.afterFile?.(rel);
              continue;
            }
          }
          report.bytes += copyOld(abs, join(p.staging, ...to.split("/")), st.mode);
          report.files++;
          o.afterFile?.(rel);
          continue;
        }
        if (TEXT_EXT.test(name) && st.size <= TEXT_MAX) {
          const raw = readOld(abs, TEXT_MAX);
          if (raw !== undefined && !raw.subarray(0, 8192).includes(0)) {
            let text = raw.toString("utf8");
            if (!AS_WRITTEN.some((re) => re.test(rel))) {
              const pathed = rewriteHomePath(text, olds, home);
              if (pathed !== text) report.pathsRewritten.push(rel);
              text = pathed;
            }
            if (rel === "rules/saved-rules.json") {
              const m = mapSavedRules(text);
              text = m.text;
              report.rehashedRules += m.rehashed;
            } else if (RECORD_STORES.some((s) => (s.endsWith("/") ? rel.startsWith(s) : rel === s)) && /\.json$/i.test(name)) {
              try {
                const changed = { v: false };
                const mapped = mapJson(JSON.parse(text), changed);
                if (changed.v) {
                  text = `${JSON.stringify(mapped, null, 2)}\n`;
                  report.mappedRecords.push(rel);
                }
              } catch {
                // Not JSON: copied as it is.
              }
            }
            stageFile(to, text, st.mode);
            report.files++;
            report.bytes += st.size;
            o.afterFile?.(rel);
            continue;
          }
        }
        report.bytes += copyOld(abs, join(p.staging, ...to.split("/")), st.mode);
        report.files++;
        o.afterFile?.(rel);
      }
    };
    await walk("");
    const carry: RegistryCarry = carryFromOldRegistry(readOld(join(oldRoot, "plugins-state", "installed.json"), 16 * 1024 * 1024)?.toString("utf8"));
    const left: LeftBehind = leftBehindFrom({
      credentialsIndex: readOld(join(oldRoot, "credentials", "index.json"), 16 * 1024 * 1024)?.toString("utf8"),
      devices: readOld(join(oldRoot, "devices", "registry.json"), 16 * 1024 * 1024)?.toString("utf8"),
    });
    const after = await o.alive();
    if (after.alive) throw new OldEngineRunning(after.how ?? "it answers");
    rmSync(p.scratch, { recursive: true, force: true });
    writeJsonAtomic(p.carry, carry, { mode: 0o600 });
    writeJsonAtomic(p.leftBehind, left, { mode: 0o600 });
    // Last: the staging folder is whole.
    writeJsonAtomic(p.complete, report, { mode: 0o600 });
    log(`old home: copied ${report.files} files (${report.bytes} bytes, ${report.databases.length} databases) from ${o.oldHome}; swapped in at the next start`);
    return report;
  } catch (err) {
    rmSync(p.staging, { recursive: true, force: true });
    rmSync(p.scratch, { recursive: true, force: true });
    rmSync(p.complete, { force: true });
    throw err;
  }
}

/** Reads an old-home text file for a caller outside this file (`login-item.ts`): read-only, no link followed. */
export function readOldText(path: string, max = 1024 * 1024): string | undefined {
  return readOld(path, max)?.toString("utf8");
}

/** Whether a staged copy is whole and waits for its swap. */
export function stagedCopyReady(home: string): boolean {
  const p = oldHomePaths(home);
  return existsSync(p.complete) && existsSync(p.staging);
}

/** The report a whole staged copy (or a swapped one) carries, or undefined. */
export function stagedReport(home: string): CopyReport | undefined {
  try {
    return JSON.parse(readFileSync(oldHomePaths(home).complete, "utf8")) as CopyReport;
  } catch {
    return undefined;
  }
}
