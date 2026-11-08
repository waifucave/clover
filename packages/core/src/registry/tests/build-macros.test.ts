// Bun macros are off everywhere code is built or transpiled (#285's review B1, #289's review S1). A file importing
// `with { type: "macro" }` would run that function in the BUILDING (or transpiling) process and inline what it
// returns: a file it read, the process's pid, its environment. So:
//   - the plugin builder (and the daemon's load-time build through it) refuses such an import, loudly, with nothing
//     run and nothing inlined, on every side;
//   - every `Bun.build(...)` passes `...{ macros: false }` as its config's LAST entry, and every `new …Transpiler(...)`
//     passes `macro: false` the same way (Bun's Transpiler takes `macro`, and ignores `macros`);
//   - neither is reached through an alias (`Bun["build"]`, `const { build } = Bun`, a bare `Bun.build` value);
//   - every `bun build` on a command line (package.json scripts, spawned argv) carries `--no-macros`;
//   - and no tracked source imports a macro at all.
// The pins read the code with comments, strings, templates and regex literals blanked (a small lexer), so a mention in
// prose or a string is neither a call nor a pass.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPluginModule, PluginBuildError, type BuildSide } from "../build";

const REPO = join(import.meta.dir, "..", "..", "..", "..", "..");

describe("a macro import is refused, never run (the plugin builder)", () => {
  for (const side of ["bun", "node", "client"] as BuildSide[]) {
    test(`${side}: the build fails saying macros are disabled; the macro doesn't run, read or inline anything`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "clover-build-macro-"));
      const secret = join(dir, "ignored", "secret.txt");
      const ran = join(dir, "macro-ran.txt");
      mkdirSync(join(dir, "ignored"));
      writeFileSync(secret, "SECRET-THE-MACRO-READ");
      writeFileSync(join(dir, "mac.ts"), [
        `import { readFileSync, writeFileSync } from "node:fs";`,
        `export function leak(): string {`,
        `  writeFileSync(${JSON.stringify(ran)}, String(process.pid));`,
        `  return readFileSync(${JSON.stringify(secret)}, "utf8") + " PID:" + process.pid;`,
        `}`,
      ].join("\n"));
      const entry = join(dir, side === "client" ? "entry.tsx" : "host.ts");
      writeFileSync(entry, `import { leak } from "./mac.ts" with { type: "macro" };\nexport const value = leak();\n`);
      const outFile = join(dir, "out", side === "client" ? "entry.js" : "host.js");
      let error: unknown;
      try {
        await buildPluginModule({ entry, outFile, side });
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(PluginBuildError);
      expect((error as PluginBuildError).problems.join("\n")).toMatch(/Macros are disabled/);
      // Nothing ran in this process, and nothing it would have returned was written anywhere.
      expect(existsSync(ran)).toBe(false);
      if (existsSync(outFile)) {
        const text = readFileSync(outFile, "utf8");
        expect(text).not.toContain("SECRET-THE-MACRO-READ");
        expect(text).not.toContain(`PID:${process.pid}`);
      }
    });
  }
});

/**
 * `text` twice, each the same length as it: `code` with comments blanked (strings kept), and `bare` with comments AND
 * the contents of strings, templates (their `${…}` code kept) and regex literals blanked (their delimiters kept).
 */
export function lex(text: string): { code: string; bare: string } {
  const code = text.split("");
  const bare = text.split("");
  const blank = (from: number, to: number, both: boolean): void => {
    for (let k = from; k < to; k++) if (text[k] !== "\n") { bare[k] = " "; if (both) code[k] = " "; }
  };
  let i = 0;
  let prev = "";
  const regexBefore = new Set(["", "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^"]);
  const templates: number[] = [];
  let depth = 0;
  const string = (q: string): void => {
    const start = ++i;
    while (i < text.length && text[i] !== q && text[i] !== "\n") i += text[i] === "\\" ? 2 : 1;
    blank(start, i, false);
    i++;
  };
  const template = (): void => {
    // From just after a backtick (or a `}` closing an interpolation) to the next backtick or `${`.
    const start = i;
    while (i < text.length && text[i] !== "`" && !(text[i] === "$" && text[i + 1] === "{")) i += text[i] === "\\" ? 2 : 1;
    blank(start, i, false);
    if (text[i] === "$") { templates.push(depth); i += 2; prev = "{"; } else { i++; prev = "x"; }
  };
  while (i < text.length) {
    const c = text[i]!;
    if (c === "/" && text[i + 1] === "/") { const s = i; while (i < text.length && text[i] !== "\n") i++; blank(s, i, true); continue; }
    if (c === "/" && text[i + 1] === "*") { const s = i; const e = text.indexOf("*/", i + 2); i = e < 0 ? text.length : e + 2; blank(s, i, true); continue; }
    if (c === '"' || c === "'") { string(c); prev = "x"; continue; }
    if (c === "`") { i++; template(); continue; }
    // A postfix `++`/`--` ends an expression: a `/` after it divides.
    if ((c === "+" || c === "-") && text[i + 1] === c) { i += 2; prev = "x"; continue; }
    // After a keyword a `/` starts a regex, unless the keyword is a property name (`x.of / 2`).
    if (c === "/" && (regexBefore.has(prev) || /(?:^|[^.\w$])\s*(?:return|typeof|in|of|case|do|else|void)$/.test(text.slice(Math.max(0, i - 12), i).trimEnd()))) {
      const start = ++i;
      let inClass = false;
      while (i < text.length && text[i] !== "\n" && (inClass || text[i] !== "/")) {
        if (text[i] === "\\") { i += 2; continue; }
        if (text[i] === "[") inClass = true;
        else if (text[i] === "]") inClass = false;
        i++;
      }
      blank(start, i, false);
      i++;
      prev = "x";
      continue;
    }
    if (c === "{") depth++;
    if (c === "}") {
      if (templates.length > 0 && templates.at(-1) === depth) { templates.pop(); i++; template(); continue; }
      depth--;
    }
    if (!/\s/.test(c)) prev = /[\w$)\].]/.test(c) ? "x" : c;
    i++;
  }
  return { code: code.join(""), bare: bare.join("") };
}

/** The text between the `(` at `open` and its matching `)` (in already-lexed `bare`). */
function argsAt(bare: string, open: number): string {
  let depth = 0;
  for (let i = open; i < bare.length; i++) {
    if ("([{".includes(bare[i]!)) depth++;
    else if (")]}".includes(bare[i]!)) { depth--; if (depth === 0) return bare.slice(open + 1, i); }
  }
  return bare.slice(open + 1);
}

/** An object literal's top-level entries (`{ a: 1, ...b }` → ["a: 1", "...b"]), or undefined if `arg` isn't one. */
function entries(arg: string): string[] | undefined {
  const t = arg.trim();
  if (!t.startsWith("{")) return undefined;
  const inner = argsAt(`(${t})`, 0).trim().slice(1, -1);
  const out: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < inner.length; i++) {
    if ("([{".includes(inner[i]!)) depth++;
    else if (")]}".includes(inner[i]!)) depth--;
    else if (inner[i] === "," && depth === 0) { out.push(inner.slice(from, i).trim()); from = i + 1; }
  }
  out.push(inner.slice(from).trim());
  return out.filter((e) => e !== "");
}

/** The first argument of a call's argument text. */
function firstArg(args: string): string {
  let depth = 0;
  for (let i = 0; i < args.length; i++) {
    if ("([{".includes(args[i]!)) depth++;
    else if (")]}".includes(args[i]!)) depth--;
    else if (args[i] === "," && depth === 0) return args.slice(0, i);
  }
  return args;
}

const SOURCES = ["*.ts", "*.tsx", "*.mts", "*.cts", "*.js", "*.jsx", "*.mjs", "*.cjs"];
function tracked(patterns: string[]): string[] {
  const r = spawnSync("git", ["ls-files", "-z", "--", ...patterns], { cwd: REPO, encoding: "utf8", maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`git ls-files failed: ${r.stderr}`);
  return r.stdout.split("\0").filter((f) => f !== "" && !f.includes("node_modules/"));
}
const lexed = (() => {
  let cache: Array<{ file: string; code: string; bare: string }> | undefined;
  return () => (cache ??= tracked(SOURCES).map((file) => ({ file, ...lex(readFileSync(join(REPO, file), "utf8")) })));
})();

const LAST_MACROS_OFF = /^\.\.\.\s*\(?\s*\{\s*macros\s*:\s*false\s*\}\s*(?:as\s+object\s*)?\)?$/;
const LAST_MACRO_OFF = /^\.\.\.\s*\(?\s*\{\s*macro\s*:\s*false\s*\}\s*(?:as\s+object\s*)?\)?$/;

describe("the pins' lexer", () => {
  test("blanks comments, strings, templates and regex literals, and keeps the code around them", () => {
    const src = 'const a = "Bun.build(x)"; // Bun.build(y)\n/* Bun.build(z) */ const r = /Bun\\.build\\(/; const t = `Bun.build(${Bun.build({ q: 1 })})`;';
    const { bare, code } = lex(src);
    expect(bare.length).toBe(src.length);
    expect([...bare.matchAll(/Bun\.build\(/g)].length).toBe(1);
    expect(code).toContain('"Bun.build(x)"');
    expect(code).not.toContain("Bun.build(y)");
  });
  test("an object's last entry, and a spread before a later config is not last", () => {
    expect(entries("{ a: 1, ...{ macros: false } }")!.at(-1)).toMatch(LAST_MACROS_OFF);
    expect(entries("{ ...{ macros: false }, ...config }")!.at(-1)).not.toMatch(LAST_MACROS_OFF);
    expect(entries("{ define: { macros: false }, a: 1 }")!.at(-1)).not.toMatch(LAST_MACROS_OFF);
    expect(entries("config")).toBeUndefined();
  });
});

/**
 * `Bun` itself bound to another name (`const B = Bun`, `x = Bun`, `return Bun`, `=> Bun`), through which `B.build(…)`
 * would pass unseen, and a cast reached through (`(Bun as X).build`, `.Transpiler`). Passing `Bun` to a call
 * (`spyOn(Bun, "spawn")`) or casting it for another member is not an alias the pins care about.
 */
function bunAliases(file: string, bare: string): string[] {
  const out: string[] = [];
  for (const m of bare.matchAll(/(?:(?<![=!<>])=(?![=>])|=>|\breturn\b)\s*Bun\b(?!\s*(?:\?\.|\.|\[))/g)) out.push(`${file}: Bun bound to another name (${m[0].trim().slice(0, 30)})`);
  for (const m of bare.matchAll(/\(\s*Bun\s+as\b[^()]*\)\s*(?:\?\.|\.)\s*(build|Transpiler)\b/g)) out.push(`${file}: Bun.${m[1]} reached through a cast`);
  return out;
}

/** One file's Bun.build problems, and how many calls it has. */
function buildProblems(file: string, code: string, bare: string): { calls: number; problems: string[] } {
  const problems: string[] = [];
  let calls = 0;
  for (const m of bare.matchAll(/\bBun\s*\??\.\s*build\b/g)) {
    const rest = bare.slice(m.index! + m[0].length);
    const after = rest.trimStart();
    if (/typeof\s*$/.test(bare.slice(Math.max(0, m.index! - 8), m.index!))) continue;
    if (!after.startsWith("(")) { problems.push(`${file}: Bun.build used as a value (call it directly)`); continue; }
    calls++;
    const list = entries(firstArg(argsAt(bare, m.index! + m[0].length + (rest.length - after.length))));
    if (list === undefined) problems.push(`${file}: Bun.build(…) is passed no object literal`);
    else if (!LAST_MACROS_OFF.test(list.at(-1) ?? "")) problems.push(`${file}: Bun.build(…)'s last entry isn't \`...{ macros: false }\``);
  }
  for (const m of bare.matchAll(/\bBun\s*(?:\?\.)?\s*\[\s*(["'`])[^"'`]*\1\s*\]/g)) if (/build/.test(code.slice(m.index!, m.index! + m[0].length))) problems.push(`${file}: Bun["build"]`);
  problems.push(...bunAliases(file, bare));
  if (/\{[^{}]*\bbuild\b[^{}]*\}\s*=\s*Bun\b/.test(bare)) problems.push(`${file}: build destructured from Bun`);
  return { calls, problems };
}

/** One file's Transpiler problems, and how many constructions it has. */
function transpilerProblems(file: string, code: string, bare: string): { calls: number; problems: string[] } {
  const problems: string[] = [];
  let calls = 0;
  for (const m of bare.matchAll(/\bnew\s+(?:[\w$]+\s*\??\.\s*)*Transpiler\s*\(/g)) {
    calls++;
    const list = entries(firstArg(argsAt(bare, m.index! + m[0].length - 1)));
    if (list === undefined || !LAST_MACRO_OFF.test(list.at(-1) ?? "")) problems.push(`${file}: new Transpiler(…)'s last entry isn't \`...{ macro: false }\``);
  }
  for (const m of bare.matchAll(/\bBun\s*(?:\?\.)?\s*\[\s*(["'`])[^"'`]*\1\s*\]/g)) if (/Transpiler/.test(code.slice(m.index!, m.index! + m[0].length))) problems.push(`${file}: Bun["Transpiler"]`);
  if (/\{[^{}]*\bTranspiler\b[^{}]*\}\s*=\s*Bun\b/.test(bare)) problems.push(`${file}: Transpiler destructured from Bun`);
  return { calls, problems };
}

/**
 * One file's bun build argv without --no-macros: `["bun", "build", …]` / `[process.execPath, "build", …]`, a
 * `["build", …]` handed to bun (`run(bun, […])`, `run("bun", […])`, `checked(process.execPath, […])`), or one with
 * bun build's own flags (`run(["build", …, "--outfile", …])`). Another command's `build` (`run("swift", ["build"…])`)
 * is not bun's.
 */
function argvProblems(file: string, code: string, bare: string): { calls: number; problems: string[] } {
  const problems: string[] = [];
  let calls = 0;
  for (const m of code.matchAll(/(?:\(\s*(["']?)([\w.$-]+)\1\s*,\s*)?\[\s*((?:["']bun["']|process\.execPath)\s*,\s*)?["']build["']\s*,([^\]]*)\]/g)) {
    // Inside a string or a comment (blanked in `bare`), it's text, not a call.
    if (bare[m.index!] !== code[m.index!]) continue;
    const cmd = m[2];
    const bunArgv = m[3] !== undefined || cmd === "bun" || cmd === "process.execPath";
    if (!bunArgv && (cmd !== undefined || !/["']--(?:outfile|outdir|compile)\b/.test(m[4]!))) continue;
    calls++;
    if (!/["']--no-macros["']/.test(m[4]!)) problems.push(`${file}: ${m[0].slice(0, 60)}`);
  }
  return { calls, problems };
}

describe("the pins catch what they pin", () => {
  const check = (src: string) => { const { code, bare } = lex(src); return [...buildProblems("f", code, bare).problems, ...transpilerProblems("f", code, bare).problems, ...argvProblems("f", code, bare).problems]; };
  test("aliases, a missing or misplaced switch, a switch only in a comment or a nested object", () => {
    expect(check("await Bun.build({ a: 1, ...{ macros: false } });")).toEqual([]);
    expect(check("await Bun.build({ ...{ macros: false }, ...config });")).toEqual(["f: Bun.build(…)'s last entry isn't `...{ macros: false }`"]);
    expect(check("await Bun.build({ a: 1 /* ...{ macros: false } */ });")).toEqual(["f: Bun.build(…)'s last entry isn't `...{ macros: false }`"]);
    expect(check("await Bun.build({ define: { macros: false } });")).toEqual(["f: Bun.build(…)'s last entry isn't `...{ macros: false }`"]);
    expect(check("await Bun.build(config);")).toEqual(["f: Bun.build(…) is passed no object literal"]);
    expect(check("const b = Bun.build; await b({});")).toEqual(["f: Bun.build used as a value (call it directly)"]);
    expect(check('await Bun["build"]({});')).toEqual(['f: Bun["build"]']);
    expect(check("const { build } = Bun;")).toEqual(["f: Bun bound to another name (= Bun)", "f: build destructured from Bun"]);
    expect(check("type C = Parameters<typeof Bun.build>[0];")).toEqual([]);
    expect(check('new Bun.Transpiler({ loader: "ts" });')).toEqual(["f: new Transpiler(…)'s last entry isn't `...{ macro: false }`"]);
    expect(check('new Bun.Transpiler({ loader: "ts", ...({ macro: false } as object) });')).toEqual([]);
    expect(check('new Bun.Transpiler({ loader: "ts", ...{ macros: false } });')).toEqual(["f: new Transpiler(…)'s last entry isn't `...{ macro: false }`"]);
    expect(check("const { Transpiler } = Bun;")).toEqual(["f: Bun bound to another name (= Bun)", "f: Transpiler destructured from Bun"]);
    expect(check('spawnSync("bun", ["build", "x.ts", "--outfile", "y"]);')).toEqual(['f: ("bun", ["build", "x.ts", "--outfile", "y"]']);
    expect(check('spawnSync(process.execPath, ["build", "--no-macros", "x.ts"]);')).toEqual([]);
    expect(check('run("swift", ["build", "--package-path", "p"]);')).toEqual([]);
    // The reviewer's: a division after a postfix ++ / --, or after a keyword-named property, is not a regex.
    expect(check("i++ / 2; Bun.build({ a: 1 }); // /")).toEqual(["f: Bun.build(…)'s last entry isn't `...{ macros: false }`"]);
    expect(check("i-- / 2; Bun.build({ a: 1 }); // /")).toEqual(["f: Bun.build(…)'s last entry isn't `...{ macros: false }`"]);
    expect(check("x.of / 2; Bun.build({ a: 1 }); /")).toEqual(["f: Bun.build(…)'s last entry isn't `...{ macros: false }`"]);
    // Optional chaining, and Bun itself aliased.
    expect(check("Bun?.build({ a: 1 });")).toEqual(["f: Bun.build(…)'s last entry isn't `...{ macros: false }`"]);
    expect(check('Bun?.["build"]({});')).toEqual(['f: Bun["build"]']);
    expect(check("const B = Bun; B.build({ a: 1 });")).toEqual(["f: Bun bound to another name (= Bun)"]);
    expect(check("const get = () => Bun;")).toEqual(["f: Bun bound to another name (=> Bun)"]);
    expect(check("(Bun as any).build({});")).toEqual(["f: Bun.build reached through a cast"]);
    expect(check('spyOn(Bun, "spawn"); (Bun as { secrets: unknown }).secrets = x; if (a === Bun) {}')).toEqual([]);
    expect(check("const t: typeof Bun = globalThis.Bun; const o: { Bun?: X } = {};")).toEqual([]);
  });
});

describe("macros are off in every build and transpile in the repository", () => {
  const sum = (f: (x: { file: string; code: string; bare: string }) => { calls: number; problems: string[] }) => {
    let calls = 0;
    const problems: string[] = [];
    for (const x of lexed()) { const r = f(x); calls += r.calls; problems.push(...r.problems); }
    return { calls, problems };
  };

  test("each Bun.build(…) passes `...{ macros: false }` as its config's last entry, with no alias", () => {
    const { calls, problems } = sum((x) => buildProblems(x.file, x.code, x.bare));
    // 14 calls today: a scan that finds fewer is broken, not passing.
    expect(calls).toBeGreaterThanOrEqual(14);
    expect(problems).toEqual([]);
  });

  test("each new …Transpiler(…) passes `macro: false` as its options' last entry, with no alias", () => {
    const { calls, problems } = sum((x) => transpilerProblems(x.file, x.code, x.bare));
    expect(calls).toBeGreaterThanOrEqual(11);
    expect(problems).toEqual([]);
  });

  test("every bun build on a command line carries --no-macros (package.json scripts and spawned argv)", () => {
    const problems: string[] = [];
    let seen = 0;
    for (const file of tracked(["*package.json"])) {
      const scripts = (JSON.parse(readFileSync(join(REPO, file), "utf8")) as { scripts?: Record<string, string> }).scripts ?? {};
      for (const [name, line] of Object.entries(scripts)) {
        for (const cmd of line.split(/&&|\|\||;|\|/).map((c) => c.trim())) {
          if (!/^bun\s+build\b/.test(cmd)) continue;
          seen++;
          if (!/\s--no-macros\b/.test(cmd)) problems.push(`${file} scripts.${name}: ${cmd.slice(0, 60)}`);
        }
      }
    }
    const argv = sum((x) => argvProblems(x.file, x.code, x.bare));
    expect(seen + argv.calls).toBeGreaterThanOrEqual(10);
    expect([...problems, ...argv.problems]).toEqual([]);
  });

  test("no tracked source imports a macro", () => {
    const hits: string[] = [];
    for (const { file, code, bare } of lexed()) {
      for (const m of bare.matchAll(/\bfrom\s*(["'])[^"'\n]*\1\s*with\s*\{\s*type\s*:\s*(["'])[^"'\n]*\2\s*\}/g)) {
        if (/["']macro["']/.test(code.slice(m.index!, m.index! + m[0].length))) hits.push(file);
      }
    }
    expect(hits).toEqual([]);
  });
});
