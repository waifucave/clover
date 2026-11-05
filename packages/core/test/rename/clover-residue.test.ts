// C0 — the Winter→Clover residue test, the twin of `residue.test.ts` (Norma→Winter, P9b-22). Walks
// EVERY tracked file in the repo and finds every `winter`/`Winter`/`WINTER`, then asserts:
//   1. each one sits in a path `CLOVER_EXEMPT_PATHS` leaves alone, or inside a range permitted by AT
//      LEAST ONE applicable `CLOVER_ALLOWLIST` entry;
//   2. every allowlist entry matched at least once somewhere (no dead entries: an entry that
//      protects nothing is either stale or hiding a rename the codemod should have made);
//   3. every tracked path that still spells `winter` is one the path pass leaves on purpose.
//
// Deliberately INDEPENDENT of `codemod.ts`'s own residue accounting, for the same reason as its twin:
// a second, separately written check over the same DATA (`clover.ts`, `BINARY_EXTENSIONS`), so a bug
// in the codemod's bookkeeping cannot also hide here. It imports only the data files.
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BINARY_EXTENSIONS, type AllowlistEntry } from "../../../../scripts/rename/allowlist";
import { CLOVER_ALLOWLIST, CLOVER_EXEMPT_PATHS, CLOVER_KEEP_PATHS } from "../../../../scripts/rename/clover";

/** Simple glob (`**` = any path, `*` = one segment), anchored — `codemod.ts`'s `globToRegex`. */
function globToRegex(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] ?? "";
    if (c === "*" && glob[i + 1] === "*") {
      re += ".*";
      i++;
      if (glob[i + 1] === "/") i++;
    } else if (c === "*") re += "[^/]*";
    else re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** A trailing `/` is a prefix, a `*` a glob, anything else one exact path (`clover.ts`'s header). */
function isExempt(relPath: string): boolean {
  return CLOVER_EXEMPT_PATHS.some((p) => (p.endsWith("/") ? relPath.startsWith(p) : p.includes("*") ? globToRegex(p).test(relPath) : relPath === p));
}

function entryAppliesTo(entry: AllowlistEntry, relPath: string): boolean {
  if (!entry.files) return true;
  return entry.files.some((g) => globToRegex(g).test(relPath));
}

function isBinaryPath(relPath: string): boolean {
  const base = relPath.slice(relPath.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot < 0) return false;
  return BINARY_EXTENSIONS.has(base.slice(dot + 1).toLowerCase());
}

/** Source text that may legitimately hold a NUL byte (a test's fixture string): never sniffed as binary. */
const SOURCE_EXTENSIONS: ReadonlySet<string> = new Set(["ts", "tsx", "mts", "cts", "js", "mjs", "cjs", "json", "md"]);

function repoRoot(): string {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: import.meta.dir }).toString().trim();
}

function trackedFiles(root: string): string[] {
  const out = execFileSync("git", ["ls-files", "-z"], { cwd: root }).toString();
  return out.split("\0").filter((p) => p.length > 0);
}

interface Hit {
  file: string;
  line: number;
  context: string;
  permittedBy: string | undefined; // undefined = UNPERMITTED
}

function lineAndContext(text: string, index: number): { line: number; context: string } {
  let line = 1;
  let lastNl = -1;
  for (let i = 0; i < index; i++) {
    if (text.charCodeAt(i) === 10) { line++; lastNl = i; }
  }
  const nextNl = text.indexOf("\n", index);
  return { line, context: text.slice(lastNl + 1, nextNl < 0 ? undefined : nextNl).trim().slice(0, 200) };
}

let cached: { hits: Hit[]; matchedEntryIds: Set<string>; files: string[] } | undefined;

function scan(): { hits: Hit[]; matchedEntryIds: Set<string>; files: string[] } {
  if (cached !== undefined) return cached;
  const root = repoRoot();
  const files = trackedFiles(root);
  const hits: Hit[] = [];
  const matchedEntryIds = new Set<string>();
  const survivor = /winter|Winter|WINTER/g;

  for (const relPath of files) {
    if (isBinaryPath(relPath) || isExempt(relPath)) continue;
    let text: string;
    try {
      const buf = readFileSync(join(root, relPath));
      const ext = relPath.slice(relPath.lastIndexOf(".") + 1).toLowerCase();
      if (!SOURCE_EXTENSIONS.has(ext) && buf.subarray(0, 8000).includes(0)) continue;
      text = buf.toString("utf8");
    } catch {
      continue; // gone between `git ls-files` and now
    }
    survivor.lastIndex = 0;
    if (!survivor.test(text)) continue;

    const ranges: { start: number; end: number; id: string }[] = [];
    for (const entry of CLOVER_ALLOWLIST) {
      if (!entryAppliesTo(entry, relPath)) continue;
      const re = new RegExp(entry.regex.source, entry.regex.flags.includes("g") ? entry.regex.flags : `${entry.regex.flags}g`);
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        ranges.push({ start: m.index, end: m.index + m[0].length, id: entry.id });
        if (m[0].length === 0) re.lastIndex++;
      }
    }
    survivor.lastIndex = 0;
    let s: RegExpExecArray | null;
    while ((s = survivor.exec(text)) !== null) {
      const index = s.index;
      const hit = ranges.find((r) => index >= r.start && index < r.end);
      if (hit) matchedEntryIds.add(hit.id);
      const { line, context } = lineAndContext(text, index);
      hits.push({ file: relPath, line, context, permittedBy: hit?.id });
    }
  }
  cached = { hits, matchedEntryIds, files };
  return cached;
}

describe("Winter→Clover rename residue (C0)", () => {
  test("every surviving winter/Winter/WINTER is exempt or permitted by an allowlist entry", () => {
    const { hits } = scan();
    const unpermitted = hits.filter((h) => h.permittedBy === undefined);
    const report = unpermitted.slice(0, 200).map((h) => `${h.file}:${h.line}: ${h.context}`).join("\n");
    expect(unpermitted, `unpermitted residue (${unpermitted.length}):\n${report}`).toHaveLength(0);
  }, 120_000);

  test("every allowlist entry matched at least once (no dead entries)", () => {
    const { matchedEntryIds } = scan();
    const dead = CLOVER_ALLOWLIST.filter((e) => !matchedEntryIds.has(e.id)).map((e) => e.id);
    expect(dead, `dead allowlist entries (matched nothing): ${dead.join(", ")}`).toHaveLength(0);
  }, 120_000);

  test("every tracked path that still spells winter is exempt or kept on purpose", () => {
    const { files } = scan();
    const stray = files.filter((p) => /winter/i.test(p) && !isExempt(p) && !CLOVER_KEEP_PATHS.some((re) => re.test(p)));
    expect(stray, `paths the path pass should have moved:\n${stray.join("\n")}`).toHaveLength(0);
  }, 120_000);

  test("allowlist ids are unique, and every entry says why", () => {
    const ids = CLOVER_ALLOWLIST.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const e of CLOVER_ALLOWLIST) expect(e.why.length).toBeGreaterThan(20);
  });
});
