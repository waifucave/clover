// Router 3279a1d (Contract A `escapeSandboxGlobPath`) — does the daemon's sandbox fence hold under a
// directory whose name holds `[`, on the real `winter` binary?
//
// The runtime reads a `sandbox.filesystem` entry holding any of `* ? [ ]` as a GLOB (a seatbelt regex, as
// claude reads one — the Clover runtime since agent SDK round 11, `2a118c6`), so a raw `[wip] app` entry
// is a character class that misses the literal directory. `childSandboxConfigFor` spells it `[[]wip] app`.
// Since SDK round 17 (`bfecbfb`) the Clover runtime ALSO fences `<cwd>/**/.clover/{skills,rules,
// output-styles,commands,agents}` on its own, whatever the daemon sends — so a `.clover/skills` write is
// blocked even under the literal list, and the literal-list CONTROL sits on a target only the daemon's list
// protects: a `[`-named daemon HOME (`<cwd>/[wip] home`) and writes into its `permissions/` and `run/`.
//
// WS-23: the official-leg half of this measurement (the pinned `claude` binary, whose control stayed on
// `.clover/skills` because claude has no `.clover` cover) is gone with that leg. GATED by
// `describeWithWinterBinary`.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query as cloverQuery } from "@waifucave/clover-agent-sdk";
import { CORE_BRAND } from "../../src/runtime-sdk/brand";
import { anthropicFake, startFake } from "@waifucave/clover-provider-conformance";
import { childSandboxConfigFor, sandboxConfigFor } from "../../src/runtime-sdk/mode-options";
import { describeWithWinterBinary } from "../helpers/winter-binary";

describeWithWinterBinary("C-1 — the Clover-leg sandbox fence under a `[`-named project (the daemon's own deny list)", (bin) => {
  /** One sandboxed Bash turn on the built `winter`, the sandbox being the daemon's OWN fence for this home
   *  and cwd — `childSandboxConfigFor` (what a spawn is sent) or, as the control, the literal
   *  `sandboxConfigFor`. The command writes into the protected `<cwd>/.clover/skills` twice (python, which
   *  the permission layer cannot see, and a redirect) and once into an ordinary cwd file. */
  async function run(dirName: string, spelled: boolean, command?: (cwd: string) => string, bed: { mkdirs?: string[]; probe?: string[]; daemonHomeInCwd?: string } = {}): Promise<{ python: boolean; redirect: boolean; notes: boolean; landed: Record<string, boolean> }> {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "clover-sbx-c1-w-")));
    const home = join(root, "home");
    // `daemonHomeInCwd`: the daemon's home INSIDE the cwd (a sandboxed write outside the cwd is refused by the
    // runtime's own write roots whatever the deny list says, so a control there could never land).
    const daemonHome = bed.daemonHomeInCwd === undefined ? join(root, "clover-home") : join(root, dirName, bed.daemonHomeInCwd);
    const cwd = join(root, dirName);
    for (const dir of [home, join(home, "tmp"), daemonHome, join(cwd, ".clover", "skills", "x"), ...(bed.mkdirs ?? []).map((d) => join(cwd, d))]) mkdirSync(dir, { recursive: true });
    const py = join(cwd, ".clover", "skills", "x", "SKILL.md");
    const redir = join(cwd, ".clover", "skills", "x", "r.md");
    const notes = join(cwd, "notes.md");
    const script = command?.(cwd) ?? `python3 -c "open('${py}','w').write('x')"; echo x > '${redir}'; echo x > '${notes}'; true`;
    let served = false;
    const fake = await startFake({
      routes: [{
        path: "*",
        handler: async (_req, recorded) => {
          if (!(recorded.path === "/v1/messages" && recorded.method === "POST")) return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
          if (!served && !recorded.body.includes("tool_result")) {
            served = true;
            return anthropicFake.anthropicTurnResponse({ blocks: [{ type: "tool_use", id: "call_bash_1", name: "Bash", jsonChunks: [JSON.stringify({ command: script, description: "write into the project" })] }], stopReason: "tool_use" });
          }
          return anthropicFake.anthropicTurnResponse({ blocks: [{ type: "text", chunks: ["done"] }], stopReason: "end_turn" });
        },
      }],
    });
    try {
      const fence = spelled ? childSandboxConfigFor(daemonHome, cwd) : sandboxConfigFor(daemonHome, cwd);
      const q = cloverQuery({
        prompt: "run the command you were scripted to run",
        options: {
          pathToClaudeCodeExecutable: bin,
          // The router injects the session's brand; a child driven directly is handed the daemon's own.
          brand: CORE_BRAND,
          model: "anthropic/claude-sonnet-5",
          provider: { providerId: "anthropic", authRef: { kind: "inline", value: "sk-ant-loopback" }, connection: { baseUrl: fake.url, local: true } },
          cwd,
          sandbox: { ...fence, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false },
          canUseTool: async (_tool: string, input: Record<string, unknown>) => ({ behavior: "allow", updatedInput: input }),
          env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: `${join(home, "tmp")}/`, CLOVER_HOME: home, CLOVER_PROFILE: "test" },
        } as never,
      });
      for await (const m of q) if ((m as { type?: string }).type === "result") break;
      // R.3: probed BEFORE the bed is removed below (a `landedPaths` read after `run` returns sees nothing).
      const landed = Object.fromEntries((bed.probe ?? []).map((rel) => [rel, existsSync(join(cwd, rel))]));
      return { python: existsSync(py), redirect: existsSync(redir), notes: existsSync(notes), landed };
    } finally {
      await fake.close();
      rmSync(root, { recursive: true, force: true });
    }
  }

  test("`[wip] app`: the spelled fence stops the python and the redirect write into .clover/skills; notes.md lands", async () => {
    const spelled = await run("[wip] app", true);
    const literal = await run("[wip] app", false);
    const plain = await run("plain app", false);
    const view = (r: { python: boolean; redirect: boolean; notes: boolean }) => ({ python: r.python, redirect: r.redirect, notes: r.notes });
    console.error(`C-1 (clover): [wip] spelled ${JSON.stringify(view(spelled))}; [wip] literal ${JSON.stringify(view(literal))}; plain literal ${JSON.stringify(view(plain))}`);
    expect(view(spelled)).toEqual({ python: false, redirect: false, notes: true });
    expect(view(plain)).toEqual({ python: false, redirect: false, notes: true });
    // SDK round 17 (`bfecbfb`): the runtime's own `<cwd>/**/.clover/skills` cover holds even under the literal
    // list (at SDK 5e37898 these writes LANDED — the old control). The control lives in the next test now.
    expect(view(literal)).toEqual({ python: false, redirect: false, notes: true });
  }, 180_000);

  // The literal-list CONTROL, on a target only the DAEMON's list protects (SDK round 17 made `.clover/<kind>`
  // the runtime's own): a daemon home named `[wip] home` inside the cwd, and writes into its `permissions/`
  // (the approved-rules store) and `run/` (the control plane). Spelled, both are stopped; literal, the `[wip]`
  // entries are character classes that miss the real path and both writes land (ASSERTED — the gap C-1 closes).
  test("a `[wip] home`: the spelled fence stops writes into <home>/permissions and <home>/run; the literal list lets them land (the control, ASSERTED)", async () => {
    const script = (cwd: string) => `python3 -c "open('${join(cwd, "[wip] home", "permissions", "x")}','w').write('x')"; echo x > '${join(cwd, "[wip] home", "run", "x")}'; echo x > notes.md; true`;
    const bed = { daemonHomeInCwd: "[wip] home", mkdirs: ["[wip] home/permissions", "[wip] home/run"], probe: ["[wip] home/permissions/x", "[wip] home/run/x", "notes.md"] };
    const spelled = await run("work", true, script, bed);
    const literal = await run("work", false, script, bed);
    console.error(`C-1 (clover, [wip] home): spelled ${JSON.stringify(spelled.landed)}; literal ${JSON.stringify(literal.landed)}`);
    expect(spelled.landed).toEqual({ "[wip] home/permissions/x": false, "[wip] home/run/x": false, "notes.md": true });
    expect(literal.landed).toEqual({ "[wip] home/permissions/x": true, "[wip] home/run/x": true, "notes.md": true });
  }, 180_000);

  // R.3 I-4: the any-depth project fence. From a session at the project root, a sandboxed Bash could plant
  // `.clover/<kind>` under a SUBDIRECTORY (a later session there loads it) through a path the Bash detector
  // cannot see — here python joins it from pieces. `childSandboxConfigFor` now carries
  // `<cwd>/**/.clover/<kind>` (a glob-shaped deny, a recursive regex on this runtime since round 11).
  test("R.3 I-4: an assembled python write into <cwd>/pkg/.clover/rules does not land; <cwd>/pkg/notes.md lands; the literal list is the control (ASSERTED)", async () => {
    const script = () => `python3 -c "open('pkg/.win'+'ter/rules/x.md','w').write('x')"; echo x > pkg/notes.md; true`;
    const bed = { mkdirs: ["pkg/.clover/rules"], probe: ["pkg/.clover/rules/x.md", "pkg/notes.md"] };
    const r = await run("plain app", true, script, bed);
    // R.3 re-review minor (a) added the literal list as an in-file control (at SDK 5e37898 the write LANDED under
    // it). SDK round 17 (`bfecbfb`, the runtime's own cwd-anchored `<cwd>/**/.clover/<kind>/**` cover) now stops
    // it whatever the daemon sends, so the daemon's any-depth glob is defence in depth here.
    const literal = await run("plain app", false, script, bed);
    console.error(`R.3 I-4 (clover): child ${JSON.stringify(r.landed)}; literal ${JSON.stringify(literal.landed)}`);
    expect(r.landed).toEqual({ "pkg/.clover/rules/x.md": false, "pkg/notes.md": true });
    expect(literal.landed).toEqual({ "pkg/.clover/rules/x.md": false, "pkg/notes.md": true });
  }, 180_000);

  // The ancestor-rename bypass (`mv .clover .w2 && … && mv .w2 .clover`): claude's sandbox closes it only for
  // `.claude`-shaped entries; the Clover runtime's cover for `.clover` is SDK round 17's. RED against the SDK
  // 5e37898 binary (this row was a `todo` then: the file WAS planted); asserted since the pin carries round 17.
  test("`[wip] app`: the ancestor-rename probe cannot plant .clover/skills/x/SKILL.md (SDK round 17)", async () => {
    // R.3 I-6: probed before the bed is removed (the old `landedPaths` read ran after it, so it read false always).
    const r = await run("[wip] app", true, () => "mv .clover .w2 && mkdir -p .w2/skills/x && echo > .w2/skills/x/SKILL.md && mv .w2 .clover; echo x > notes.md; true", { probe: [".clover/skills/x/SKILL.md", "notes.md"] });
    expect(r.landed).toEqual({ ".clover/skills/x/SKILL.md": false, "notes.md": true });
  }, 180_000);

  // R.3 re-review minor (b): the NESTED form of the rename bypass — a `.clover` built under another name in a
  // SUBDIRECTORY and renamed into place (`mkdir -p pkg/.w/rules && … && mv pkg/.w pkg/.clover`): the any-depth
  // glob fences `pkg/.clover/rules`, but a rename of an unfenced directory INTO that name is the known
  // rename-fence follow-up (the same gap as the ancestor-rename row above; SDK round 17's cover is for the
  // cwd's own `.clover`). Needs the binary that closes it — do not assert it before.
  test.todo("the nested-rename probe cannot plant pkg/.clover/rules/x.md (the known rename-fence follow-up)", async () => {
    const r = await run("plain app", true, () => "mkdir -p pkg/.w/rules && echo x > pkg/.w/rules/x.md && mv pkg/.w pkg/.clover; echo x > notes.md; true", { mkdirs: ["pkg"], probe: ["pkg/.clover/rules/x.md", "notes.md"] });
    expect(r.landed).toEqual({ "pkg/.clover/rules/x.md": false, "notes.md": true });
  }, 180_000);
});
