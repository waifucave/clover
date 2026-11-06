import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// Lane C, C-M1 (S7's "Linux stall", isolated): under Bun 1.3.14, a `node:child_process` spawn whose
// stdio has an entry past fd 2 closes descriptor numbers the process has since reused — a file, a
// socket, a pipe of a `Bun.spawn` child — some time after that child exits. Reproduced on macOS,
// Linux and Windows with no browser: a regular file opened with `openSync` reads EBADF. Spawns with
// three stdio entries, and `Bun.spawn` with extra pipes or plain descriptor numbers, never did. So in
// Bun code (the daemon, the CLI, plugins, services) a child that needs a descriptor past 2 starts
// through `Bun.spawn`; this test keeps any other spawn out. (Electron's main process, `apps/`, runs
// Node's own child_process and is not scanned.)

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const SCANNED = ["packages", "plugins", "services"];
const SKIP_DIRS = new Set(["node_modules", "dist", "out", "generated", ".git", "test", "tests", "__tests__", "fixtures"]);

function* sources(dir: string): Generator<string> {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const path = join(dir, name);
    let st;
    try { st = statSync(path); } catch { continue; }
    if (st.isDirectory()) yield* sources(path);
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(name) && !/\.test\.|\.d\.ts$/.test(name)) yield path;
  }
}

/** The number of top-level entries in a `stdio: [ ... ]` array literal starting at `open`. */
function stdioEntries(text: string, open: number): number {
  let depth = 0, entries = 0, sawValue = false;
  for (let i = open; i < text.length; i++) {
    const c = text[i]!;
    if (c === "[" || c === "(" || c === "{") { depth++; if (depth > 1) sawValue = true; continue; }
    if (c === "]" || c === ")" || c === "}") { depth--; if (depth === 0) return entries + (sawValue ? 1 : 0); continue; }
    if (depth === 1 && c === ",") { entries++; sawValue = false; continue; }
    if (depth === 1 && !/\s/.test(c)) sawValue = true;
  }
  return entries;
}

/** Spawns through node:child_process in `text` whose stdio array has more than three entries. */
function wideChildProcessStdio(text: string): number[] {
  if (!/from\s+["'](node:)?child_process["']|require\(\s*["'](node:)?child_process["']\s*\)/.test(text)) return [];
  const lines: number[] = [];
  for (const m of text.matchAll(/stdio\s*:\s*\[/g)) {
    const at = m.index! + m[0].length - 1;
    // Bun.spawn is fine: look back to the call this stdio belongs to.
    const before = text.slice(Math.max(0, at - 400), at);
    const call = [...before.matchAll(/\b(Bun\.spawn(?:Sync)?|spawn(?:Sync)?|fork|exec(?:File)?(?:Sync)?)\s*\(/g)].at(-1)?.[1];
    if (call === undefined || call.startsWith("Bun.")) continue;
    if (stdioEntries(text, at) > 3) lines.push(text.slice(0, at).split("\n").length);
  }
  return lines;
}

describe("node:child_process stays at three stdio entries in Bun code", () => {
  test("the scan finds a wide node:child_process spawn and passes Bun.spawn", () => {
    const wide = `import { spawn } from "node:child_process";\nspawn("x", [], {\n  stdio: ["ignore", "ignore", "pipe", "pipe"],\n});`;
    expect(wideChildProcessStdio(wide)).toEqual([3]);
    expect(wideChildProcessStdio(`import { spawn } from "node:child_process";\nspawn("x", [], { stdio: ["ignore", "pipe", "pipe"] });`)).toEqual([]);
    expect(wideChildProcessStdio(`import { spawn } from "node:child_process";\nBun.spawn(["x"], { stdio: ["ignore", "pipe", "pipe", fdA, fdB] });`)).toEqual([]);
    expect(wideChildProcessStdio(`Bun.spawn(["x"], { stdio: ["ignore", "pipe", "pipe", 3, 4] });`)).toEqual([]);
  });

  test("no Bun source spawns through node:child_process with a descriptor past 2", () => {
    const found: string[] = [];
    for (const dir of SCANNED) {
      for (const file of sources(join(ROOT, dir))) {
        for (const line of wideChildProcessStdio(readFileSync(file, "utf8"))) found.push(`${relative(ROOT, file)}:${line}`);
      }
    }
    expect(found).toEqual([]);
  });
});
