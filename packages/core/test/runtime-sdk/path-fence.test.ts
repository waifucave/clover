// WS-21 L3.6 (spec §7.1 "hook" column, §7.2): the path fence as a PreToolUse hook on both legs, and the
// bridge's third layer — a protected write is never auto-allowed, under any policy.
import { describe, expect, test } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CanUseTool, HookCallback, HookCallbackMatcher } from "@waifucave/clover-agent-sdk";
import { ApprovalBroker } from "../../src/agent/approvals";
import { QuestionBroker } from "../../src/agent/questions";
import { PermissionGate, type SessionApprovalPolicy } from "../../src/agent/gate";
import { canUseToolFor, type BridgeLogger } from "../../src/runtime-sdk/approval-bridge";
import { BASH_WRITE_CHECK_BOUND, _setInodeScanBudgetForTests, bashProtectedWriteHit, sessionHooksFor, type SessionHooksDeps } from "../../src/runtime-sdk/hooks";

const real = (p: string): string => realpathSync(mkdtempSync(join(tmpdir(), p)));
const silent: BridgeLogger = { info: () => {}, error: () => {} };

/** The path fence: the unmatched PreToolUse group registered after the plugin group. */
function fenceOf(deps: Partial<SessionHooksDeps> & { home: string }): HookCallback {
  const built = sessionHooksFor({ sessionId: "s_1", roots: [deps.cwd ?? "/tmp"], ...deps });
  const unmatched = (built.moss?.PreToolUse ?? []).filter((g: HookCallbackMatcher) => g.matcher === undefined);
  expect(unmatched).toHaveLength(2); // the plugin group, then the fence
  return unmatched[1]!.hooks[0]!;
}
const call = async (hook: HookCallback, tool_name: string, tool_input: Record<string, unknown>) =>
  (await hook({ hook_event_name: "PreToolUse", tool_name, tool_input, session_id: "b", transcript_path: "", cwd: "/" } as never, "tu1", { signal: new AbortController().signal })) as {
    hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
  };
const decisionOf = (r: Awaited<ReturnType<typeof call>>) => r.hookSpecificOutput?.permissionDecision ?? "none";

describe("the path fence hook", () => {
  const home = "/Users/x/.moss";
  const root = "/Users/x/code/app";

  test("a protected write: ask in code and dispatch (user ruling 2026-10-17), deny in chat", async () => {
    const input = { file_path: `${root}/.moss/skills/deploy/SKILL.md`, content: "x" };
    for (const mode of ["code", "dispatch"] as const) {
      expect(decisionOf(await call(fenceOf({ home, cwd: root, mode, trustedProjectRoot: () => root }), "Write", input))).toBe("ask");
    }
    expect(decisionOf(await call(fenceOf({ home, cwd: root, mode: "chat", trustedProjectRoot: () => root }), "Write", input))).toBe("deny");
    // the sdk tier needs no trusted project
    expect(decisionOf(await call(fenceOf({ home, cwd: root, mode: "code" }), "Edit", { file_path: `${home}/sdk/MOSS.md` }))).toBe("ask");
  });

  test("review C1: the project tier is protected whatever the trust, at any depth (it loads once trusted)", async () => {
    const hook = fenceOf({ home, cwd: root, mode: "code", trustedProjectRoot: () => null });
    expect(decisionOf(await call(hook, "Write", { file_path: `${root}/.moss/rules/a.md` }))).toBe("ask");
    expect(decisionOf(await call(hook, "Write", { file_path: `${root}/packages/app/.moss/skills/x/SKILL.md` }))).toBe("ask");
  });

  test("sdk/projects is denied outside memory/; the memory directory is free", async () => {
    const hook = fenceOf({ home, cwd: root, mode: "code" });
    expect(decisionOf(await call(hook, "Write", { file_path: `${home}/sdk/projects/-Users-x-code-app/abc.jsonl` }))).toBe("deny");
    expect(decisionOf(await call(hook, "Write", { file_path: `${home}/sdk/projects/-Users-x-code-app/memory/MEMORY.md` }))).toBe("none");
  });

  test("a project's .moss/mcp.json and any .moss/settings*.json are denied on every policy", async () => {
    const hook = fenceOf({ home, cwd: root, mode: "code" });
    for (const f of ["mcp.json", "settings.json", "settings.local.json", "settings.team.json"]) {
      const r = await call(hook, "Write", { file_path: `${root}/.moss/${f}` });
      expect(decisionOf(r)).toBe("deny");
    }
    expect((await call(hook, "Write", { file_path: `${root}/.moss/mcp.json` })).hookSpecificOutput?.permissionDecisionReason).toContain("moss mcp add --scope project");
  });

  test("the home fence binds as a hook too: sdk/settings.json, sdk/.moss.json, sdk/plugins, sdk/agents, the cache", async () => {
    const hook = fenceOf({ home, cwd: root, mode: "code" });
    for (const p of [`${home}/sdk/settings.json`, `${home}/sdk/.moss.json`, `${home}/sdk/plugins/x/plugin.json`, `${home}/sdk/agents/a.md`, `${home}/cache/runs/r/settings.json`]) {
      expect(decisionOf(await call(hook, "Write", { file_path: p }))).toBe("deny");
    }
  });

  test("reads: sdk/.moss.json and a run folder's generated config are denied; everything else is free", async () => {
    const hook = fenceOf({ home, cwd: root, mode: "code" });
    expect(decisionOf(await call(hook, "Read", { file_path: `${home}/sdk/.moss.json` }))).toBe("deny");
    expect(decisionOf(await call(hook, "Read", { file_path: `${home}/cache/runs/r1/.claude.json` }))).toBe("deny");
    expect(decisionOf(await call(hook, "Read", { file_path: `${home}/sdk/settings.json` }))).toBe("none");
    expect(decisionOf(await call(hook, "Read", { file_path: `${root}/src/index.ts` }))).toBe("none");
    expect(decisionOf(await call(hook, "Bash", { command: "ls" }))).toBe("none");
  });

  test("no home: no fence group at all (the diff producer's own convention)", () => {
    const built = sessionHooksFor({ sessionId: "s_1", roots: ["/tmp"] });
    expect((built.moss?.PreToolUse ?? []).filter((g: HookCallbackMatcher) => g.matcher === undefined)).toHaveLength(1);
  });
});

describe("the bridge never auto-allows a protected write (spec §7.2, layer 3)", () => {
  const home = real("moss-fence-home-");
  const root = real("moss-fence-root-");
  const ctx = (): Parameters<CanUseTool>[2] => ({ signal: new AbortController().signal, toolUseID: `tu-${Math.random()}`, requestId: "r" } as Parameters<CanUseTool>[2]);
  function bridge(policy: SessionApprovalPolicy, over: { mode?: "code" | "dispatch"; origin?: string; trusted?: boolean } = {}) {
    const approvals = new ApprovalBroker();
    const canUse = canUseToolFor({
      sessionId: "s_1", mode: over.mode ?? "code", ...(over.origin ? { origin: over.origin } : {}), policy,
      approvals, questions: new QuestionBroker(), gate: new PermissionGate(), emit: () => {}, log: silent,
      home, cwd: root, projectTrusted: () => over.trusted ?? true,
    });
    return { canUse, approvals };
  }
  const protectedInput = { file_path: join(root, ".moss", "skills", "a", "SKILL.md"), content: "x" };

  for (const policy of ["bypass", "accept-edits", "auto"] as const) {
    test(`${policy}: a protected write raises a card instead of running`, async () => {
      const { canUse, approvals } = bridge(policy);
      const pending = canUse("Write", protectedInput, ctx());
      await new Promise((r) => setTimeout(r, 10));
      const listed = approvals.list("s_1");
      expect(listed).toHaveLength(1);
      approvals.resolve("s_1", listed[0]!.callId, false, "test");
      expect((await pending)?.behavior).toBe("deny");
      // …while an ordinary write under the same policy still runs without one
      expect((await canUse("Write", { file_path: join(root, "src", "a.ts"), content: "x" }, ctx()))?.behavior).toBe("allow");
    });
  }

  test("dont-ask declines it; a dispatch child's is a card (relayed to its coordinator), never an allow", async () => {
    expect((await bridge("dont-ask").canUse("Write", protectedInput, ctx()))?.behavior).toBe("deny");
    const child = bridge("bypass", { origin: "dispatch-child" });
    const pending = child.canUse("Write", protectedInput, ctx());
    await new Promise((r) => setTimeout(r, 10));
    const listed = child.approvals.list("s_1");
    expect(listed).toHaveLength(1);
    child.approvals.resolve("s_1", listed[0]!.callId, false, "test");
    expect((await pending)?.behavior).toBe("deny");
  });

  test("review C1: at the repo root under bypass, a nested project dir's skill is a card, trusted or not", async () => {
    for (const trusted of [true, false]) {
      const { canUse, approvals } = bridge("bypass", { trusted });
      const pending = canUse("Write", { file_path: join(root, "packages", "app", ".moss", "skills", "x", "SKILL.md"), content: "x" }, ctx());
      await new Promise((r) => setTimeout(r, 10));
      const listed = approvals.list("s_1");
      expect(listed).toHaveLength(1);
      approvals.resolve("s_1", listed[0]!.callId, false, "test");
      expect((await pending)?.behavior).toBe("deny");
    }
  });

  test("the sdk tier is protected whatever the project's trust", async () => {
    const { canUse, approvals } = bridge("bypass", { trusted: false });
    const pending = canUse("Edit", { file_path: join(home, "sdk", "rules", "a.md"), old_string: "a", new_string: "b" }, ctx());
    await new Promise((r) => setTimeout(r, 10));
    const listed = approvals.list("s_1");
    expect(listed).toHaveLength(1);
    approvals.resolve("s_1", listed[0]!.callId, true, "test");
    expect((await pending)?.behavior).toBe("allow");
  });
});

// Fix round 2 (controller ruling on SPEC CONCERN D): the sandbox cannot fence `.moss/<kind>` off the
// walk (real subpaths only), so ANY Bash command — sandboxed or not — that WRITES under a
// `.moss/{skills,commands,rules,output-styles,agents}` segment, at any depth and whatever the trust, is
// asked about: a card in code, a typed deny where nobody can answer. Read-only mentions pass.
describe("fix round 2: Bash writes under .moss/<kind>", () => {
  const writes = [
    "mkdir -p pkg/a/.moss/skills/x",
    "echo evil > pkg/.moss/rules/r.md",
    "cp evil.md sub/.moss/commands/",
    "cd sub/.moss/agents && tee x.md < /dev/null",
    "sed -i 's/a/b/' .moss/output-styles/terse.md",
    "echo x | tee /elsewhere/proj/.MOSS/Skills/a/SKILL.md",
  ];
  const reads = [
    "cat .moss/skills/x/SKILL.md",
    "ls pkg/.moss/rules",
    "grep -r foo .moss/commands",
    "cat .moss/agents/a.md > /tmp/copy.md",
    "sed 's/a/b/' .moss/rules/r.md",
  ];
  const outside = ["mkdir -p pkg/moss/skills/x", "echo x > notes/.moss-skills.md", "cp a.md .moss/other/b.md"];

  test("the detector: writes hit, reads and paths outside the protected kinds do not", () => {
    for (const cmd of writes) expect({ cmd, hit: bashProtectedWriteHit(cmd) !== undefined }).toEqual({ cmd, hit: true });
    for (const cmd of [...reads, ...outside]) expect({ cmd, hit: bashProtectedWriteHit(cmd) }).toEqual({ cmd, hit: undefined });
  });

  // Round 3, minor 10: reads that wrongly got a card. Each shell segment (split on `;`, `&&`, `||`, `|`,
  // newlines — never inside quotes) is judged on its own, a `cd` carried across them; git's read
  // subcommands are no write; for cp/mv/ln/install/rsync only the destination (the last operand, or `-t`)
  // is the write target. Every write case above still gets its card.
  test("round 3, minor 10: each segment judged alone; git reads and a copy's source get no card", () => {
    const noCard = [
      "git status && ls .moss/rules",
      "cat a 2>/dev/null; cat .moss/commands/x.md",
      "mkdir -p build && grep -r foo .moss/rules",
      "git log -- .moss/skills",
      "cp .moss/skills/a/ref.md /tmp/",
      "cd .moss/skills && git status",
      "git diff HEAD~1 -- .moss/rules/r.md | cat",
      "echo 'a; b > .moss/rules/x' && ls",          // a separator and a redirect INSIDE quotes are text
      "cat .moss/agents/a.md 2>&1 | grep name",
    ];
    for (const cmd of noCard) expect({ cmd, hit: bashProtectedWriteHit(cmd) }).toEqual({ cmd, hit: undefined });
    const stillWrites = [
      ...writes,
      "cp -t .moss/rules a.md b.md",
      "cp --target-directory=.moss/commands a.md",
      "git status; echo x > .moss/rules/r.md",
      "ls\ntouch .moss/rules/r.md",
      "cd .moss/skills && touch new/SKILL.md",
      "cd pkg && cd .moss && mkdir commands",
      "rsync -a src/ .moss/agents/",
      "ln -s /tmp/x .moss/commands/x.md",
      "git checkout -- .moss/rules",
      "cat a >> .moss/rules/r.md",
      "echo x >.moss/rules/r.md",
      "true && (cd pkg/.moss/skills && touch x)",
    ];
    for (const cmd of stillWrites) expect({ cmd, hit: bashProtectedWriteHit(cmd) !== undefined }).toEqual({ cmd, hit: true });
  });

  // Round 3, minor 9: write shapes the check missed — an interpreter one-liner (`python`/`python3`/`node`/
  // `bun`/`ruby`/`perl`/`deno` with `-c`, `-e` or `--eval`) that names a protected segment anywhere in its
  // code, and gawk's `-i inplace`. (A path built from variables, `git apply` and `patch <` stay beyond a
  // static check — the code comment says so.)
  test("round 3, minor 9: interpreter one-liners and awk -i inplace naming a protected segment are writes", () => {
    const writes9 = [
      `python3 -c "import os; open('.moss/rules/x.md','w').write('y')"`,
      `python -c "import os; os.makedirs('pkg/.moss/skills', exist_ok=True)"`,
      `python3.12 -c "open('.moss/agents/a.md','w')"`,
      `node -e "require('fs').writeFileSync('.moss/commands/c.md','x')"`,
      `node --eval "require('fs').mkdirSync('.moss/output-styles')"`,
      `bun -e "await Bun.write('.moss/rules/r.md', 'x')"`,
      `ruby -e "File.write('.moss/rules/r.md', 'x')"`,
      `perl -e 'open(my $f, ">", ".moss/rules/r.md")'`,
      `deno eval "Deno.writeTextFileSync('.moss/skills/s/SKILL.md', 'x')"`,
      `cd pkg && python3 -c "open('.moss/rules/r.md','w')"`,
      "awk -i inplace '{print}' .moss/rules/r.md",
    ];
    for (const cmd of writes9) expect({ cmd, hit: bashProtectedWriteHit(cmd) !== undefined }).toEqual({ cmd, hit: true });
    for (const cmd of [
      `python3 -c "print(1)" && cat .moss/rules/r.md`,
      "awk '{print}' .moss/rules/r.md",
      `node -e "console.log(1)"`,
      `python3 -c "open('.moss/rulesets.md','w')"`,
    ]) expect({ cmd, hit: bashProtectedWriteHit(cmd) }).toEqual({ cmd, hit: undefined });
  });

  // Round 4, minor 2: write shapes round 3's per-segment rules had stopped asking about — a short-flag cluster
  // holding `t` and the space-separated `--target-directory`, an option after the destination, `find -exec`
  // (both terminators), and a `cd` inside a command substitution (both spellings).
  test("round 4, minor 2: -t clusters, --target-directory <dir>, trailing options, find -exec and substitutions ask", () => {
    const writes4 = [
      "cp -rt .moss/skills/x src/",
      "cp --target-directory .moss/skills/x a.md",
      "rsync -a src/ .moss/skills/x/ --exclude tmp",
      "find . -name '*.md' -exec cp {} .moss/skills/ +",
      "find . -name '*.md' -exec cp {} .moss/skills/ \;",
      "find src -execdir mv {} ../.moss/rules/ \;",
      "echo $(cd .moss/skills; touch x)",
      "echo `cd .moss/skills; touch x`",
      'echo "$(touch .moss/rules/r.md)"',
    ];
    for (const cmd of writes4) expect({ cmd, hit: bashProtectedWriteHit(cmd) !== undefined }).toEqual({ cmd, hit: true });
    const stillNoCard = [
      "git status && ls .moss/rules",
      "cat a 2>/dev/null; cat .moss/commands/x.md",
      "mkdir -p build && grep -r foo .moss/rules",
      "git log -- .moss/skills",
      "cp .moss/skills/a/ref.md /tmp/",
      "cd .moss/skills && git status",
      "find .moss/skills -name '*.md' -exec cat {} +",
      "echo $(cat .moss/rules/r.md)",
      "rsync -a .moss/skills/ /tmp/backup/ --exclude tmp",
    ];
    for (const cmd of stillNoCard) expect({ cmd, hit: bashProtectedWriteHit(cmd) }).toEqual({ cmd, hit: undefined });
  });

  // Round 5 (regression since round 3): a shell's `-c` string and `eval`'s argument are COMMANDS, not text —
  // `quotedOperatorsAsText` blanked the redirect inside their quotes, so none of these asked. The string is
  // judged as a command of its own, like an interpreter one-liner.
  test("round 5: a shell -c string and eval's argument are judged as commands", () => {
    const writes5 = [
      `bash -c "echo x > .moss/rules/a"`,
      `sh -c 'cat > .moss/skills/x/SKILL.md'`,
      `zsh -c "printf x >> .moss/commands/c.md"`,
      `eval "echo x > .moss/rules/a"`,
      `find . -exec sh -c 'cp "$0" .moss/skills/' {} \;`,
      `bash -lc 'mkdir -p .moss/agents'`,
      `cd pkg && dash -c "touch .moss/output-styles/o.md"`,
      `sudo ksh -c "tee .moss/rules/r.md < x"`,
    ];
    for (const cmd of writes5) expect({ cmd, hit: bashProtectedWriteHit(cmd) !== undefined }).toEqual({ cmd, hit: true });
    for (const cmd of [
      `bash -c "cat .moss/rules/a"`,
      `sh -c 'ls .moss/skills && git status'`,
      `eval "cat .moss/rules/a"`,
      `find . -exec sh -c 'cat "$0"' {} \;`,
      `bash script.sh .moss/rules`,
      `echo 'a; b > .moss/rules/x' && ls`,
    ]) expect({ cmd, hit: bashProtectedWriteHit(cmd) }).toEqual({ cmd, hit: undefined });
  });

  // R.3 I-4: git's read subcommands still WRITE a file through `--output` (`git show`/`log`/`diff`/
  // `format-patch`) — the flag is write-shaped whatever the subcommand.
  test("R.3 I-4: a git --output=/--output target is a write, read subcommand or not", () => {
    for (const cmd of [
      "git show -s --format=%B --output=pkg/.moss/rules/x.md",
      "git log -1 --output pkg/.moss/skills/x/SKILL.md",
      "git -C sub diff --output=.moss/commands/c.md HEAD~1",
      "cd pkg && git show HEAD:README.md --output=.moss/agents/a.md",
    ]) expect({ cmd, hit: bashProtectedWriteHit(cmd) !== undefined }).toEqual({ cmd, hit: true });
    for (const cmd of ["git show -s --output=notes.md", "git diff --output=/tmp/x.patch", "git log .moss/rules"]) {
      expect({ cmd, hit: bashProtectedWriteHit(cmd) }).toEqual({ cmd, hit: undefined });
    }
  });

  test("the hook asks (both legs, sandboxed or not); a read gets no answer from it", async () => {
    const built = sessionHooksFor({ sessionId: "s_1", roots: ["/r"], home: "/Users/x/.moss", mode: "code" });
    const groups = (built.moss?.PreToolUse ?? []).filter((g: HookCallbackMatcher) => g.matcher === "Bash");
    const run = async (command: string, escape = false) => {
      const answers: string[] = [];
      for (const g of groups) for (const h of g.hooks) {
        const r = await call(h, "Bash", { command, ...(escape ? { dangerouslyDisableSandbox: true } : {}) });
        answers.push(decisionOf(r));
      }
      return answers;
    };
    for (const cmd of writes) expect(await run(cmd)).toContain("ask");
    for (const cmd of [...reads, ...outside]) expect(await run(cmd)).not.toContain("ask");
  });

  test("the bridge never auto-allows one: bypass/dispatch → card, dont-ask/chat → deny; a read runs", async () => {
    const home = real("moss-fr2-home-");
    const root = real("moss-fr2-root-");
    const ctx = (): Parameters<CanUseTool>[2] => ({ signal: new AbortController().signal, toolUseID: `tu-${Math.random()}`, requestId: "r" } as Parameters<CanUseTool>[2]);
    const mk = (policy: SessionApprovalPolicy, mode: "code" | "dispatch" | "chat" = "code") => {
      const approvals = new ApprovalBroker();
      return { approvals, canUse: canUseToolFor({ sessionId: "s_1", mode, policy, approvals, questions: new QuestionBroker(), gate: new PermissionGate(), emit: () => {}, log: silent, home, cwd: root }) };
    };
    const b = mk("bypass");
    const pending = b.canUse("Bash", { command: "mkdir -p pkg/a/.moss/skills/x" }, ctx());
    await new Promise((r) => setTimeout(r, 10));
    expect(b.approvals.list("s_1")).toHaveLength(1);
    b.approvals.resolve("s_1", b.approvals.list("s_1")[0]!.callId, false, "test");
    expect((await pending)?.behavior).toBe("deny");
    expect((await mk("dont-ask").canUse("Bash", { command: "cp a.md sub/.moss/commands/" }, ctx()))?.behavior).toBe("deny");
    // Dispatch respects its policy like code (user ruling 2026-10-17): a card; a stale chat row: the typed deny.
    const d = mk("auto", "dispatch");
    const dp = d.canUse("Bash", { command: "echo x > .moss/rules/r.md" }, ctx());
    await new Promise((r) => setTimeout(r, 10));
    expect(d.approvals.list("s_1")).toHaveLength(1);
    d.approvals.resolve("s_1", d.approvals.list("s_1")[0]!.callId, false, "test");
    expect((await dp)?.behavior).toBe("deny");
    expect((await mk("auto", "chat").canUse("Bash", { command: "echo x > .moss/rules/r.md" }, ctx()))?.behavior).toBe("deny");
    expect((await mk("bypass").canUse("Bash", { command: "cat .moss/skills/x/SKILL.md" }, ctx()))?.behavior).toBe("allow");
  });
});

// R.3 C-1: the escape floor (the LAST Bash PreToolUse group, every policy, bypass included, both legs) knows
// the variables WS-21 exports into every child — `$MOSS_STORE_HOME`, both plugin-cache variables,
// `$CLAUDE_CONFIG_DIR` and the MOSS child's own `$MOSS_HOME` (its run folder).
// WS-24: a write through a link that already exists on disk is judged at the link's target.
describe("Bash writes through an existing link to a protected directory", () => {
  function project(): { root: string; work: string } {
    const root = real("moss-link-proj-");
    mkdirSync(join(root, ".moss", "skills"), { recursive: true });
    mkdirSync(join(root, ".moss", "rules"), { recursive: true });
    mkdirSync(join(root, "notes"), { recursive: true });
    const work = join(root, "pkg");
    mkdirSync(work, { recursive: true });
    symlinkSync(join(root, ".moss", "skills"), join(work, "s"));                // a link to a protected dir
    symlinkSync(join(root, ".moss"), join(work, "dot"));                        // a link to .moss itself
    symlinkSync(join(root, ".moss", "rules", "planted.md"), join(work, "r.md")); // dangling: writing creates the target
    symlinkSync(join(root, "notes"), join(work, "n"));                           // a link to an ordinary dir
    return { root, work };
  }

  test("relative targets resolve against the session cwd; the static text alone never named .moss", () => {
    const { work } = project();
    for (const cmd of [
      "echo x > s/deploy/SKILL.md",
      "mkdir -p s/new-skill",
      "cp evil.md dot/skills/x/SKILL.md",
      "tee dot/rules/r.md < /dev/null",
      "echo planted > r.md",
      "cd s && echo x > y/SKILL.md",
      "echo x > S/Deploy/SKILL.md",
    ]) {
      expect({ cmd, before: bashProtectedWriteHit(cmd) }).toEqual({ cmd, before: undefined });
      expect({ cmd, hit: bashProtectedWriteHit(cmd, { cwd: work }) }).toEqual({ cmd, hit: cmd.includes("dot/rules") || cmd.includes("r.md") ? ".moss/rules" : ".moss/skills" });
    }
  });

  test("an absolute target through a link resolves without a cwd; ordinary links and reads stay quiet", () => {
    const { work } = project();
    expect(bashProtectedWriteHit(`echo x > ${work}/s/a/SKILL.md`)).toBe(".moss/skills");
    for (const cmd of ["echo x > n/todo.md", "cat s/deploy/SKILL.md", "ls dot/rules", "echo x > fresh/file.md"]) {
      expect({ cmd, hit: bashProtectedWriteHit(cmd, { cwd: work }) }).toEqual({ cmd, hit: undefined });
    }
  });

  // Fix round 1 (the reviewer's probes): the shell's own spelling is walked too — `..` climbs out of the
  // link's TARGET, so `./s/x/../../rules` is `.moss/rules`, however the text would collapse.
  test("`..` after a link climbs from the link's target, with or without a leading ./", () => {
    const { work } = project();
    mkdirSync(join(work, "s", "x"), { recursive: true }); // s -> <root>/.moss/skills, so this is skills/x
    for (const cmd of [
      "echo x > ./s/../rules/e.md",
      "echo x > ./s/x/../../rules/evil.md",
      "echo x > s/x/../../rules/evil.md",
      "echo x > s/x/../../rules/",
      "echo x > s/../rules/evil.md",
      "cd s; cd ..; echo x > rules/evil.md",
    ]) expect({ cmd, hit: bashProtectedWriteHit(cmd, { cwd: work }) }).toEqual({ cmd, hit: ".moss/rules" });
    expect(bashProtectedWriteHit("echo x > s/x/../y/SKILL.md", { cwd: work })).toBe(".moss/skills");
  });

  test("ln itself is judged: a link whose source is (or resolves under) a protected path is a card; an ordinary ln is not", () => {
    const { work } = project();
    for (const cmd of [
      "ln -s .moss/skills t && echo x > t/y.md",
      "ln -s ../.moss/skills t",
      "ln ../.moss/skills/x/SKILL.md hard.md",
      "ln -s s/x t",
      "ln -sf dot/rules r2",
    ]) expect({ cmd, hit: bashProtectedWriteHit(cmd, { cwd: work }) !== undefined }).toEqual({ cmd, hit: true });
    for (const cmd of ["ln -s ../notes n2", "ln -s /usr/bin/env e"]) {
      expect({ cmd, hit: bashProtectedWriteHit(cmd, { cwd: work }) }).toEqual({ cmd, hit: undefined });
    }
  });

  test("the reviewer's probe matrix: every link shape resolves, with a cwd", () => {
    const { root, work } = project();
    mkdirSync(join(root, ".moss", "skills", "x"), { recursive: true });
    symlinkSync("s", join(work, "chain"));
    symlinkSync(join(root, ".moss", "skills"), join(work, "abs"));
    mkdirSync(join(work, "sub"));
    symlinkSync("../s", join(work, "sub", "up"));
    for (const cmd of [
      "echo x > s/x/SKILL.md", "echo x > chain/x/SKILL.md", "echo x > dot/skills/y/SKILL.md", "echo x > abs/y.md",
      "cd s && echo x > y/SKILL.md", "cd sub && echo x > up/y.md", "echo x > sub/up/y.md",
      "cp /etc/hosts s/new.md", "tee s/new.md < /etc/hosts", "mv /tmp/a s/b", `echo x > ${work}/abs/y.md`,
      "echo x > S/X/SKILL.MD", "sed -i '' s/a/b/ s/x/SKILL.md", "bash -c 'echo x > s/y.md'",
    ]) expect({ cmd, hit: bashProtectedWriteHit(cmd, { cwd: work }) !== undefined }).toEqual({ cmd, hit: true });
    // Fix round 2 (N-2): a write through a HARD link made earlier is judged by its inode.
    writeFileSync(join(root, ".moss", "skills", "x", "SKILL.md"), "hi");
    linkSync(join(root, ".moss", "skills", "x", "SKILL.md"), join(work, "hard.md"));
    for (const cmd of ["echo x > hard.md", "cp /etc/hosts hard.md", "sed -i '' s/a/b/ hard.md", "tee hard.md"]) {
      expect({ cmd, hit: bashProtectedWriteHit(cmd, { cwd: work }) }).toEqual({ cmd, hit: ".moss/skills" });
    }
  });

  // Fix round 2 (the reviewer's probe3/probe4).
  test("a cd that fails leaves the shell where it was: every place it could stand is judged", () => {
    const { work } = project();
    mkdirSync(join(work, "sub"));
    for (const cmd of [
      "cd nope; cd s; echo x > y.md",
      "cd /nonexistent; cd s; echo x > y.md",
      "cd nope || true; echo x > s/y.md",
      "cd sub 2>/dev/null; cd s; echo x > y.md",
    ]) expect({ cmd, hit: bashProtectedWriteHit(cmd, { cwd: work }) }).toEqual({ cmd, hit: ".moss/skills" });
    expect(bashProtectedWriteHit("cd nope; echo x > notes.md", { cwd: work })).toBeUndefined();
  });

  test("hard links: cp -l / -al sources are judged; an existing hard link is judged by inode; an unrelated one is quiet", () => {
    const { root, work } = project();
    mkdirSync(join(root, ".moss", "skills", "x"), { recursive: true });
    writeFileSync(join(root, ".moss", "skills", "x", "SKILL.md"), "hi");
    for (const cmd of ["cp -l ../.moss/skills/x/SKILL.md foo.md", "cp -al ../.moss/skills bk", "cp --link s/x/SKILL.md foo.md"]) {
      expect({ cmd, hit: bashProtectedWriteHit(cmd, { cwd: work }) !== undefined }).toEqual({ cmd, hit: true });
    }
    expect(bashProtectedWriteHit("cp -L ../notes/a.md b.md", { cwd: work })).toBeUndefined(); // -L dereferences, it links nothing
    // A hard link that is NOT a protected file (node_modules-style) stays quiet.
    writeFileSync(join(work, "plain.md"), "p");
    linkSync(join(work, "plain.md"), join(work, "plain2.md"));
    expect(bashProtectedWriteHit("echo x > plain2.md", { cwd: work })).toBeUndefined();
    // The store's own sdk/skills, when the MOSS home is known.
    const home = real("moss-link-home-");
    mkdirSync(join(home, "sdk", "skills", "k"), { recursive: true });
    writeFileSync(join(home, "sdk", "skills", "k", "SKILL.md"), "k");
    linkSync(join(home, "sdk", "skills", "k", "SKILL.md"), join(work, "store-hard.md"));
    expect(bashProtectedWriteHit("echo x > store-hard.md", { cwd: work, home })).toBe("sdk/skills");
  });

  test("$PWD / ${PWD} / $HOME expand; >| is a redirect; dd writes its of=; an escaped slash is a slash", () => {
    const { work } = project();
    for (const cmd of [
      "echo x > $PWD/s/y.md", "echo x > \"${PWD}/s/y.md\"", "cd s && echo x > $PWD/y.md",
      "echo x >| s/y.md", "echo x >| ../.moss/skills/y.md", "dd if=/etc/hosts of=s/y.md", "echo x > s\\/y.md",
    ]) expect({ cmd, hit: bashProtectedWriteHit(cmd, { cwd: work }) !== undefined }).toEqual({ cmd, hit: true });
    expect(bashProtectedWriteHit("dd if=../.moss/skills/x of=/tmp/copy", { cwd: work })).toBeUndefined(); // a read
    expect(bashProtectedWriteHit(`echo x > $HOME/${"no-such-dir-ws24"}/y.md`, { cwd: work })).toBeUndefined();
  });

  // Fix round 3: every bound fails CLOSED (the reviewer's probe6/probe7).
  test("the cwd cap: five failed cds then a link write is caught; past the cap a write is a card, never a pass", () => {
    const { work } = project();
    const cds = (n: number): string => Array.from({ length: n }, (_, i) => `cd n${i}`).join("; ");
    for (const n of [3, 4, 5, 6]) expect({ n, hit: bashProtectedWriteHit(`${cds(n)}; echo x > s/y.md`, { cwd: work }) }).toEqual({ n, hit: ".moss/skills" });
    // 8 cds: the session cwd is still judged exactly (it hits here)…
    expect(bashProtectedWriteHit(`${cds(8)}; echo x > s/y.md`, { cwd: work })).toBe(".moss/skills");
    // …and a write the kept candidates do not settle is the bound's card.
    expect(bashProtectedWriteHit(`${cds(8)}; echo x > zz/y.md`, { cwd: work })).toBe(BASH_WRITE_CHECK_BOUND.cwds);
    // A successful chain of cds (the all-took chain) is always exact.
    mkdirSync(join(work, "a", "b", "c", "d", "e"), { recursive: true });
    expect(bashProtectedWriteHit(`cd a; cd b; cd c; cd d; cd e; cd /; cd ${work}; echo x > s/y.md`, { cwd: work })).toBe(".moss/skills");
    // Controls: an ordinary multi-cd command with no protected write stays quiet.
    expect(bashProtectedWriteHit("cd packages/core && bun test; cd ../cli && echo x > out.txt; cd - ; echo y > skills/notes.md", { cwd: work })).toBeUndefined();
  });

  test("the nesting/work cap: deep bash -c nesting is bounded in time and never passes silently", () => {
    const { work } = project();
    const cds = (n: number): string => Array.from({ length: n }, (_, i) => `cd n${i}`).join("; ");
    const nest = (d: number): string => (d === 0 ? "echo x > zz/y.md" : `bash -c "${cds(4)}; ${nest(d - 1).replace(/"/g, '\\"')}"`);
    for (const d of [1, 2, 3]) {
      const t0 = performance.now();
      const hit = bashProtectedWriteHit(`${cds(4)}; ${nest(d)}`, { cwd: work });
      expect(performance.now() - t0).toBeLessThan(2_000);
      expect(hit).toBe(BASH_WRITE_CHECK_BOUND.cwds);
    }
    // Many targets in one command: the work cap answers with its card.
    const many = Array.from({ length: 1_200 }, (_, i) => `echo x > f${i}.md`).join("; ");
    expect(bashProtectedWriteHit(many, { cwd: work })).toBe(BASH_WRITE_CHECK_BOUND.work);
  });

  test("the hard-link scan: the store's sdk/ kinds are scanned first; an exhausted budget with no match is a card", () => {
    const { root, work } = project();
    const home = real("moss-link-budget-home-");
    mkdirSync(join(home, "sdk", "skills", "k"), { recursive: true });
    writeFileSync(join(home, "sdk", "skills", "k", "SKILL.md"), "k");
    mkdirSync(join(root, ".moss", "skills", "big"), { recursive: true });
    for (let i = 0; i < 300; i += 1) writeFileSync(join(root, ".moss", "skills", "big", `f${i}`), "");
    linkSync(join(home, "sdk", "skills", "k", "SKILL.md"), join(work, "h2.md"));
    writeFileSync(join(work, "plain.md"), "p");
    linkSync(join(work, "plain.md"), join(work, "plain2.md"));
    _setInodeScanBudgetForTests(100);
    try {
      // sdk first: found before the big project tree spends the budget.
      expect(bashProtectedWriteHit("echo x > h2.md", { cwd: work, home })).toBe("sdk/skills");
      // An unrelated hard link, budget exhausted by the project tree: it cannot be ruled out — a card.
      expect(bashProtectedWriteHit("echo x > plain2.md", { cwd: work, home })).toBe(BASH_WRITE_CHECK_BOUND.inodes);
    } finally {
      _setInodeScanBudgetForTests(undefined);
    }
    // With the real budget the same unrelated hard link is quiet.
    expect(bashProtectedWriteHit("echo x > plain2.md", { cwd: work, home })).toBeUndefined();
  });

  test("an in-place sed's SCRIPT is not a path (no walk through a link named `s`)", () => {
    const { work } = project();
    writeFileSync(join(work, "notes.md"), "a");
    expect(bashProtectedWriteHit("sed -i '' s/a/b/ notes.md", { cwd: work })).toBeUndefined();
    expect(bashProtectedWriteHit("sed -i -e s/a/b/ notes.md", { cwd: work })).toBeUndefined();
    expect(bashProtectedWriteHit("sed -i '' s/a/b/ s/x/SKILL.md", { cwd: work })).toBe(".moss/skills");
  });

  test("the bridge (third layer) resolves a relative link from its session cwd: bypass/dispatch → card, chat → deny", async () => {
    const { work } = project();
    const home = real("moss-link-bridge-home-");
    const ctx = (): Parameters<CanUseTool>[2] => ({ signal: new AbortController().signal, toolUseID: `tu-${Math.random()}`, requestId: "r" } as Parameters<CanUseTool>[2]);
    const mk = (policy: SessionApprovalPolicy, mode: "code" | "dispatch" | "chat" = "code") => {
      const approvals = new ApprovalBroker();
      return { approvals, canUse: canUseToolFor({ sessionId: "s_1", mode, policy, approvals, questions: new QuestionBroker(), gate: new PermissionGate(), emit: () => {}, log: silent, home, cwd: work }) };
    };
    const b = mk("bypass");
    const pending = b.canUse("Bash", { command: "echo x > s/deploy/SKILL.md" }, ctx());
    await new Promise((r) => setTimeout(r, 10));
    expect(b.approvals.list("s_1")).toHaveLength(1);
    b.approvals.resolve("s_1", b.approvals.list("s_1")[0]!.callId, false, "test");
    expect((await pending)?.behavior).toBe("deny");
    const d = mk("auto", "dispatch");
    const dp = d.canUse("Bash", { command: "echo x > ./s/../rules/r.md" }, ctx());
    await new Promise((r) => setTimeout(r, 10));
    expect(d.approvals.list("s_1")).toHaveLength(1);
    d.approvals.resolve("s_1", d.approvals.list("s_1")[0]!.callId, false, "test");
    expect((await dp)?.behavior).toBe("deny");
    expect((await mk("auto", "chat").canUse("Bash", { command: "echo x > ./s/../rules/r.md" }, ctx()))?.behavior).toBe("deny");
    expect((await mk("bypass").canUse("Bash", { command: "echo x > n/todo.md" }, ctx()))?.behavior).toBe("allow");
  });

  test("the hook reads the cwd off its input and asks", async () => {
    const { work } = project();
    const built = sessionHooksFor({ sessionId: "s_1", roots: [work], home: "/Users/x/.moss", mode: "code" });
    const groups = (built.moss?.PreToolUse ?? []).filter((g: HookCallbackMatcher) => g.matcher === "Bash");
    const answers: string[] = [];
    for (const g of groups) for (const h of g.hooks) {
      const r = (await h({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "echo x > s/deploy/SKILL.md" }, session_id: "b", transcript_path: "", cwd: work } as never, "tu1", { signal: new AbortController().signal })) as { hookSpecificOutput?: { permissionDecision?: string } };
      answers.push(r.hookSpecificOutput?.permissionDecision ?? "none");
    }
    expect(answers).toContain("ask");
  });
});

describe("R.3 C-1: the escape floor under bypass — the child's own variables", () => {
  const floor = () => {
    const built = sessionHooksFor({ sessionId: "s_1", roots: ["/r"], home: "/Users/x/.moss", mode: "code", policy: () => "bypass" });
    const groups = (built.moss?.PreToolUse ?? []).filter((g: HookCallbackMatcher) => g.matcher === "Bash");
    return groups[groups.length - 1]!.hooks[0]!;
  };
  const escape = async (command: string) => decisionOf(await call(floor(), "Bash", { command, dangerouslyDisableSandbox: true }));

  test("a write-shaped escape through each variable is denied", async () => {
    for (const cmd of [
      "echo x > $MOSS_STORE_HOME/agents/evil.md",
      "echo x > ${MOSS_STORE_HOME}/skills/x/SKILL.md",
      "echo x >> $MOSS_STORE_HOME/projects/k/id.jsonl",
      "echo '{}' > $MOSS_PLUGIN_CACHE_DIR/p/hooks/hooks.json",
      "echo '{}' > ${CLAUDE_CODE_PLUGIN_CACHE_DIR}/p/hooks/hooks.json",
      "echo x > $CLAUDE_CONFIG_DIR/skills/foo/SKILL.md",
      "echo x > $MOSS_HOME/anything",
    ]) expect({ cmd, decision: await escape(cmd) }).toEqual({ cmd, decision: "deny" });
  });
  test("a read-shaped mention passes the floor", async () => {
    for (const cmd of ["cat $MOSS_STORE_HOME/projects/k/x.jsonl", "cat $MOSS_PLUGIN_CACHE_DIR/p/skills/x/SKILL.md", "cat $CLAUDE_CONFIG_DIR/skills/foo/SKILL.md"]) {
      expect({ cmd, decision: await escape(cmd) }).toEqual({ cmd, decision: "none" });
    }
  });
});
