// #352's review, should-fix 3: a plugin's hooks and MCP servers get the session's project folders (`store.dirs`), so
// those must change only by the user's own act. This pins the doors that change them:
// * one writer of the column, `setDirsRaw`, called only by the domain setter (`sessions/set-dirs.ts`);
// * that setter, `setSessionDirs`, called only by the RPCs `session.setDirs` (the app's picker, the phone) and
//   `session.addDir` (the CLI's `clover add-dir`, the TUI's `/add-dir`), on the legacy connection whose app, CLI and
//   remote tokens the fence keeps from every session's processes (the run folder);
// * no Clover method sets them, so no Clover role (a session's CLI, a layer, a plugin host, a bridge) can;
// * `lockDir`, the first-write lock, has no caller outside its module: no model write adds or locks a folder.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { CLOVER_METHODS } from "@waifucave/clover-protocol";

const SRC = join(import.meta.dir, "..", "..");

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "tests" || name === "node_modules") continue;
      out.push(...sources(p));
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/** The core's source files (not tests) whose code, outside comments, calls `fn(`. */
function callers(fn: string): string[] {
  const call = new RegExp(`(?<![\\w$.])(?:\\w+\\.)*${fn}\\(`);
  return sources(SRC)
    // A definition (a function or method with typed parameters) is no call.
    .filter((f) => readFileSync(f, "utf8").split("\n").some((line) => !/^\s*(\/\/|\*|\/\*)/.test(line) && call.test(line) && !new RegExp(`function ${fn}\\(|^\\s*${fn}\\(\\w+: `).test(line)))
    .map((f) => relative(SRC, f))
    .sort();
}

describe("a session's working directories change only by the user's own act", () => {
  test("one writer of the column, one setter, and its only callers are the user's two RPCs", () => {
    expect(callers("setDirsRaw")).toEqual(["sessions/set-dirs.ts"]);
    expect(callers("setSessionDirs")).toEqual(["ipc/server.ts"]);
    const server = readFileSync(join(SRC, "ipc", "server.ts"), "utf8");
    expect([...server.matchAll(/setSessionDirs\(setDirsDeps, p\.sessionId, (p\.op|"add"), p\.path\)/g)].map((m) => m[1])).toEqual(["p.op", "\"add\""]);
    expect(callers("lockDir")).toEqual([]);
  });

  test("no Clover method sets them, so no session's CLI, layer, plugin host or bridge can", () => {
    const names = [...CLOVER_METHODS.keys()];
    expect(names.filter((n) => /dir/i.test(n) && /^session\./.test(n))).toEqual([]);
    expect(names).not.toContain("session.setDirs");
    expect(names).not.toContain("session.addDir");
  });
});
