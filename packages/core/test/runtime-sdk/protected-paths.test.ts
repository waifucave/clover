// WS-21 L3.6 (spec §7.2): the protected paths, and the §7.1 hook rows that sit beside them.
//
//   protected  the trusted project's `.clover/{skills,commands,rules,output-styles}/**`,
//              `sdk/{skills,commands,rules,output-styles}/**` and `sdk/CLOVER.md`
//   a write    code → a card under every policy; chat and dispatch → a typed deny
//
// The set is pinned against the LITERAL list spec §7.2 names, spelled the way L2's
// `protectedPathRules` (`winter-runtime-sdk` `src/run-home/types.ts` at aa5201e, fix round 1 adds the walk) spells it — claude's
// absolute form, `//` + the absolute path, built with the daemon's own `fsRootAnchored` (ruling 2).
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  projectWalk, protectedPathsFor, protectedReadDenial, protectedWriteDecision, storeWriteDenial,
} from "../../src/runtime-sdk/protected-paths";

const real = (p: string): string => realpathSync(mkdtempSync(join(tmpdir(), p)));

describe("protectedPathsFor — spec §7.2's literal set, in claude's absolute spelling", () => {
  test("no trusted project: the sdk tier alone", () => {
    expect(protectedPathsFor("/Users/x/.clover", null)).toEqual([
      "//Users/x/.clover/sdk/skills/**",
      "//Users/x/.clover/sdk/commands/**",
      "//Users/x/.clover/sdk/rules/**",
      "//Users/x/.clover/sdk/output-styles/**",
      "//Users/x/.clover/sdk/CLOVER.md",
    ]);
  });

  test("a trusted project adds its .clover/{skills,commands,rules,output-styles}; <root>/CLOVER.md stays ordinary", () => {
    const set = protectedPathsFor("/Users/x/.clover", "/Users/x/code/app");
    expect(set).toEqual([
      "//Users/x/.clover/sdk/skills/**",
      "//Users/x/.clover/sdk/commands/**",
      "//Users/x/.clover/sdk/rules/**",
      "//Users/x/.clover/sdk/output-styles/**",
      "//Users/x/.clover/sdk/CLOVER.md",
      "//Users/x/code/app/.clover/skills/**",
      "//Users/x/code/app/.clover/commands/**",
      "//Users/x/code/app/.clover/rules/**",
      "//Users/x/code/app/.clover/output-styles/**",
    ]);
    expect(set).not.toContain("//Users/x/code/app/CLOVER.md");
  });

  test("with a walk: every directory from the cwd up to the trusted root, nearest first (L2 fix round 1, I2)", () => {
    expect(protectedPathsFor("/Users/x/.clover", "/Users/x/code/app", { cwd: "/Users/x/code/app/packages/web", userHome: "/Users/x" })).toEqual([
      "//Users/x/.clover/sdk/skills/**",
      "//Users/x/.clover/sdk/commands/**",
      "//Users/x/.clover/sdk/rules/**",
      "//Users/x/.clover/sdk/output-styles/**",
      "//Users/x/.clover/sdk/CLOVER.md",
      "//Users/x/code/app/packages/web/.clover/skills/**",
      "//Users/x/code/app/packages/web/.clover/commands/**",
      "//Users/x/code/app/packages/web/.clover/rules/**",
      "//Users/x/code/app/packages/web/.clover/output-styles/**",
      "//Users/x/code/app/packages/.clover/skills/**",
      "//Users/x/code/app/packages/.clover/commands/**",
      "//Users/x/code/app/packages/.clover/rules/**",
      "//Users/x/code/app/packages/.clover/output-styles/**",
      "//Users/x/code/app/.clover/skills/**",
      "//Users/x/code/app/.clover/commands/**",
      "//Users/x/code/app/.clover/rules/**",
      "//Users/x/code/app/.clover/output-styles/**",
    ]);
  });

  test("the walk stops at $HOME, and is empty when the cwd lies outside the root (the router's projectWalk)", () => {
    expect(projectWalk("/Users/x/code/app/a", "/Users/x/code/app", "/Users/x")).toEqual(["/Users/x/code/app/a", "/Users/x/code/app"]);
    expect(projectWalk("/Users/x/notes", "/Users/x", "/Users/x")).toEqual(["/Users/x/notes"]);   // $HOME itself never
    expect(projectWalk("/Users/x", "/Users/x", "/Users/x")).toEqual([]);
    expect(projectWalk("/elsewhere", "/Users/x/code/app", "/Users/x")).toEqual([]);
    expect(projectWalk("/Users/x/code/app", null, "/Users/x")).toEqual([]);
    // a trusted root at $HOME protects nothing of its own tier
    expect(protectedPathsFor("/h", "/Users/x", { cwd: "/Users/x", userHome: "/Users/x" })).toHaveLength(5);
  });

  test("as Edit/Write rules it is exactly the router's protectedPathRules output (hand mirror at aa5201e, no walk)", () => {
    const rules = ["Edit", "Write"].flatMap((t) => protectedPathsFor("/h", "/r").map((p) => `${t}(${p})`));
    const routerMirror = ["Edit", "Write"].flatMap((t) => [
      "//h/sdk/skills/**", "//h/sdk/commands/**", "//h/sdk/rules/**", "//h/sdk/output-styles/**", "//h/sdk/CLOVER.md",
      "//r/.clover/skills/**", "//r/.clover/commands/**", "//r/.clover/rules/**", "//r/.clover/output-styles/**",
    ].map((p) => `${t}(${p})`));
    expect(rules).toEqual(routerMirror);
  });
});

describe("protectedWriteDecision", () => {
  const home = "/Users/x/.clover";
  const root = "/Users/x/code/app";
  const set = protectedPathsFor(home, root);

  test("code → ask, whatever the policy (the hook knows no policy: accept-edits and bypass reach it the same)", () => {
    for (const [tool, input] of [
      ["Write", { file_path: `${root}/.clover/skills/deploy/SKILL.md`, content: "x" }],
      ["Edit", { file_path: `${home}/sdk/CLOVER.md`, old_string: "a", new_string: "b" }],
      ["MultiEdit", { file_path: "/tmp/ok.txt", edits: [{ file_path: `${home}/sdk/rules/style.md` }] }],
      ["NotebookEdit", { notebook_path: `${root}/.clover/commands/n.ipynb` }],
      ["write", { path: `${root}/.clover/output-styles/terse.md` }],
    ] as const) {
      expect(protectedWriteDecision(tool, input, { mode: "code", protected: set, cwd: root })).toEqual({ decision: "ask" });
    }
  });

  test("chat → a typed deny naming the path; dispatch → ask, like code (user ruling 2026-10-17)", () => {
    const d = protectedWriteDecision("Write", { file_path: `${root}/.clover/rules/a.md` }, { mode: "chat", protected: set, cwd: root });
    expect(d?.decision).toBe("deny");
    expect((d as { reason: string }).reason).toContain(".clover/rules/a.md");
    expect(protectedWriteDecision("Write", { file_path: `${root}/.clover/rules/a.md` }, { mode: "dispatch", protected: set, cwd: root })).toEqual({ decision: "ask" });
  });

  test("an .envrc-named protected file is still an ask (claude's own sensitive-file check must not swallow it — F16)", () => {
    expect(protectedWriteDecision("Write", { file_path: `${root}/.clover/skills/x/.envrc` }, { mode: "code", protected: set, cwd: root })).toEqual({ decision: "ask" });
  });

  test("a nested project dir on the walk is protected like the root's", () => {
    const walkSet = protectedPathsFor(home, root, { cwd: `${root}/packages/web`, userHome: "/Users/x" });
    expect(protectedWriteDecision("Write", { file_path: `${root}/packages/web/.clover/skills/a/SKILL.md` }, { mode: "code", protected: walkSet, cwd: root })).toEqual({ decision: "ask" });
    // Review C1: a sibling subtree off the walk is protected too — a later session there loads it.
    expect(protectedWriteDecision("Write", { file_path: `${root}/packages/api/.clover/skills/a/SKILL.md` }, { mode: "code", protected: walkSet, cwd: root })).toEqual({ decision: "ask" });
  });

  test("a relative target resolves against the cwd", () => {
    expect(protectedWriteDecision("Write", { file_path: ".clover/skills/a/SKILL.md" }, { mode: "code", protected: set, cwd: root })).toEqual({ decision: "ask" });
  });

  test("case-folded (a default macOS volume is case-insensitive)", () => {
    expect(protectedWriteDecision("Write", { file_path: `${root}/.CLOVER/Skills/a.md` }, { mode: "code", protected: set, cwd: root })).toEqual({ decision: "ask" });
  });

  test("review C1: ANY .clover/{skills,commands,rules,output-styles} at any depth, trusted or not", () => {
    const untrusted = protectedPathsFor(home, null);
    for (const p of [
      `${root}/.clover/skills/a.md`,                               // an untrusted project: it loads once trusted
      `${root}/packages/app/.clover/commands/deploy.md`,           // below the cwd
      `/elsewhere/other/.clover/rules/r.md`,                       // another project entirely
      `${root}/a/b/c/.clover/output-styles/terse.md`,
      `${root}/packages/app/.clover/skills`,                       // the directory itself
    ]) {
      expect({ p, d: protectedWriteDecision("Write", { file_path: p }, { mode: "code", protected: untrusted, cwd: root }) }).toEqual({ p, d: { decision: "ask" } });
    }
    expect(protectedWriteDecision("Write", { file_path: `${root}/.clover/skillset/a.md` }, { mode: "code", protected: untrusted, cwd: root })).toBeNull();
    expect(protectedWriteDecision("Write", { file_path: `${root}/.clover/agents-notes.md` }, { mode: "code", protected: untrusted, cwd: root })).toBeNull();
  });

  test("not protected: <root>/CLOVER.md, reads, the memory dir", () => {
    expect(protectedWriteDecision("Write", { file_path: `${root}/CLOVER.md` }, { mode: "code", protected: set, cwd: root })).toBeNull();
    expect(protectedWriteDecision("Read", { file_path: `${root}/.clover/skills/a.md` }, { mode: "code", protected: set, cwd: root })).toBeNull();
    expect(protectedWriteDecision("Write", { file_path: `${home}/sdk/projects/k/memory/MEMORY.md` }, { mode: "code", protected: set, cwd: root })).toBeNull();
    expect(protectedWriteDecision("Write", { file_path: `${home}/sdk/skillset/a.md` }, { mode: "code", protected: set, cwd: root })).toBeNull();
  });

  test("a write through a link INTO a protected directory is caught on its canonical spelling", () => {
    const h = real("clover-prot-home-");
    const r = real("clover-prot-root-");
    mkdirSync(join(r, ".clover", "skills"), { recursive: true });
    const alias = join(real("clover-prot-alias-"), "sneaky");
    symlinkSync(join(r, ".clover", "skills"), alias);
    const d = protectedWriteDecision("Write", { file_path: join(alias, "evil", "SKILL.md") }, { mode: "code", protected: protectedPathsFor(h, r), cwd: "/" });
    expect(d).toEqual({ decision: "ask" });
  });
});

describe("storeWriteDenial — spec §7.1: sdk/projects/** is written by the runtimes, never by a tool, except */memory/**", () => {
  const home = "/Users/x/.clover";
  test("a transcript or anything else under sdk/projects is denied, in every mode", () => {
    for (const p of [`${home}/sdk/projects/-Users-x-app/abc.jsonl`, `${home}/sdk/projects/k/subagents/a.jsonl`, `${home}/sdk/projects`]) {
      const d = storeWriteDenial("Write", { file_path: p }, { home, cwd: "/" });
      expect(d).toBeDefined();
      expect(d).toContain("sdk/projects");
    }
  });
  test("the memory directory stays writable", () => {
    expect(storeWriteDenial("Write", { file_path: `${home}/sdk/projects/k/memory/MEMORY.md` }, { home, cwd: "/" })).toBeUndefined();
    expect(storeWriteDenial("Edit", { file_path: `${home}/sdk/projects/k/memory/notes/a.md` }, { home, cwd: "/" })).toBeUndefined();
  });
  test("reads are not this function's business; neither is anything outside sdk/projects", () => {
    expect(storeWriteDenial("Read", { file_path: `${home}/sdk/projects/k/a.jsonl` }, { home, cwd: "/" })).toBeUndefined();
    expect(storeWriteDenial("Write", { file_path: `${home}/outputs/s_1/report.md` }, { home, cwd: "/" })).toBeUndefined();
  });
});

describe("protectedReadDenial — spec §7.1's read row (hook half)", () => {
  const home = "/Users/x/.clover";
  const tmp = tmpdir();
  test("sdk/.clover.json and the three config files in any run folder or staging root", () => {
    for (const p of [
      `${home}/sdk/.clover.json`,
      `${home}/cache/runs/2b1c/.clover.json`,
      `${home}/cache/runs/2b1c/.claude.json`,
      `${home}/cache/runs/2b1c/.credentials.json`,
      join(tmp, "claude-resume-8f2a", ".claude.json"),
      join(tmp, "claude-resume-8f2a", ".credentials.json"),
    ]) {
      for (const tool of ["Read", "Grep", "Glob"]) {
        const field = tool === "Read" ? "file_path" : "path";
        expect(protectedReadDenial(tool, { [field]: p }, { home, cwd: "/" })).toBeDefined();
      }
    }
  });
  test("a Grep rooted inside a run folder or at sdk/ is refused too (it would read them)", () => {
    expect(protectedReadDenial("Grep", { path: `${home}/cache/runs/2b1c`, pattern: "token" }, { home, cwd: "/" })).toBeDefined();
    expect(protectedReadDenial("Grep", { path: `${home}/sdk`, pattern: "token" }, { home, cwd: "/" })).toBeDefined();
  });
  test("ordinary reads stay free", () => {
    expect(protectedReadDenial("Read", { file_path: `${home}/sdk/settings.json` }, { home, cwd: "/" })).toBeUndefined();
    expect(protectedReadDenial("Read", { file_path: `${home}/cache/runs/2b1c/skills/a/SKILL.md` }, { home, cwd: "/" })).toBeUndefined();
    expect(protectedReadDenial("Read", { file_path: "/Users/x/code/app/.clover.json" }, { home, cwd: "/" })).toBeUndefined();
    expect(protectedReadDenial("Grep", { path: "/Users/x/code/app", pattern: "x" }, { home, cwd: "/" })).toBeUndefined();
    expect(protectedReadDenial("Write", { file_path: `${home}/sdk/.clover.json` }, { home, cwd: "/" })).toBeUndefined();
  });
});
