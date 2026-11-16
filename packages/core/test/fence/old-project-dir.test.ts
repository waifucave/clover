// A name the build reads second is fenced like the first. The build reads a project's config from `.moss/` and, when
// that is absent, from its old-named folder (`old-names.ts`), so every fence that holds `.moss/` against a fenced bot or
// a sandboxed command holds the old name just the same: a write to `<root>/<old>/x` is refused exactly as `<root>/.moss/x`.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSeatbeltProfile } from "../../src/agent/sandbox";
import { anyCase, denyRegex, shellRunLaterDenies } from "../../src/fence/sandbox-settings";
import { OLD_PROJECT_DIR, PROJECT_DIR_NAMES } from "../../src/old-names";
import { PROJECT_WHOLE_DENIES } from "../../src/registry/plugin-fence";
import { controlPlaneDenyRules } from "../../src/runtime-sdk/mode-options";
import { controlPlaneFileTarget } from "../../src/runtime-sdk/control-plane";
import { protectedPathsFor } from "../../src/runtime-sdk/protected-paths";

const dirs = [".moss", OLD_PROJECT_DIR];

describe("the old project folder is fenced like the new one", () => {
  test("the helper lists the new name first and the old one second, and the whole-folder denies hold both", () => {
    expect(PROJECT_DIR_NAMES).toEqual(dirs);
    for (const d of dirs) expect([d, PROJECT_WHOLE_DENIES.includes(d)]).toEqual([d, true]);
  });

  test("a shell's write to <root>/<dir>/x is refused for each name (macOS regex from `/`, and Linux per root)", () => {
    const os = "macos" as const;
    const denies = shellRunLaterDenies(["/r"], { userHome: "/u", mossHome: "/u/.moss", os, pathFolders: [] });
    for (const d of dirs) {
      const hits = (path: string) => denies.some((g) => denyRegex(g, os).test(path));
      expect([d, hits(`/r/${d}`), hits(`/r/${d}/mcp.json`), hits(`/r/a/b/${d}/settings.json`), hits(`/r/${d.toUpperCase()}/x`)]).toEqual([d, true, true, true, true]);
    }
    const linux = shellRunLaterDenies(["/r"], { userHome: "/u", mossHome: "/u/.moss", os: "linux", pathFolders: [] });
    for (const d of dirs) expect([d, linux.some((g) => denyRegex(g, "linux").test(`/r/p/${d}/x`))]).toEqual([d, true]);
    // The glob the daemon hands the sandbox for the old name is the plain name, as for every held name.
    expect(anyCase(OLD_PROJECT_DIR, "linux")).toBe(OLD_PROJECT_DIR);
  });

  test("the bash Seatbelt profile denies the control-plane files under each name, literal and nested at any depth", () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "moss-oldname-")));
    const profile = buildSeatbeltProfile({ cwd });
    for (const d of dirs) {
      for (const f of ["permissions.local.json", "settings.json", "settings.local.json"]) {
        expect([d, f, profile.includes(`(deny file-write* (literal "${join(cwd, d, f)}"))`)]).toEqual([d, f, true]);
      }
      // One regex line per name and file, with per-character case classes (the macOS volume is case-insensitive).
      const cls = [...d].map((c) => (/[A-Za-z]/.test(c) ? `[${c.toUpperCase()}${c.toLowerCase()}]` : `\\${c}`)).join("");
      for (const f of ["settings.json", "settings.local.json"]) {
        const fc = [...f].map((c) => (/[A-Za-z]/.test(c) ? `[${c.toUpperCase()}${c.toLowerCase()}]` : `\\${c}`)).join("");
        expect([d, f, profile.includes(`(deny file-write* (regex #"/${cls}/${fc}$"))`)]).toEqual([d, f, true]);
      }
    }
  });

  test("a write tool's target <root>/<dir>/<control file> is a control-plane target for each name, in any case, and a plain sibling is not", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "moss-oldname-")));
    for (const d of dirs) {
      for (const f of ["settings.json", "settings.local.json", "permissions.local.json", "mcp.json"]) {
        expect([d, f, controlPlaneFileTarget(join(root, d, f), root) !== null]).toEqual([d, f, true]);
      }
      expect([d, controlPlaneFileTarget(join(root, d.toUpperCase(), "Settings.json"), root) !== null]).toEqual([d, true]);
      expect([d, controlPlaneFileTarget(join(root, d, "notes.md"), root)]).toEqual([d, null]);
    }
  });

  test("the daemon's deny rules for the write tools name each folder's control files, mcp list, agents and settings tiers", () => {
    const rules = controlPlaneDenyRules("/home/u/.moss");
    for (const d of dirs) {
      for (const tail of ["settings.json", "mcp.json", "settings*.json", "agents/**"]) {
        expect([d, tail, rules.some((r) => r.includes(`/**/${d}/${tail}`))]).toEqual([d, tail, true]);
      }
    }
  });

  test("a trusted project's protected item folders are held under each name", () => {
    const protectedPaths = protectedPathsFor("/home/u/.moss", "/r");
    for (const d of dirs) for (const kind of ["skills", "output-styles", "rules", "commands"]) {
      expect([d, kind, protectedPaths.some((p) => p.includes(`/r/${d}/${kind}/**`))]).toEqual([d, kind, true]);
    }
  });
});
