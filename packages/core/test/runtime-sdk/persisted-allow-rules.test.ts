// Persisted allow rules reach the runtime child (lane B, 2026-09-22, from lane C's finding).
//
// A card's "Allow … everywhere" / "in this project" writes a rule through `approval.respond`'s
// `PermissionRules.append` — `<home>/settings.json`'s `permissions.allow` (global) or
// `<projectRoot>/.clover/permissions.local.json` (project) — and a TRUSTED project's own
// `.clover/settings.json` `permissions.allow` unions in through `ProjectSettingsResolver`. Nothing read
// any of it on the way to a child: `buildCloverOptions` sent only Clover's fixed read/web allow rules,
// so a saved rule lasted exactly as long as the live bridge that answered the card. claude applies its
// settings files' `permissions.allow` natively; this is the host half of that parity.
//
// Pinned here: the translation from Clover's rule grammar to the runtimes' (`sdkAllowRulesFor`), the
// trust-gated reader (`persistedAllowRulesFor`), and the child's Options (WS-23: one leg). Deny-before-allow on the real
// binary is `persisted-allow-measure.e2e.test.ts`.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CanUseTool } from "@yanlinglabs/winter-agent-sdk";
import type { RuntimeSelection } from "@yanlinglabs/winter-runtime-sdk";
import { ApprovalBroker } from "../../src/agent/approvals";
import { PermissionGate } from "../../src/agent/gate";
import { QuestionBroker } from "../../src/agent/questions";
import { PermissionRules } from "../../src/agent/permission-rules";
import { TrustStore } from "../../src/agent/trust";
import { ProjectSettingsResolver } from "../../src/project-settings";
import { Settings } from "../../src/settings";
import { projectScopeRootFor, projectScopeTrust } from "../../src/runtime-sdk/run-home-input";
import {
  buildCloverOptions, controlPlaneDenyRules, GLOBAL_READ_ALLOW_RULES, persistedAllowRulesFor, projectScopeAllowRulesFor, sdkAllowRulesFor,
  WEB_BUILTIN_ALLOW_RULES, type CloverOptionsInput,
} from "../../src/runtime-sdk/mode-options";

function realDir(prefix: string): string { return realpathSync(mkdtempSync(join(tmpdir(), prefix))); }

function cloverInput(over: Partial<CloverOptionsInput> = {}): CloverOptionsInput {
  return {
    mode: "code", policy: "ask", sessionId: "11111111-2222-3333-4444-555555555555", home: "/h", cwd: "/repo",
    credentials: { byProvider: {} }, spawn: { pathToClaudeCodeExecutable: "/opt/winter" },
    canUseTool: (async () => ({ behavior: "allow" as const })) as CanUseTool, abort: new AbortController(), baseEnv: {},
    ...over,
  };
}

describe("sdkAllowRulesFor — Clover's saved-rule grammar, as the runtimes read it", () => {
  test("bash exact/prefix/any keep their meaning; BashUnsandboxed becomes Bash (claude: the flag only removes the sandbox auto-allow)", () => {
    expect(sdkAllowRulesFor(["Bash(git status)", "Bash(gh repo:*)", "Bash", "BashUnsandboxed(curl:*)"]))
      .toEqual(["Bash(git status)", "Bash(gh repo:*)", "Bash", "Bash(curl:*)"]);
  });

  test("Edit, Computer, Worktree and WebFetch(domain:) map onto the runtimes' own names", () => {
    // `Edit` covers `Write` too, as it always did in Clover — the SDK matches a bare rule's tool name
    // literally, so both are stated (measured: `persisted-allow-measure.e2e.test.ts`).
    expect(sdkAllowRulesFor(["Edit", "Computer", "Worktree", "WebFetch(domain:example.com)"])).toEqual([
      "Edit", "Write",
      "mcp__clover__computer__computer",
      "EnterWorktree", "ExitWorktree",
      "WebFetch(domain:example.com)",
    ]);
  });

  test("Edit(<abs dir>) is NOT forwarded: it declares a writable directory and never silenced a card — as an allow rule it would", () => {
    expect(sdkAllowRulesFor(["Edit(/Users/x/scratch)"])).toEqual([]);
  });

  test("a value containing `*` is NOT forwarded: in the runtimes' grammar it is a glob, i.e. a WIDER rule than the one saved", () => {
    expect(sdkAllowRulesFor(["Bash(*)", "Bash(ls *.txt)", "Bash(rm *:*)", "Edit(/tmp/*)"])).toEqual([]);
  });

  test("a Clover-grammar string Clover itself refuses stays refused; a foreign (runtime-grammar) rule is forwarded verbatim", () => {
    // Bare `WebFetch` would silence every fetch card; `Computer(x)`/relative `Edit` never parse.
    expect(sdkAllowRulesFor(["WebFetch", "Computer(x)", "Edit(src/**)", "Bash()"])).toEqual([]);
    expect(sdkAllowRulesFor(["WebSearch", "mcp__github__get_issue", "Write(//Users/x/notes/**)"]))
      .toEqual(["WebSearch", "mcp__github__get_issue", "Write(//Users/x/notes/**)"]);
  });

  test("duplicates collapse", () => {
    expect(sdkAllowRulesFor(["Bash(a)", "Bash(a)", "BashUnsandboxed(a)"])).toEqual(["Bash(a)"]);
  });
});

describe("persistedAllowRulesFor — global always, the project halves only when the project is TRUSTED", () => {
  function world() {
    const home = realDir("clover-allow-home-");
    const repo = realDir("clover-allow-repo-");
    writeFileSync(join(home, "settings.json"), JSON.stringify({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-sol" }, permissions: { allow: ["Bash(gh repo:*)"] } }));
    mkdirSync(join(repo, ".clover"), { recursive: true });
    writeFileSync(join(repo, ".clover", "settings.json"), JSON.stringify({ permissions: { allow: ["Bash(make test)"] } }));
    writeFileSync(join(repo, ".clover", "permissions.local.json"), JSON.stringify({ allow: ["Bash(npm run lint:*)"] }));
    const trust = new TrustStore(join(home, "trust.json"));
    const base = Settings.parse(JSON.parse(readFileSync(join(home, "settings.json"), "utf8")));
    const resolver = new ProjectSettingsResolver({ base: () => base, trust });
    const rules = new PermissionRules({ globalAllow: (root) => resolver.effective(root)?.permissions?.allow ?? ["Computer"], cloverHome: home });
    const read = (cwd: string) => persistedAllowRulesFor(cwd, {
      projectRootOf: () => repo,
      effectiveSettings: (root) => resolver.effective(root),
      projectRules: (root) => rules.rulesFor(root).project,
      isTrusted: (dir) => trust.isTrusted(dir),
    });
    return { home, repo, trust, read };
  }

  test("an UNTRUSTED project contributes nothing — neither its settings overlay nor its permissions.local.json", () => {
    const w = world();
    expect(w.read(join(w.repo, "sub"))).toEqual(["Bash(gh repo:*)"]);
  });

  test("a TRUSTED project's overlay and its saved project rules join the global ones", () => {
    const w = world();
    w.trust.trust(w.repo);
    expect(w.read(w.repo)).toEqual(["Bash(gh repo:*)", "Bash(make test)", "Bash(npm run lint:*)"]);
  });

  test("nothing configured anywhere → nothing (the engine-era `[\"Computer\"]` getter default is NOT a saved rule)", () => {
    const home = realDir("clover-allow-empty-");
    expect(persistedAllowRulesFor("/nowhere", {
      projectRootOf: () => null, effectiveSettings: () => null, isTrusted: () => false,
    })).toEqual([]);
    expect(home.length).toBeGreaterThan(0);
  });
});

describe("the child's Options carry the saved rules — after Clover's fixed ones, with the deny fence intact", () => {
  test("Clover leg, code: fixed allow + translated saved rules; the control-plane deny list is unchanged", () => {
    const o = buildCloverOptions(cloverInput({ persistedAllow: ["Bash(gh repo:*)", "Edit"] }));
    expect(o.permissions?.allow).toEqual([...GLOBAL_READ_ALLOW_RULES, ...WEB_BUILTIN_ALLOW_RULES, "Bash(gh repo:*)", "Edit", "Write"]);
    // Deny-before-allow is the runtimes' own evaluation order; the fence a saved `Edit` must not beat
    // is still stated in full (the binary proof is the e2e sibling).
    expect(o.permissions?.deny).toEqual(controlPlaneDenyRules("/h"));
    expect(o.permissions?.deny).toContain("Write(//h/settings.json)");
  });

  test("Clover leg: chat and dispatch get no saved rules (chat's policy is fixed; a dispatch card offers no rule to remember)", () => {
    expect(buildCloverOptions(cloverInput({ mode: "chat", policy: "chat", persistedAllow: ["Bash(gh repo:*)"] })).permissions?.allow).toBeUndefined();
    // Dispatch: only Clover's fixed read/web rules (its dont-ask keeps them, as code's does) — never a saved one.
    const d = buildCloverOptions(cloverInput({ mode: "dispatch", policy: "auto", persistedAllow: ["Bash(gh repo:*)"] }));
    expect(d.permissions?.allow).toEqual(["Read", ...WEB_BUILTIN_ALLOW_RULES]);
  });
});

describe("R.3 residual: the daemon's project-scope readers from a linked worktree of a trusted repo", () => {
  function bed() {
    const main = realDir("clover-r3p-allow-main-");
    const git = (args: string[]) => expect(Bun.spawnSync(["git", "-C", main, ...args], { stdout: "ignore", stderr: "ignore" }).exitCode).toBe(0);
    git(["init", "-q"]);
    git(["-c", "user.email=t@t.test", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "i"]);
    const wt = join(realDir("clover-r3p-allow-wt-"), "wt");
    git(["worktree", "add", "-q", "-b", `r3p-${Math.random().toString(16).slice(2)}`, wt]);
    for (const [dir, rule] of [[main, "Bash(main-only)"], [wt, "Bash(wt-only)"]] as const) {
      mkdirSync(join(dir, ".clover"), { recursive: true });
      writeFileSync(join(dir, ".clover", "settings.json"), JSON.stringify({ permissions: { allow: [rule] } }));
    }
    const trust = new TrustStore(join(realDir("clover-r3p-allow-home-"), "trust.json"));
    trust.trust(main);
    const resolver = new ProjectSettingsResolver({ base: () => Settings.parse({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-sol" } }), trust: projectScopeTrust(trust) });
    const allowFor = (cwd: string) => projectScopeAllowRulesFor(cwd, {
      effectiveSettings: (root) => resolver.effective(root),
      approvedProjectRules: (key) => (key === main ? ["Bash(approved)"] : []),
      trust,
    });
    return { main, wt: realpathSync(wt), resolver, allowFor };
  }

  test("from the worktree: its OWN overlay (trusted through its repository) and the approved record at the repo key", () => {
    const b = bed();
    expect(b.resolver.effective(projectScopeRootFor(b.wt))?.permissions?.allow).toEqual(["Bash(wt-only)"]);
    const rules = b.allowFor(b.wt);
    expect(rules).toContain("Bash(wt-only)");
    expect(rules).toContain("Bash(approved)");
    expect(rules).not.toContain("Bash(main-only)");
  });

  test("from the MAIN checkout nothing changes", () => {
    const b = bed();
    expect(b.resolver.effective(projectScopeRootFor(b.main))?.permissions?.allow).toEqual(["Bash(main-only)"]);
    expect(b.allowFor(b.main).sort()).toEqual(["Bash(approved)", "Bash(main-only)"]);
  });
});
