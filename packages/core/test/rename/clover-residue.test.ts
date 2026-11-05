// C0 — the Winter→Clover residue test, the twin of `residue.test.ts` (Norma→Winter, P9b-22). Walks
// EVERY tracked file in the repo and finds every `winter`/`Winter`/`WINTER`, then asserts:
//   1. no name of the live Winter install (`CLOVER_NEVER_PERMITTED`: its Keychain services, its homes,
//      its app) appears outside the files that entry names — checked FIRST, whatever the allowlist
//      permits (C0 review S3), and in every tracked text file but `NEVER_SCAN_EXEMPT`'s, the paths the
//      rename leaves alone included (the C0 check) — and every named file still spells it;
//   2. each `winter` sits in a path `CLOVER_EXEMPT_PATHS` leaves alone, or inside a range permitted by
//      AT LEAST ONE applicable `CLOVER_ALLOWLIST` entry;
//   3. every allowlist entry, and every top-level alternative of its regex, matched at least once
//      somewhere (no dead entries or dead shapes: one that protects nothing is either stale or hiding
//      a rename the codemod should have made);
//   4. every tracked path that still spells `winter` is one the path pass leaves on purpose.
// And it plants the strays an earlier review slipped past it (a live Keychain service in computer use,
// a `winter` path, a `"winter"` beside a `// legacy` comment), to prove each one now fails.
//
// Deliberately INDEPENDENT of `codemod.ts`'s own residue accounting, for the same reason as its twin:
// a second, separately written check over the same DATA (`clover.ts`, `BINARY_EXTENSIONS`), so a bug
// in the codemod's bookkeeping cannot also hide here. It imports only the data files.
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BINARY_EXTENSIONS, type AllowlistEntry } from "../../../../scripts/rename/allowlist";
import { CLOVER_ALLOWLIST, CLOVER_EXEMPT_PATHS, CLOVER_KEEP_PATHS, CLOVER_NEVER_PERMITTED } from "../../../../scripts/rename/clover";

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

/** Where the never-permitted names are NOT looked for: the docs, the release notes, the kept Swift tree, CLAUDE.md, and
 *  the rename's own rules and tests. Everything else tracked is scanned for them, the paths the rename leaves alone
 *  included (`native/`, `spikes/`, the spike workflows, `infra/`, the extension, Cowork's native code): a new
 *  per-OS helper must not reach the live install any more than the renamed code may. */
const NEVER_SCAN_EXEMPT: readonly string[] = ["docs/", "releases/", "apple/", "CLAUDE.md", "scripts/rename/", "packages/core/test/rename/"];

function isNeverScanExempt(relPath: string): boolean {
  return NEVER_SCAN_EXEMPT.some((p) => (p.endsWith("/") ? relPath.startsWith(p) : relPath === p));
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

/** A regex source split at its top-level `|` (outside groups and character classes; escapes kept whole). */
export function topLevelAlternatives(source: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inClass = false;
  let current = "";
  for (let i = 0; i < source.length; i++) {
    const c = source[i] ?? "";
    if (c === "\\") {
      current += c + (source[i + 1] ?? "");
      i++;
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      current += c;
      continue;
    }
    if (c === "[") inClass = true;
    else if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "|" && depth === 0) {
      out.push(current);
      current = "";
      continue;
    }
    current += c;
  }
  out.push(current);
  return out;
}

/** Each entry's alternatives as their own global regexes, keyed `<id>#<index>`. */
const ALTERNATIVES: readonly { key: string; entry: AllowlistEntry; source: string; regex: RegExp }[] = CLOVER_ALLOWLIST.flatMap((entry) => {
  const flags = entry.regex.flags.includes("g") ? entry.regex.flags : `${entry.regex.flags}g`;
  return topLevelAlternatives(entry.regex.source).map((source, i) => ({ key: `${entry.id}#${i}`, entry, source, regex: new RegExp(source, flags) }));
});

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

interface NeverHit {
  file: string;
  line: number;
  context: string;
  id: string;
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

function matchRanges(regex: RegExp, text: string): { start: number; end: number }[] {
  const re = new RegExp(regex.source, regex.flags.includes("g") ? regex.flags : `${regex.flags}g`);
  const out: { start: number; end: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push({ start: m.index, end: m.index + m[0].length });
    if (m[0].length === 0) re.lastIndex++;
  }
  return out;
}

/** One file's never-permitted names outside their files, and which never-permitted entries this (named) file spells. */
function analyzeNever(relPath: string, text: string): { never: NeverHit[]; spelled: Set<string> } {
  const never: NeverHit[] = [];
  const spelled = new Set<string>();
  for (const n of CLOVER_NEVER_PERMITTED) {
    const ranges = matchRanges(n.regex, text);
    if (ranges.length === 0) continue;
    if (n.files.includes(relPath)) {
      spelled.add(n.id);
      continue;
    }
    for (const r of ranges) never.push({ file: relPath, ...lineAndContext(text, r.start), id: n.id });
  }
  return { never, spelled };
}

/** One file's findings: never-permitted names outside their files, each `winter` and what permits it, which
 *  alternatives covered a hit, and which never-permitted entries this (named) file spells. */
function analyze(relPath: string, text: string): { hits: Hit[]; never: NeverHit[]; credited: Set<string>; spelled: Set<string> } {
  const { never, spelled } = analyzeNever(relPath, text);

  const hits: Hit[] = [];
  const credited = new Set<string>();
  const survivor = /winter|Winter|WINTER/g;
  if (!survivor.test(text)) return { hits, never, credited, spelled };
  // Permission: each entry's whole regex, as the codemod protects it. Credit: each alternative on its own.
  const permits: { start: number; end: number; id: string }[] = [];
  const alternatives: { start: number; end: number; key: string }[] = [];
  for (const entry of CLOVER_ALLOWLIST) {
    if (!entryAppliesTo(entry, relPath)) continue;
    for (const r of matchRanges(entry.regex, text)) permits.push({ ...r, id: entry.id });
  }
  for (const alt of ALTERNATIVES) {
    if (!entryAppliesTo(alt.entry, relPath)) continue;
    for (const r of matchRanges(alt.regex, text)) alternatives.push({ ...r, key: alt.key });
  }
  survivor.lastIndex = 0;
  let s: RegExpExecArray | null;
  while ((s = survivor.exec(text)) !== null) {
    const index = s.index;
    const permit = permits.find((r) => index >= r.start && index < r.end);
    if (permit !== undefined) {
      credited.add(permit.id);
      for (const a of alternatives) if (index >= a.start && index < a.end) credited.add(a.key);
    }
    hits.push({ file: relPath, ...lineAndContext(text, index), permittedBy: permit?.id });
  }
  return { hits, never, credited, spelled };
}

let cached: { hits: Hit[]; never: NeverHit[]; credited: Set<string>; spelled: Map<string, Set<string>>; files: string[]; scanned: Set<string> } | undefined;

function scan(): NonNullable<typeof cached> {
  if (cached !== undefined) return cached;
  const root = repoRoot();
  const files = trackedFiles(root);
  const hits: Hit[] = [];
  const never: NeverHit[] = [];
  const credited = new Set<string>();
  const spelled = new Map<string, Set<string>>(); // never-permitted id → the named files that spell it
  const scanned = new Set<string>();

  for (const relPath of files) {
    if (isBinaryPath(relPath)) continue;
    const residue = !isExempt(relPath);
    if (!residue && isNeverScanExempt(relPath)) continue;
    let text: string;
    try {
      const buf = readFileSync(join(root, relPath));
      const ext = relPath.slice(relPath.lastIndexOf(".") + 1).toLowerCase();
      if (!SOURCE_EXTENSIONS.has(ext) && buf.subarray(0, 8000).includes(0)) continue;
      text = buf.toString("utf8");
    } catch {
      continue; // gone between `git ls-files` and now
    }
    scanned.add(relPath);
    if (!residue) {
      // A path the rename leaves alone: only the never-permitted names are looked for here.
      const r = analyzeNever(relPath, text);
      never.push(...r.never);
      for (const id of r.spelled) spelled.set(id, (spelled.get(id) ?? new Set()).add(relPath));
      continue;
    }
    const r = analyze(relPath, text);
    hits.push(...r.hits);
    never.push(...r.never);
    for (const k of r.credited) credited.add(k);
    for (const id of r.spelled) spelled.set(id, (spelled.get(id) ?? new Set()).add(relPath));
  }
  cached = { hits, never, credited, spelled, files, scanned };
  return cached;
}

describe("Winter→Clover rename residue (C0)", () => {
  test("no name of the live Winter install appears outside the files that name it (checked before the allowlist)", () => {
    const { never } = scan();
    const report = never.slice(0, 100).map((h) => `${h.file}:${h.line}: [${h.id}] ${h.context}`).join("\n");
    expect(never, `never-permitted names (${never.length}):\n${report}`).toHaveLength(0);
  }, 120_000);

  test("every file a never-permitted name lists is scanned and still spells it (no stale names)", () => {
    const { spelled, scanned } = scan();
    const stale: string[] = [];
    for (const n of CLOVER_NEVER_PERMITTED) {
      for (const f of n.files) {
        if (!scanned.has(f)) stale.push(`${n.id}: ${f} is not a scanned file (missing, binary or exempt)`);
        else if (!spelled.get(n.id)?.has(f)) stale.push(`${n.id}: ${f} no longer spells it`);
      }
    }
    expect(stale, stale.join("\n")).toHaveLength(0);
  }, 120_000);

  test("every surviving winter/Winter/WINTER is exempt or permitted by an allowlist entry", () => {
    const { hits } = scan();
    const unpermitted = hits.filter((h) => h.permittedBy === undefined);
    const report = unpermitted.slice(0, 200).map((h) => `${h.file}:${h.line}: ${h.context}`).join("\n");
    expect(unpermitted, `unpermitted residue (${unpermitted.length}):\n${report}`).toHaveLength(0);
  }, 120_000);

  test("every allowlist entry matched at least once (no dead entries)", () => {
    const { credited } = scan();
    const dead = CLOVER_ALLOWLIST.filter((e) => !credited.has(e.id)).map((e) => e.id);
    expect(dead, `dead allowlist entries (matched nothing): ${dead.join(", ")}`).toHaveLength(0);
  }, 120_000);

  test("every top-level alternative of every entry permitted something (no dead shapes)", () => {
    const { credited } = scan();
    const dead = ALTERNATIVES.filter((a) => !credited.has(a.key)).map((a) => `${a.key}: ${a.source.slice(0, 160)}`);
    expect(dead, `dead alternatives (each permitted nothing):\n${dead.join("\n")}`).toHaveLength(0);
  }, 120_000);


  test("every tracked path that still spells winter is exempt or kept on purpose", () => {
    const { files } = scan();
    const stray = files.filter((p) => /winter/i.test(p) && !isExempt(p) && !CLOVER_KEEP_PATHS.some((re) => re.test(p)));
    expect(stray, `paths the path pass should have moved:\n${stray.join("\n")}`).toHaveLength(0);
  }, 120_000);

  test("allowlist and never-permitted ids are unique, and every entry says why", () => {
    const ids = [...CLOVER_ALLOWLIST.map((e) => e.id), ...CLOVER_NEVER_PERMITTED.map((e) => e.id)];
    expect(new Set(ids).size).toBe(ids.length);
    for (const e of [...CLOVER_ALLOWLIST, ...CLOVER_NEVER_PERMITTED]) expect(e.why.length).toBeGreaterThan(20);
    for (const n of CLOVER_NEVER_PERMITTED) for (const f of n.files) expect(f, `${n.id} names exact paths, never a glob`).not.toMatch(/\*|\/$/);
  });

  test("the top-level split keeps groups, classes and escapes whole", () => {
    expect(topLevelAlternatives(String.raw`a(?:b|c)|[|)]d|e\|f|(?<=x|y)g`)).toEqual(["a(?:b|c)", "[|)]d", String.raw`e\|f`, "(?<=x|y)g"]);
  });

  test("plants: the strays an earlier review slipped past now fail, and the shapes the entries name still pass", () => {
    const unpermitted = (file: string, text: string) => analyze(file, text).hits.filter((h) => h.permittedBy === undefined).length;
    const neverIds = (file: string, text: string) => analyze(file, text).never.map((n) => n.id);
    // A live Keychain service inside computer use: refused by the never-permitted list, and by the allowlist.
    expect(neverIds("packages/core/src/computer-use/wiring.ts", `const s = "com.winter.core";`)).toEqual(["winter-keychain"]);
    expect(unpermitted("packages/core/src/computer-use/wiring.ts", `const s = "com.winter.core";`)).toBe(1);
    expect(neverIds("packages/core/src/computer-use/wiring.ts", `service: "com.winter.core.dev",`)).toEqual(["winter-keychain"]);
    // A Winter home, socket or app path anywhere.
    expect(unpermitted("packages/core/src/computer-use/helper-client.ts", `const sock = "/Users/x/winter/run/core.sock";`)).toBe(1);
    expect(neverIds("packages/core/src/computer-use/helper-client.ts", "const home = join(homedir(), \".winter\");")).toEqual(["winter-home"]);
    expect(neverIds("scripts/dev-helper.ts", "open ~/.winter-dev/logs")).toEqual(["winter-home"]);
    expect(neverIds("scripts/dev-helper.ts", `const app = "/Applications/Winter.app";`)).toEqual(["winter-app"]);
    // A "winter" on a line that only mentions legacy (the leg clauses are anchored to the word).
    expect(unpermitted("packages/core/src/daemon.ts", `const kind = "winter"; // legacy`)).toBe(1);
    expect(unpermitted("packages/core/src/daemon.ts", `const leg: RunLeg = "winter";`)).toBe(0);
    // A Winter app id outside the files that build and drive Winter's helpers.
    expect(unpermitted("packages/core/src/daemon.ts", `const app = "com.winter.app";`)).toBe(1);
    expect(unpermitted("packages/core/src/computer-use/policy.ts", `const app = "com.winter.app";`)).toBe(0);
    // Computer use's own shapes still pass: the family literal, a tab id, a harness member, the world, a wake event.
    expect(unpermitted("packages/core/src/computer-use/browser/engine.ts", `if (family === "winter") return;`)).toBe(0);
    expect(unpermitted("packages/core/src/computer-use/browser/engine.ts", "const key = `winter:${tabId}`;")).toBe(0);
    expect(unpermitted("packages/core/test/computer-use/browser-engine.test.ts", "h.winter.pages[url] = page;")).toBe(0);
    expect(unpermitted("packages/core/src/computer-use/browser/tab-driver.ts", "// resolved in its frame's winter world")).toBe(0);
    expect(unpermitted("packages/core/src/computer-use/browser/wake/backend.ts", `send({ type: "winter.wake.event" });`)).toBe(0);
    // ...but a bare `winter` in computer use's prose or code, or one after a dot, no longer does.
    expect(unpermitted("packages/core/src/computer-use/browser/engine.ts", "const winter = true;")).toBe(1);
    expect(unpermitted("packages/protocol/src/methods.ts", "// run `winter mcp add` first")).toBe(1);
    expect(unpermitted("packages/core/src/computer-use/browser/engine.ts", "opts.winter.legOf(id)")).toBe(1);
  });

  // The C0 check: the never-permitted names are looked for in the paths the rename leaves alone too, so a new per-OS
  // helper or spike cannot reach the live install either. Only the docs, the release notes, the kept Swift tree,
  // CLAUDE.md and the rename's own rules and tests are left out.
  test("the never-permitted scan reaches the paths the rename leaves alone", () => {
    for (const path of ["native/sandbox/src/main.rs", "spikes/s9/README.md", ".github/workflows/spike-s1.yml", "infra/relay/main.go", "extensions/winter-for-chrome/src/native.ts", "packages/core/src/cowork/native/launcher.ts"]) {
      expect([path, isExempt(path), isNeverScanExempt(path)]).toEqual([path, true, false]);
    }
    for (const path of ["docs/clover-spec.md", "releases/winter/appcast.xml", "apple/WinterKit/Sources/X.swift", "CLAUDE.md", "scripts/rename/clover.ts", "packages/core/test/rename/residue.test.ts"]) {
      expect([path, isNeverScanExempt(path)]).toEqual([path, true]);
    }
    expect(analyzeNever("native/mounts/main.go", "// mounts ~/.winter/sdk").never.map((n) => n.id)).toEqual(["winter-home"]);
    expect(analyzeNever("native/sandbox/profile.sb", `(deny file-write* (subpath "/Applications/Winter.app"))`).never.map((n) => n.id)).toEqual(["winter-app"]);
  });
});
