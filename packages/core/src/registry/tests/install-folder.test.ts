// Installing from a folder, #394's review: reads that can't be swapped under the copy, caps in the walk, a rename's
// failures as the install's, and staging folders swept. Temp folders only.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContractError } from "../../contracts/common";
import { installFromFolder, readSourceFile, renameInto, sweepInstallStages } from "../install-folder";
import { TreeProblem, treeEntries } from "../tree";

const temps: string[] = [];
const temp = (prefix: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(d);
  return d;
};
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});
const codeOf = (f: () => unknown) => {
  try {
    f();
    return "ok";
  } catch (e) {
    return e instanceof ContractError ? e.code : (e as Error).message;
  }
};

describe("installing from a folder", () => {
  test("a source file is read without following a link, as a regular file, within the budget", () => {
    const d = temp("clover-inst-");
    writeFileSync(join(d, "a.txt"), "hello");
    symlinkSync(join(d, "a.txt"), join(d, "link"));
    mkdirSync(join(d, "dir"));
    expect(readSourceFile(join(d, "a.txt"), "a.txt", 100).toString()).toBe("hello");
    expect(codeOf(() => readSourceFile(join(d, "link"), "link", 100))).toBe("invalid");
    expect(codeOf(() => readSourceFile(join(d, "dir"), "dir", 100))).toBe("invalid");
    expect(codeOf(() => readSourceFile(join(d, "a.txt"), "a.txt", 4))).toBe("invalid");
  });

  test("the walk stops at the first file past a cap, before reading the rest", () => {
    const d = temp("clover-inst-");
    for (let i = 0; i < 5; i++) writeFileSync(join(d, `f${i}`), "x".repeat(10));
    expect(treeEntries(d, { maxFiles: 5 })).toHaveLength(5);
    expect(() => treeEntries(d, { maxFiles: 3 })).toThrow(TreeProblem);
    expect(() => treeEntries(d, { maxFiles: 3 })).toThrow("at most 3 files");
    expect(() => treeEntries(d, { maxBytes: 25 })).toThrow("holds at most");
  });

  test("a rename's failures are the install's: a folder there meanwhile is a conflict; another volume is copied beside and renamed in", () => {
    const d = temp("clover-inst-");
    const staged = join(d, "stage", "tarot");
    mkdirSync(staged, { recursive: true });
    writeFileSync(join(staged, "clover.json"), "{}");
    const plugins = join(d, "plugins");
    mkdirSync(join(plugins, "tarot"), { recursive: true });
    writeFileSync(join(plugins, "tarot", "other"), "theirs");
    for (const code of ["ENOTEMPTY", "EEXIST"]) {
      const fail = () => { throw Object.assign(new Error(code), { code }); };
      expect(codeOf(() => renameInto(staged, join(plugins, "tarot"), "tarot", fail))).toBe("conflict");
    }
    // EXDEV: the first rename (across volumes) fails; the copy beside the destination is renamed in.
    let calls = 0;
    const acrossVolumes = (from: string, to: string) => {
      if (calls++ === 0) throw Object.assign(new Error("EXDEV"), { code: "EXDEV" });
      renameSync(from, to);
    };
    renameInto(staged, join(plugins, "luna"), "luna", acrossVolumes);
    expect(readFileSync(join(plugins, "luna", "clover.json"), "utf8")).toBe("{}");
    expect(readdirSync(plugins).sort()).toEqual(["luna", "tarot"]);
  });

  test("an install's folder that a crash left is swept; an install never lands over one that appeared meanwhile", async () => {
    const d = temp("clover-inst-");
    const stages = join(d, "run", "plugin-install");
    mkdirSync(join(stages, "abc", "tarot"), { recursive: true });
    sweepInstallStages(stages);
    expect(existsSync(stages)).toBe(false);
    const src = join(temp("clover-inst-src-"), "tarot");
    mkdirSync(src);
    writeFileSync(join(src, "clover.json"), JSON.stringify({ manifest: 1, id: "tarot", name: "Tarot", version: "1.0.0" }));
    const plugins = join(d, "plugins");
    // The id's folder appears while the install checks it: refused as a conflict.
    const err = await installFromFolder({
      source: src, pluginsDir: plugins, stagingDir: stages,
      taken: (id) => { mkdirSync(join(plugins, id, "x"), { recursive: true }); return false; },
    }).catch((e: unknown) => e);
    expect((err as ContractError).code).toBe("conflict");
    expect(existsSync(join(plugins, "tarot", "clover.json"))).toBe(false);
  });
});
