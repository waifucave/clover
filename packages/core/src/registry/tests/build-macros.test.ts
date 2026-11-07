// Bun macros are off in every build (#285's review, B1). A plugin file importing `with { type: "macro" }` would run
// that function in the BUILDING process and inline what it returns: a file it read, the builder's pid, its
// environment. The plugin builder (and the daemon's load-time build through it) must refuse such an import, loudly,
// with nothing run and nothing inlined; and every other `Bun.build` in the repository passes the same switch.
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

describe("every Bun.build in the repository turns macros off", () => {
  const tracked = (): string[] => {
    const r = spawnSync("git", ["ls-files", "-z", "--", "*.ts", "*.tsx", "*.mts", "*.js", "*.mjs"], { cwd: REPO, encoding: "utf8", maxBuffer: 1 << 28 });
    if (r.status !== 0) throw new Error(`git ls-files failed: ${r.stderr}`);
    return r.stdout.split("\0").filter((f) => f !== "" && !f.includes("node_modules/"));
  };

  /** The text of each `Bun.build(...)` call's arguments, by balanced parentheses. */
  const calls = (text: string): string[] => {
    const out: string[] = [];
    for (const m of text.matchAll(/\bBun\.build\(/g)) {
      let depth = 1;
      let i = m.index! + m[0].length;
      const start = i;
      for (; i < text.length && depth > 0; i++) {
        if (text[i] === "(") depth++;
        else if (text[i] === ")") depth--;
      }
      out.push(text.slice(start, i - 1));
    }
    return out;
  };

  test("each call passes `macros: false`", () => {
    const missing: string[] = [];
    let seen = 0;
    for (const f of tracked()) {
      const text = readFileSync(join(REPO, f), "utf8");
      if (!text.includes("Bun.build(")) continue;
      for (const args of calls(text)) {
        seen++;
        if (!/\bmacros\s*:\s*false\b/.test(args)) missing.push(`${f}: Bun.build(${args.slice(0, 60).replace(/\s+/g, " ")}…)`);
      }
    }
    // 14 calls today: a scan that finds fewer is broken, not passing.
    expect(seen).toBeGreaterThanOrEqual(14);
    expect(missing).toEqual([]);
  });

  test("no tracked source imports a macro", () => {
    const hits: string[] = [];
    for (const f of tracked()) {
      if (f.endsWith("build-macros.test.ts")) continue;
      const text = readFileSync(join(REPO, f), "utf8");
      if (/\bfrom\s*["'][^"'\n]+["']\s*with\s*\{\s*type\s*:\s*["']macro["']\s*\}/.test(text)) hits.push(f);
    }
    expect(hits).toEqual([]);
  });
});
