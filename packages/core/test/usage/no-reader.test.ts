// F3: the core holds no usage reader. Where a tool's numbers come from is a `usage.sources` entry of a plugin, run
// through `api.outside`; the core asks entries, keeps what they answer, prices it and shows it. This pins that: nothing
// under `src/usage/` names a tool's program or its folders, spawns a process, or reads a tool's files.
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dir = join(import.meta.dir, "..", "..", "src", "usage");
const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));

describe("core usage holds no reader", () => {
  test("no source file of a tool is back", () => {
    for (const gone of ["codex.ts", "claude-code.ts", "claude-stats.ts", "antigravity.ts", "opencode.ts", "ingest-files.ts", "spawn-lines.ts"]) {
      expect(files).not.toContain(gone);
    }
  });

  test("nothing under src/usage names a tool's folder or program, spawns, or reads a tool's file", () => {
    const hits: string[] = [];
    for (const f of files) {
      const code = readFileSync(join(dir, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      for (const [re, what] of [
        [/\.codex\b|\.claude\b|\.local\/share\/opencode|stats-cache|\.claude\.json/, "a tool's folder"],
        [/\bBun\.spawn|\bspawn\(|child_process|execFile|Bun\.\$/, "a process spawn"],
        [/rollout-|app-server|\/usage\b.*stream-json|--output-format/, "a tool's output shape"],
      ] as const) if (re.test(code)) hits.push(`${f}: ${what}`);
    }
    expect(hits).toEqual([]);
  });
});
