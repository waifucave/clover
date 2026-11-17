// The Clover→MOSS residue test, the twin of `clover-residue.test.ts` (Winter→Clover) and `residue.test.ts` (Norma→Winter).
// Walks EVERY tracked file in the repo and finds every `clover`/`Clover`/`CLOVER`, then asserts:
//   1. no name of the installed Clover app (`MOSS_NEVER_PERMITTED`: its Keychain service and launch agent label, its
//      home, its app) appears outside the files that entry names — checked FIRST, whatever the allowlist permits, and
//      in every tracked text file but `NEVER_SCAN_EXEMPT`'s, the paths the rename leaves alone included — and every
//      named file still spells it;
//   2. each `clover` sits in a path `MOSS_EXEMPT_PATHS` leaves alone, or inside a range permitted by AT LEAST ONE
//      applicable `MOSS_ALLOWLIST` entry (the agent SDK's packages and keys, the iOS app's names, the plant, the old
//      names the one helper reads, the installed app's names in `other-installs.ts`);
//   3. every allowlist entry, and every top-level alternative of its regex, matched at least once somewhere (no dead
//      entries or dead shapes: one that protects nothing is either stale or hiding a rename the codemod should have made);
//   4. every tracked path that still spells `clover` is one the path pass leaves on purpose.
// And it plants the strays a review could slip past it, to prove each one fails.
//
// Deliberately INDEPENDENT of `codemod.ts`'s own residue accounting: a second, separately written check over the same
// DATA (`moss.ts`, `BINARY_EXTENSIONS`), so a bug in the codemod's bookkeeping cannot also hide here.
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BINARY_EXTENSIONS, type AllowlistEntry } from "../../../../scripts/rename/allowlist";
import { MOSS_ALLOWLIST, MOSS_EXEMPT_PATHS, MOSS_KEEP_PATHS, MOSS_NEVER_PERMITTED } from "../../../../scripts/rename/moss";

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

/** A trailing `/` is a prefix, a `*` a glob, anything else one exact path (`moss.ts`'s header). */
function isExempt(relPath: string): boolean {
  return MOSS_EXEMPT_PATHS.some((p) => (p.endsWith("/") ? relPath.startsWith(p) : p.includes("*") ? globToRegex(p).test(relPath) : relPath === p));
}

/** Where the never-permitted names are NOT looked for: the docs, the release notes, the kept Swift tree, CLAUDE.md, the
 *  spikes (frozen history, never built or run by a gate) and the rename's own rules and tests. Everything else tracked is
 *  scanned for them, the paths the rename leaves alone included (the spike workflows, `infra/`, the extension, Cowork's
 *  native code): a new per-OS helper must not reach the installed app any more than the renamed code may. */
const NEVER_SCAN_EXEMPT: readonly string[] = ["docs/", "releases/", "apple/", "CLAUDE.md", "scripts/rename/", "packages/core/test/rename/", "spikes/"];

function isNeverScanExempt(relPath: string): boolean {
  return NEVER_SCAN_EXEMPT.some((p) => (p.endsWith("/") ? relPath.startsWith(p) : relPath === p));
}

/** An entry whose files a later change adds (`awaits`) is not dead while none of them is tracked yet. */
function awaitingItsFiles(entry: AllowlistEntry, tracked: readonly string[]): boolean {
  return entry.awaits !== undefined && (entry.files ?? []).every((f) => !tracked.includes(f));
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
const ALTERNATIVES: readonly { key: string; entry: AllowlistEntry; source: string; regex: RegExp }[] = MOSS_ALLOWLIST.flatMap((entry) => {
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
  for (const n of MOSS_NEVER_PERMITTED) {
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
  const survivor = /clover|Clover|CLOVER/g;
  if (!survivor.test(text)) return { hits, never, credited, spelled };
  // Permission: each entry's whole regex, as the codemod protects it. Credit: each alternative on its own.
  const permits: { start: number; end: number; id: string }[] = [];
  const alternatives: { start: number; end: number; key: string }[] = [];
  for (const entry of MOSS_ALLOWLIST) {
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

describe("Clover→MOSS rename residue", () => {
  test("no name of the installed Clover app appears outside the files that name it (checked before the allowlist)", () => {
    const { never } = scan();
    const report = never.slice(0, 100).map((h) => `${h.file}:${h.line}: [${h.id}] ${h.context}`).join("\n");
    expect(never, `never-permitted names (${never.length}):\n${report}`).toHaveLength(0);
  }, 120_000);

  test("the never-permitted patterns match what they name and not their neighbours (seeded strings, spelled in pieces so this file does not name them)", () => {
    // No file may spell the installed Clover app's names, this one included, so each is joined from pieces.
    const c = ["clo", "ver"].join(""), C = ["Clo", "ver"].join("");
    const hit = (id: string, text: string): boolean => {
      const n = MOSS_NEVER_PERMITTED.find((x) => x.id === id)!;
      return new RegExp(n.regex.source, n.regex.flags).test(text);
    };
    for (const text of [`com.waifucave.${c}.core`, `com.waifucave.${c}.core.dev`, `x = "com.waifucave.${c}.core";`, `com\\.waifucave\\.${c}\\.core\\.dev`]) {
      expect([text, hit("clover-keychain", text)]).toEqual([text, true]);
    }
    for (const text of [`com.waifucave.${c}.core.plist`, `com.waifucave.${c}.coreX`, `com.waifucave.${c}.core-test`, `com.waifucave.moss.core`, `com.waifucave.${c}.ios`]) {
      expect([text, hit("clover-keychain", text)]).toEqual([text, false]);
    }
    for (const text of [`~/.${c}`, `~/.${c}-dev/run`, `$HOME/.${c}`, ["$", "{HOME}", "/.", c, "/settings.json"].join(""), `join(homedir(), ".${c}")`, `homedir() , '.${c}-dev'`]) {
      expect([text, hit("clover-home", text)]).toEqual([text, true]);
    }
    for (const text of ["~/.moss", `~/.${c}x/..`.replace(`.${c}x`, ".moss"), "$HOME/.moss-dev", `join(homedir(), ".moss")`]) {
      expect([text, hit("clover-home", text)]).toEqual([text, false]);
    }
    for (const text of [`/Applications/${C}.app`, `open /Applications/${C}.app/Contents`, `join("/Applications", "${C}.app")`, `"/Applications" , '${C}.app'`]) {
      expect([text, hit("clover-app", text)]).toEqual([text, true]);
    }
    for (const text of ["/Applications/MOSS Code.app", `/Applications/${C}Tree.app`.replace(`${C}Tree`, "Other"), `~/Applications/${C}.app`.replace(`${C}.app`, "Moss.app")]) {
      expect([text, hit("clover-app", text)]).toEqual([text, false]);
    }
  });

  test("every file a never-permitted name lists is scanned and still spells it (no stale names)", () => {
    const { spelled, scanned } = scan();
    const stale: string[] = [];
    for (const n of MOSS_NEVER_PERMITTED) {
      for (const f of n.files) {
        if (!scanned.has(f)) stale.push(`${n.id}: ${f} is not a scanned file (missing, binary or exempt)`);
        else if (!spelled.get(n.id)?.has(f)) stale.push(`${n.id}: ${f} no longer spells it`);
      }
    }
    expect(stale, stale.join("\n")).toHaveLength(0);
  }, 120_000);

  test("every surviving clover/Clover/CLOVER is exempt or permitted by an allowlist entry", () => {
    const { hits } = scan();
    const unpermitted = hits.filter((h) => h.permittedBy === undefined);
    const report = unpermitted.slice(0, 200).map((h) => `${h.file}:${h.line}: ${h.context}`).join("\n");
    expect(unpermitted, `unpermitted residue (${unpermitted.length}):\n${report}`).toHaveLength(0);
  }, 120_000);

  test("every allowlist entry matched at least once (no dead entries)", () => {
    const { credited, files } = scan();
    const dead = MOSS_ALLOWLIST.filter((e) => !credited.has(e.id) && !awaitingItsFiles(e, files)).map((e) => e.id);
    expect(dead, `dead allowlist entries (matched nothing): ${dead.join(", ")}`).toHaveLength(0);
  }, 120_000);

  test("every top-level alternative of every entry permitted something (no dead shapes)", () => {
    const { credited, files } = scan();
    const dead = ALTERNATIVES.filter((a) => !credited.has(a.key) && !awaitingItsFiles(a.entry, files)).map((a) => `${a.key}: ${a.source.slice(0, 160)}`);
    expect(dead, `dead alternatives (each permitted nothing):\n${dead.join("\n")}`).toHaveLength(0);
  }, 120_000);

  test("an entry waits for its files only while none of them is tracked, and names each one exactly", () => {
    const { files } = scan();
    for (const e of MOSS_ALLOWLIST.filter((x) => x.awaits !== undefined)) {
      expect(e.files?.length, `${e.id} awaits files, so it names them`).toBeGreaterThan(0);
      for (const f of e.files ?? []) expect(f, `${e.id} names exact paths, never a glob`).not.toMatch(/\*|\/$/);
    }
    const entry = { id: "x", regex: /"clover"/g, files: ["a/b.ts"], why: "a test entry, long enough to say why", awaits: "a later change" };
    expect(awaitingItsFiles(entry, ["c.ts"])).toBe(true);
    expect(awaitingItsFiles(entry, ["a/b.ts"])).toBe(false);
    expect(awaitingItsFiles({ ...entry, awaits: undefined }, ["c.ts"])).toBe(false);
    expect(files.length).toBeGreaterThan(0);
  }, 120_000);

  test("every tracked path that still spells clover is exempt or kept on purpose", () => {
    const { files } = scan();
    const stray = files.filter((p) => /clover/i.test(p) && !isExempt(p) && !MOSS_KEEP_PATHS.some((re) => re.test(p)));
    expect(stray, `paths the path pass should have moved:\n${stray.join("\n")}`).toHaveLength(0);
  }, 120_000);

  test("allowlist and never-permitted ids are unique, and every entry says why", () => {
    const ids = [...MOSS_ALLOWLIST.map((e) => e.id), ...MOSS_NEVER_PERMITTED.map((e) => e.id)];
    expect(new Set(ids).size).toBe(ids.length);
    for (const e of [...MOSS_ALLOWLIST, ...MOSS_NEVER_PERMITTED]) expect(e.why.length).toBeGreaterThan(20);
    for (const n of MOSS_NEVER_PERMITTED) for (const f of n.files) expect(f, `${n.id} names exact paths, never a glob`).not.toMatch(/\*|\/$/);
  });

  test("the top-level split keeps groups, classes and escapes whole", () => {
    expect(topLevelAlternatives(String.raw`a(?:b|c)|[|)]d|e\|f|(?<=x|y)g`)).toEqual(["a(?:b|c)", "[|)]d", String.raw`e\|f`, "(?<=x|y)g"]);
  });

  test("plants: the strays a review could slip past now fail, and the shapes the entries name still pass", () => {
    const unpermitted = (file: string, text: string) => analyze(file, text).hits.filter((h) => h.permittedBy === undefined).length;
    const neverIds = (file: string, text: string) => analyze(file, text).never.map((n) => n.id);
    // The installed app's Keychain service, launch agent label and Dev's: refused by the never-permitted list outside the one file.
    expect(neverIds("packages/core/src/daemon.ts", `const s = "com.waifucave.clover.core";`)).toEqual(["clover-keychain"]);
    expect(neverIds("packages/core/src/daemon.ts", `service: "com.waifucave.clover.core.dev",`)).toEqual(["clover-keychain"]);
    expect(neverIds("packages/core/src/other-installs.ts", `export const CLOVER_KEYCHAIN_SERVICE = "com.waifucave.clover.core";`)).toEqual([]);
    // A longer, test-only id is not the live service (`com.waifucave.moss.core.test.<id>` is MOSS's own).
    expect(neverIds("packages/core/src/daemon.ts", `const s = "com.waifucave.clover.core.test-isolated";`)).toEqual([]);
    expect(unpermitted("packages/core/src/daemon.ts", `const s = "com.waifucave.clover.core";`)).toBe(1);
    // Its home and app, anywhere.
    expect(neverIds("scripts/dev-helper.ts", "open ~/.clover/logs")).toEqual(["clover-home"]);
    expect(neverIds("packages/core/src/computer-use/helper-client.ts", "const home = join(homedir(), \".clover\");")).toEqual(["clover-home"]);
    expect(neverIds("scripts/dev-helper.ts", `const app = "/Applications/Clover.app";`)).toEqual(["clover-app"]);
    expect(neverIds("scripts/dev-helper.ts", `join("/Applications", "Clover.app")`)).toEqual(["clover-app"]);
    // A bare `clover` in code, a path, a comment or an id no entry names fails; the old names fail outside their helper.
    expect(unpermitted("packages/core/src/daemon.ts", "const clover = true;")).toBe(1);
    expect(unpermitted("packages/core/src/daemon.ts", `join(cwd, ".clover", "rules")`)).toBe(1);
    expect(unpermitted("packages/core/src/agent/context.ts", "// reads CLOVER.md first")).toBe(1);
    expect(unpermitted("packages/core/src/registry/folders.ts", `join(folder, "clover.json")`)).toBe(1);
    expect(unpermitted("packages/core/src/old-names.ts", `export const OLD_PROJECT_DIR = ".clover";`)).toBe(0);
    expect(unpermitted("packages/core/src/old-names.ts", `export const OLD_INSTRUCTIONS_FILE = "CLOVER.md";`)).toBe(0);
    expect(unpermitted("packages/core/src/old-names.ts", `export const OLD_PLUGIN_MANIFEST = "clover.json";`)).toBe(0);
    // The agent SDK's names pass where it defines them; a sibling name of ours does not.
    expect(unpermitted("packages/core/src/daemon.ts", `import { x } from "@waifucave/clover-agent-sdk";`)).toBe(0);
    expect(unpermitted("packages/core/src/daemon.ts", `import { x } from "@waifucave/clover-core";`)).toBe(1);
    expect(unpermitted("packages/core/src/runtime-sdk/turn-loop/glossary.ts", `meta["clover/load"]`)).toBe(0);
    expect(unpermitted("packages/core/src/daemon.ts", `meta["clover/load"]`)).toBe(1);
    expect(unpermitted("packages/core/src/daemon.ts", `const ios = "com.waifucave.clover.ios";`)).toBe(0);
    expect(unpermitted("packages/core/src/daemon.ts", `const app = "com.waifucave.clover.code";`)).toBe(1);
    // The plant is Alpha's, in its own files only.
    expect(unpermitted("plugins/alpha/client/grass.tsx", "const clover = leaf();")).toBe(0);
    expect(unpermitted("plugins/sidebar/client/icons.tsx", "const clover = leaf();")).toBe(1);
  });

  // The never-permitted names are looked for in the paths the rename leaves alone too, so a new per-OS helper or spike
  // cannot reach the installed app either. Only the docs, the release notes, the kept Swift tree, CLAUDE.md and the
  // rename's own rules and tests are left out.
  test("the never-permitted scan reaches the paths the rename leaves alone", () => {
    for (const path of [".github/workflows/spike-s1.yml", "infra/relay/main.go", "extensions/winter-for-chrome/src/native.ts"]) {
      expect([path, isExempt(path), isNeverScanExempt(path)]).toEqual([path, true, false]);
    }
    for (const path of ["docs/moss-spec.md", "spikes/s9/README.md", "releases/winter/appcast.xml", "apple/WinterKit/Sources/X.swift", "CLAUDE.md", "scripts/rename/moss.ts", "packages/core/test/rename/residue.test.ts"]) {
      expect([path, isNeverScanExempt(path)]).toEqual([path, true]);
    }
    expect(analyzeNever("infra/mounts/main.go", "// mounts ~/.clover/sdk").never.map((n) => n.id)).toEqual(["clover-home"]);
    expect(analyzeNever("infra/sandbox/profile.sb", `(deny file-write* (subpath "/Applications/Clover.app"))`).never.map((n) => n.id)).toEqual(["clover-app"]);
  });

  // A crypto or wire tag is a value already on the wire and on disk: the deployed services verify it, clients that keep
  // the old name speak it, and the state stage 2 carries over was signed or derived under it. The identifier around it
  // is renamed, the string is not, so this table fails the moment one of them is changed to the new name.
  // The three groups are the allowlist's: `wire-deployed-services`, `wire-clients-keep-name`, `disk-signed-or-derived-state`.
  describe("the crypto and wire tags keep their old values", () => {
    const KEPT_TAGS: readonly { name: string; file: string; value: string; group: string }[] = [
      { name: "account register statement", file: "packages/core/src/identity/account.ts", value: "clover-account-v2 register", group: "wire-deployed-services" },
      { name: "account mint statement", file: "services/accounts/src/wire.ts", value: "clover-account-v1 mint", group: "wire-deployed-services" },
      { name: "handshake wire prefix", file: "packages/core/src/links/handshake.ts", value: 'HANDSHAKE_PREFIX = "clover-handshake-v1"', group: "wire-deployed-services" },
      { name: "handshake client prefix", file: "services/handshake/client/wire.ts", value: 'PREFIX = "clover-handshake-v1"', group: "wire-deployed-services" },
      { name: "handshake box info", file: "packages/core/src/identity/box-key.ts", value: 'HANDSHAKE_BOX_INFO = "clover handshake v1 box"', group: "wire-deployed-services" },
      { name: "handshake recovery info", file: "services/handshake/client/recovery.ts", value: 'INFO = "clover handshake v1 recovery"', group: "wire-deployed-services" },
      { name: "handshake Authorization scheme", file: "services/handshake/client/wire.ts", value: "Clover-Sig key=${key}", group: "wire-deployed-services" },
      { name: "handshake ticket HMAC key", file: "services/handshake/src/auth.ts", value: "clover-handshake-v1 ticket|", group: "wire-deployed-services" },
      { name: "relay ticket HMAC key", file: "services/relay/src/auth.ts", value: "clover-relay-v1 ticket|", group: "wire-deployed-services" },
      { name: "forwarder envelope info", file: "plugins/moss/plugins/forwarder/src/wire/envelope.ts", value: 'utf8("clover forwarder v1")', group: "wire-deployed-services" },
      { name: "forwarder hook key digest", file: "plugins/moss/plugins/forwarder/src/wire/protocol.ts", value: "clover hook key v1|${key}", group: "wire-deployed-services" },
      { name: "web pairing transcript", file: "services/web/protocol/pairing.ts", value: '"clover web pairing v1"', group: "wire-deployed-services" },
      { name: "web pairing words MAC", file: "services/web/protocol/pairing.ts", value: 'utf8("clover web words v1")', group: "wire-deployed-services" },
      { name: "link ALPN", file: "packages/core/src/links/wire.ts", value: 'ALPN_LINK = "clover/link/1"', group: "wire-clients-keep-name" },
      { name: "pair ALPN", file: "packages/core/src/links/wire.ts", value: 'ALPN_PAIR = "clover/pair/1"', group: "wire-clients-keep-name" },
      { name: "link sidecar ALPN", file: "native/link/src/main.rs", value: 'LINK_ALPN: &str = "clover/link/1"', group: "wire-clients-keep-name" },
      { name: "remote RPC stream label", file: "packages/core/src/links/remote-clients.ts", value: 'REMOTE_RPC_LABEL = "clover/rpc/1"', group: "wire-clients-keep-name" },
      { name: "pairing QR prefix", file: "packages/core/src/links/pairing.ts", value: 'QR_PREFIX = "clover-pair:1:"', group: "wire-clients-keep-name" },
      { name: "iOS companion QR prefix", file: "plugins/moss/plugins/companion-ios/host/index.ts", value: 'QR_PREFIX = "clover-pair:1:"', group: "wire-clients-keep-name" },
      { name: "pair SAS context", file: "packages/core/src/identity/sas.ts", value: 'PAIR_SAS = "clover/pair-sas/1"', group: "wire-clients-keep-name" },
      { name: "pair proof (host)", file: "packages/core/src/identity/sas.ts", value: 'PAIR_PROOF_HOST = "clover/pair-proof/host/1"', group: "wire-clients-keep-name" },
      { name: "pair transcript", file: "packages/core/src/identity/sas.ts", value: '"clover/pair-transcript/3"', group: "wire-clients-keep-name" },
      { name: "group key statement", file: "packages/core/src/links/group.ts", value: "clover/group-key/1", group: "wire-clients-keep-name" },
      { name: "answer-key statement", file: "packages/core/src/identity/answer-key.ts", value: "clover/answer-key/1", group: "wire-clients-keep-name" },
      { name: "answer-key rotation statement", file: "packages/core/src/devices/registry.ts", value: "clover/answer-key-rotate/1", group: "wire-clients-keep-name" },
      { name: "device-update record", file: "packages/core/src/devices/registry.ts", value: '"clover/device-update/3"', group: "wire-clients-keep-name" },
      { name: "card-answer statement", file: "packages/protocol/src/approvals.ts", value: "clover/card-answer/2", group: "wire-clients-keep-name" },
      { name: "user-message statement", file: "packages/protocol/src/sessions.ts", value: "clover/user-message/1", group: "wire-clients-keep-name" },
      { name: "memory mail info", file: "packages/core/src/sync/memory.ts", value: 'MAIL_INFO = "clover memory v1 mail"', group: "wire-clients-keep-name" },
      { name: "memory key statement", file: "packages/core/src/sync/memory-keys.ts", value: "clover-memory-v1 key commit", group: "wire-clients-keep-name" },
      { name: "update feed signed statement", file: "packages/update-feed/src/index.ts", value: "clover-update-feed-v1", group: "wire-clients-keep-name" },
      { name: "push alert key", file: "services/push/src/apns.ts", value: '"loc-key": "CLOVER_UPDATES"', group: "wire-clients-keep-name" },
      { name: "plugin registry MAC context", file: "packages/core/src/registry/state.ts", value: "clover/plugin-registry/1", group: "disk-signed-or-derived-state" },
      { name: "saved allow rule hash", file: "packages/core/src/approvals/strings.ts", value: "clover-saved-rule-v1", group: "disk-signed-or-derived-state" },
      { name: "cowork peer-send digest", file: "packages/core/src/cowork/peer-inbox.ts", value: 'DIGEST_VERSION = "clover.cowork.peer-send.v1"', group: "disk-signed-or-derived-state" },
      { name: "web companion key store", file: "services/web/src/store.ts", value: 'DB = "clover-companion"', group: "disk-signed-or-derived-state" },
    ];

    test.each(KEPT_TAGS.map((t) => [t.name, t] as const))("%s", (_name, tag) => {
      const text = readFileSync(join(repoRoot(), tag.file), "utf8");
      expect(text.includes(tag.value), `${tag.file} no longer spells ${tag.value}`).toBe(true);
      // The new spelling of the same value is the mistake this table exists to catch.
      expect(text.includes(tag.value.replace(/clover/g, "moss").replace(/Clover/g, "MOSS").replace(/CLOVER/g, "MOSS")), `${tag.file} spells the renamed ${tag.value}`).toBe(false);
      expect(MOSS_ALLOWLIST.some((e) => e.id === tag.group)).toBe(true);
    });

    test("each tag is permitted by the allowlist group it names", () => {
      for (const tag of KEPT_TAGS) {
        const entry = MOSS_ALLOWLIST.find((e) => e.id === tag.group);
        const clover = /clover|Clover|CLOVER/.exec(tag.value);
        expect(clover, tag.name).not.toBeNull();
        const probe = new RegExp(entry!.regex.source, "g");
        expect(probe.test(tag.value) || /thread-id|loc-key/.test(tag.value), `${tag.name}: ${tag.value} is not matched by ${tag.group}`).toBe(true);
      }
    });
  });

  test("the old names live in one helper: nothing else in live code spells them", () => {
    const { hits } = scan();
    const spelled = hits.filter((h) => /(?<![A-Za-z0-9_])\.clover(?![A-Za-z0-9_-])|CLOVER\.md|\bclover\.json\b/.test(h.context)).map((h) => h.file);
    // The spec (docs/moss-spec.md) is prose, not live code: it names `.clover` as the old project folder the build still reads second.
    // The one-time copy's table (`migration/old-home/names.ts`) names what the old engine wrote INSIDE its home (the
    // runtime home's config file, its instructions file), which the copy renames once and nothing reads afterwards.
    const allowed = new Set(["docs/moss-spec.md", "packages/core/src/old-names.ts", "packages/core/test/old-names.test.ts", "packages/core/src/other-installs.ts", "packages/core/test/other-installs.test.ts", "packages/core/src/migration/old-home/names.ts"]);
    const stray = [...new Set(spelled)].filter((f) => !allowed.has(f));
    expect(stray, `files other than the old-name helper that spell an old name:\n${stray.join("\n")}`).toHaveLength(0);
  }, 120_000);
});
