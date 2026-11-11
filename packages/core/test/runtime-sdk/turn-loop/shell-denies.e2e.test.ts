// A bot's sandboxed shell and what it must never change (stage 2, lane C).
//
// A bot's shell commands run inside an OS sandbox whose settings Clover draws
// (`botSandboxSettings`). Under every write root (the granted folder, the bot's
// own folders, and at the wider levels the home's entries) the shell must never
// write anything that runs later outside the sandbox (a `.git` folder or file,
// `*.git`, the editors' and tools' settings, `*.app` bundles, folders on the
// PATH, the repositories' configured hooks places), and must never read the
// user's secret places. Whatever is granted, the network stays out of reach
// (covered by driver.e2e.test.ts's socket test, not repeated here).
//
// Run only: scripts/pinned-bun test packages/core/test/runtime-sdk/turn-loop/shell-denies.e2e.test.ts
// (from the worktree root). macOS only, like the neighbouring e2e tests.
//
// How it works: a temp "user home" holds a granted folder `proj/` (a hand-made
// git working tree, a nested one, an app bundle, a PATH folder, ordinary files)
// and the bot's own folder with the same kinds of entries. One driver runs one
// Bash turn per sandbox shape (ask-risky, automatic, automatic with the home
// granted too); each turn runs every probe and records its exit code, and the
// test asserts on the exit code AND the filesystem afterwards. A refused row
// passes only when the command exits non-zero and the protected file or folder
// is byte-for-byte unchanged / still absent. Rows generated from the product's
// own exported lists (`PROJECT_DENIES`, `PROJECT_WHOLE_DENIES`,
// `SECRET_READ_PLACES`) grow automatically when those lists do.
import { afterAll, expect } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { query as sdkQuery, type SpawnClaudeCodeProcess } from "@waifucave/clover-agent-sdk";
import type { TurnControl, TurnInput } from "../../../src/contracts/session-host";
import type { BotSessionContext, EffectiveBot } from "../../../src/bots/service";
import { botPaths } from "../../../src/bots/paths";
import { BotSessionDriver, botFileFence, type BotDriverDeps } from "../../../src/runtime-sdk/turn-loop/driver";
import { CloverFence } from "../../../src/fence/fence";
import { botSandboxSettings } from "../../../src/fence/sandbox-settings";
import { PROJECT_DENIES, PROJECT_WHOLE_DENIES } from "../../../src/registry/plugin-fence";
import { SECRET_READ_PLACES } from "../../../src/contracts/fence";
import { describeWithEmbeddedRuntime } from "../../helpers/embedded-runtime";
import { darwinTest } from "../../helpers/darwin-only";

const temps: string[] = [];
afterAll(() => { for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true }); });

interface Ctl extends TurnControl {
  records: { type: string; [k: string]: unknown }[];
  fold(input: TurnInput): void;
  abort(): void;
}

function control(origin: TurnControl["origin"] = "user"): Ctl {
  const ac = new AbortController();
  const listeners: ((i: TurnInput) => void)[] = [];
  const held: TurnInput[] = [];
  const records: { type: string; [k: string]: unknown }[] = [];
  return {
    origin, signal: ac.signal, records,
    onFold(fn) {
      listeners.push(fn);
      for (const h of held.splice(0)) fn(h);
      return () => { listeners.splice(listeners.indexOf(fn), 1); };
    },
    record(e) { records.push(e); },
    fold(i) { if (listeners.length === 0) held.push(i); else for (const l of listeners) l(i); },
    abort() { ac.abort(); },
  };
}

function context(home: string, model: string, over: Partial<BotSessionContext> = {}): BotSessionContext & { bot: EffectiveBot } {
  const bot: EffectiveBot = { id: "luna", name: "Luna", instructions: "You are Luna.", model, modelFrom: "user", userLayer: [] };
  return {
    bot,
    botId: "luna", sessionId: "b_luna", kind: "bot", computer: "Studio", paths: botPaths(home, "luna"),
    caller: { kind: "session", sessionId: "b_luna", sessionKind: "bot", bot: "luna" },
    current: () => bot,
    memoryBlock: () => "<memory>\nnothing yet\n</memory>",
    mayAct: () => true,
    whenMayAct: async () => {},
    cacheCold: () => false,
    ...over,
  };
}

const user = (text: string): TurnInput => ({ from: "user", text, device: "d_1", sentAt: Date.now(), clientMessageId: crypto.randomUUID() });

function deps(home: string, spawn: SpawnClaudeCodeProcess, over: Partial<BotDriverDeps> = {}): BotDriverDeps {
  return {
    home, spawn,
    canUseTool: () => async (_name, input) => ({ behavior: "allow", updatedInput: input as Record<string, unknown> }),
    sandbox: () => ({ enabled: false }),
    stopGraceMs: 5_000,
    log: (l) => { if (process.env.A3_DEBUG) console.error(l); },
    ...over,
  };
}

// Rows the product is known not to protect yet. A row here still RUNS (finding
// the gap again is the point), but it cannot fail the suite; if it ever passes,
// the suite fails so the mark gets removed. (bun:test has test.todo but no
// test.failing, so this set is that mark, per row, in a table-driven file.)
const KNOWN_GAPS = new Set<string>([
  // "automatic:r-rename-git",
  // Lane C stage 2 leftover-child: a shell child that outlives its command
  // swaps the bot's scratch/x between a regular file and a link to a file
  // outside every write root, and a later Write follows the link (row-1);
  // and even a static pre-existing link is followed once the read-ladder is
  // satisfied (row-2). In the product the broker would card the outside
  // write; this file's stub approval allows everything, so no card appears.
  "leftover:row-1",
  "leftover:row-2",
]);

const q = (s: string) => JSON.stringify(s);

/** The file inside a whole-denied folder the probe tries to create (the brief's exact paths where it names them). */
const WHOLE_ENTRY: Record<string, string> = {
  ".vscode": "tasks.json",
  ".idea": "x",
  ".claude": "commands/foo.md",
  ".husky": "pre-commit",
  ".githooks": "pre-commit",
  ".clover": "rules/x.md",
};

interface Fixture {
  proj: string;
  bin: string;
  scratch: string;
  cloverHome: string;
  novaMemory: string;
  awsCreds: string;
  netrc: string;
  sshConfig: string;
  direct: string;
}

const GIT_CONFIG = "[core]\n\thooksPath = tools/hooks\n";
const GIT_CONFIG_SUB = "[core]\n\trepositoryformatversion = 0\n";

function handGit(dir: string, config: string): void {
  mkdirSync(join(dir, "objects"), { recursive: true });
  mkdirSync(join(dir, "refs"), { recursive: true });
  mkdirSync(join(dir, "hooks"), { recursive: true });
  mkdirSync(join(dir, "info"), { recursive: true });
  writeFileSync(join(dir, "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(dir, "config"), config);
}

function buildFixture(fx: Fixture, scratch: string): void {
  rmSync(fx.proj, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
  const P = fx.proj;
  handGit(join(P, ".git"), GIT_CONFIG);
  mkdirSync(join(P, "tools", "hooks"), { recursive: true });
  handGit(join(P, "sub", ".git"), GIT_CONFIG_SUB);
  mkdirSync(join(P, "fresh"), { recursive: true });
  mkdirSync(join(P, "src"), { recursive: true });
  mkdirSync(join(P, "Tool.app", "Contents", "MacOS"), { recursive: true });
  writeFileSync(join(P, "Tool.app", "Contents", "MacOS", "tool"), "BINARY-orig\n");
  mkdirSync(fx.bin, { recursive: true });
  writeFileSync(join(fx.bin, "prog"), "#!/bin/sh\necho orig\n");
  chmodSync(join(fx.bin, "prog"), 0o755);
  writeFileSync(join(P, "notes.txt"), "NOTES-orig\n");
  writeFileSync(join(P, "notes2.txt"), "NOTES2-orig\n");
  writeFileSync(join(P, "src", "a.ts"), "// a.ts orig\n");
  // The bot's own folder, with the same kinds of entries.
  handGit(join(scratch, ".git"), GIT_CONFIG);
  mkdirSync(join(scratch, "fresh"), { recursive: true });
  mkdirSync(join(scratch, "Tool.app", "Contents", "MacOS"), { recursive: true });
  writeFileSync(join(scratch, "Tool.app", "Contents", "MacOS", "tool"), "OWN-BINARY-orig\n");
  writeFileSync(join(scratch, "notes.txt"), "OWN-orig\n");
}

interface Probe {
  name: string;
  keys: string[];
  sh: string;
}

const one = (name: string, cmd: string): Probe => ({
  // No stdout redirect: commands either redirect into a file themselves or print
  // nothing, so their stdout stays empty and any stderr lands in the err file.
  name, keys: [name],
  sh: `{ ${cmd} 2>>"$E/${name}.err"; echo "${name}=$?" >>"$R"; }`,
});

const multi = (name: string, steps: [string, string][]): Probe => ({
  name, keys: steps.map(([k]) => `${name}.${k}`),
  sh: steps.map(([k, cmd]) => `{ ${cmd} 2>>"$E/${name}.err"; echo "${name}.${k}=$?" >>"$R"; }`).join("\n"),
});

const readProbe = (name: string, abs: string): Probe => ({
  name, keys: [name],
  sh: `{ cat ${q(abs)} >"$O/${name}.out" 2>>"$E/${name}.err"; echo "${name}=$?" >>"$R"; }`,
});

function buildProbes(fx: Fixture, scratch: string, caseInsensitive: boolean): { probes: Probe[]; skipped: string[] } {
  const P = fx.proj;
  const probes: Probe[] = [];
  const skipped: string[] = [];
  // Allowed control rows: the sandbox is not simply refusing everything.
  probes.push(one("a-notes", `printf 'ALLOWED-NOTES' > ${q(join(P, "notes.txt"))}`));
  probes.push(one("a-src", `printf '// b' > ${q(join(P, "src", "b.ts"))}`));
  probes.push(one("a-fresh", `printf 'x' > ${q(join(P, "fresh", "t"))} && rm ${q(join(P, "fresh", "t"))}`));
  probes.push(one("a-own", `printf 'ALLOWED-OWN' > ${q(join(scratch, "notes.txt"))}`));
  probes.push(readProbe("a-read", join(P, "notes.txt")));
  // Plain writes to protected places under the granted folder.
  probes.push(one("r-gitcfg-overwrite", `printf 'PWNED' > ${q(join(P, ".git", "config"))}`));
  probes.push(one("r-gitcfg-append", `printf 'x' >> ${q(join(P, ".git", "config"))}`));
  probes.push(one("r-hook-create", `printf 'x' > ${q(join(P, ".git", "hooks", "pre-commit"))}`));
  probes.push(one("r-sub-hook", `printf 'x' > ${q(join(P, "sub", ".git", "hooks", "x"))}`));
  probes.push(one("r-nested-git", `mkdir -p ${q(join(P, "nest2", ".git", "hooks"))} && printf 'x' > ${q(join(P, "nest2", ".git", "hooks", "x"))}`));
  probes.push(one("r-info-attrs", `printf 'x' > ${q(join(P, ".git", "info", "attributes"))}`));
  probes.push(one("r-head", `printf 'x' > ${q(join(P, ".git", "HEAD"))}`));
  probes.push(one("r-hooksPath", `printf 'x' > ${q(join(P, "tools", "hooks", "pre-commit"))}`));
  probes.push(one("r-extra-git", `mkdir -p ${q(join(P, "extra.git"))} && printf 'x' > ${q(join(P, "extra.git", "config"))}`));
  // Every whole-denied project name, from the product's own list (minus .git,
  // covered above): the folder itself must not be made, nor written inside.
  for (const n of PROJECT_WHOLE_DENIES) {
    if (n === ".git") continue;
    const file = join(P, n, WHOLE_ENTRY[n] ?? "entry");
    probes.push(one(`w-${n}`, `mkdir -p ${q(dirname(file))} && printf 'x' > ${q(file)}`));
  }
  // Every otherwise-denied project name, from the product's own list: no file
  // may be created at that name, at any depth.
  for (const n of PROJECT_DENIES) {
    const abs = join(P, ...n.split("/"));
    const parent = dirname(abs);
    probes.push(one(`d-${n}`, parent === P ? `printf 'x' > ${q(abs)}` : `mkdir -p ${q(parent)} && printf 'x' > ${q(abs)}`));
  }
  // App bundles, under the granted folder.
  probes.push(one("r-app-overwrite", `printf 'X' >> ${q(join(P, "Tool.app", "Contents", "MacOS", "tool"))}`));
  probes.push(one("r-app-newfile", `printf 'x' > ${q(join(P, "Tool.app", "Contents", "MacOS", "x2"))}`));
  probes.push(multi("r-app-rename", [
    ["mv", `mv ${q(join(P, "Tool.app"))} ${q(join(P, "T2.app"))}`],
    ["write", `printf 'x' > ${q(join(P, "T2.app", "Contents", "MacOS", "tool"))}`],
    ["restore", `mv ${q(join(P, "T2.app"))} ${q(join(P, "Tool.app"))}`],
  ]));
  probes.push(one("r-app-new", `mkdir -p ${q(join(P, "New.app", "Contents", "MacOS"))} && printf 'x' > ${q(join(P, "New.app", "Contents", "MacOS", "x"))}`));
  // The PATH folder given to the sandbox settings.
  probes.push(one("r-bin-overwrite", `printf 'X' >> ${q(join(fx.bin, "prog"))}`));
  probes.push(one("r-bin-new", `printf 'x' > ${q(join(fx.bin, "newprog"))}`));
  // The same protected places in the bot's own (always-writable) folder.
  probes.push(one("r-own-gitcfg", `printf 'PWNED' > ${q(join(scratch, ".git", "config"))}`));
  probes.push(one("r-own-hook", `printf 'x' > ${q(join(scratch, ".git", "hooks", "pre-commit"))}`));
  probes.push(one("r-own-freshgit", `mkdir -p ${q(join(scratch, "fresh", ".git"))} && printf 'x' > ${q(join(scratch, "fresh", ".git", "config"))}`));
  probes.push(one("r-own-app", `printf 'X' >> ${q(join(scratch, "Tool.app", "Contents", "MacOS", "tool"))}`));
  // The same protected places reached indirectly.
  probes.push(multi("r-rename-git", [
    ["mv", `mv ${q(join(P, ".git"))} ${q(join(P, "g"))}`],
    ["write", `printf 'x' >> ${q(join(P, "g", "config"))}`],
    ["hook", `printf 'x' > ${q(join(P, "g", "hooks", "x"))}`],
    ["restore", `mv ${q(join(P, "g"))} ${q(join(P, ".git"))}`],
  ]));
  probes.push(multi("r-rename-parent", [
    ["mv", `mv ${q(join(P, "sub"))} ${q(join(P, "sub2"))}`],
    ["write", `printf 'x' > ${q(join(P, "sub2", ".git", "config"))}`],
    ["restore", `mv ${q(join(P, "sub2"))} ${q(join(P, "sub"))}`],
  ]));
  probes.push(one("r-fresh-git", `mkdir -p ${q(join(P, "fresh", ".git"))} && printf 'x' > ${q(join(P, "fresh", ".git", "config"))}`));
  probes.push(one("r-fresh-hooks", `mkdir -p ${q(join(P, "fresh2", ".git", "hooks"))} && printf 'x' > ${q(join(P, "fresh2", ".git", "hooks", "x"))}`));
  probes.push(one("r-dotgit-file", `mkdir -p ${q(join(P, "dgf"))} && printf 'gitdir: /elsewhere' > ${q(join(P, "dgf", ".git"))}`));
  probes.push(one("r-symlink-dir", `ln -s .git ${q(join(P, "alias"))} && printf 'x' >> ${q(join(P, "alias", "config"))}`));
  probes.push(one("r-symlink-file", `ln -s ${q(join(P, ".git", "config"))} ${q(join(P, "c"))} && printf 'x' >> ${q(join(P, "c"))}`));
  probes.push(one("r-hardlink", `ln ${q(join(P, ".git", "config"))} ${q(join(P, "c2"))} && printf 'x' >> ${q(join(P, "c2"))}`));
  probes.push(one("r-cp-over", `cp ${q(join(P, "notes.txt"))} ${q(join(P, ".git", "config"))}`));
  probes.push(one("r-mv-over", `mv ${q(join(P, "notes2.txt"))} ${q(join(P, ".git", "config"))}`));
  probes.push(one("r-dotdot", `printf 'x' >> ${q(join(P, "src", "..", ".git", "config"))}`));
  if (caseInsensitive) {
    probes.push(one("r-case-git", `printf 'x' >> ${q(join(P, ".GIT", "config"))}`));
    probes.push(one("r-case-hooks", `printf 'x' > ${q(join(P, ".Git", "hooks", "x"))}`));
  } else {
    skipped.push("r-case-git", "r-case-hooks");
  }
  // Outside every write root: the temp home itself and the Clover home's own
  // files. Another bot's *memory* is writable on purpose (the fence's owner's
  // amendment: a bot writes every bot's memory), so that row is an allowed
  // control; its agents' folder is not.
  probes.push(one("r-home-direct", `printf 'x' > ${q(fx.direct)}`));
  probes.push(one("a-nova-memory", `printf 'x' >> ${q(fx.novaMemory)}`));
  probes.push(one("r-nova-agents", `printf 'x' >> ${q(join(dirname(fx.novaMemory), "..", "agents", "x"))}`));
  probes.push(one("r-home-settings", `printf 'x' >> ${q(join(fx.cloverHome, "settings.json"))}`));
  // Reads the sandbox also denies: fake secrets in the temp home.
  probes.push(readProbe("rd-aws", fx.awsCreds));
  probes.push(readProbe("rd-netrc", fx.netrc));
  probes.push(readProbe("rd-ssh", fx.sshConfig));
  return { probes, skipped };
}

describeWithEmbeddedRuntime("a bot's sandboxed shell: shell-denies (what it must never change)", (spawn) => {
  darwinTest("granted, own and home roots: refused writes land nowhere, allowed writes land, secret reads show nothing", async () => {
    const userDir = realpathSync(mkdtempSync(join(tmpdir(), "clover-shell-denies-")));
    temps.push(userDir);
    const home = join(userDir, "c");
    const t = join(userDir, "t");
    mkdirSync(t, { recursive: true });
    const ctx0 = context(home, "winter-test/calls");
    const scratch = ctx0.paths.scratch;
    const botRoot = ctx0.paths.root;
    mkdirSync(scratch, { recursive: true });
    mkdirSync(botRoot, { recursive: true });
    const fx: Fixture = {
      proj: join(userDir, "proj"),
      bin: join(userDir, "proj", "bin"),
      scratch,
      cloverHome: home,
      novaMemory: join(home, "bots", "nova", "memory", "MEMORY.md"),
      awsCreds: join(userDir, ".aws", "credentials"),
      netrc: join(userDir, ".netrc"),
      sshConfig: join(userDir, ".ssh", "config"),
      direct: join(userDir, "direct.txt"),
    };
    // The secrets the read probes try: fakes in the temp home only.
    if (SECRET_READ_PLACES.find((p) => p.path === ".aws") === undefined) throw new Error("SECRET_READ_PLACES lost .aws");
    if (SECRET_READ_PLACES.find((p) => p.path === ".netrc") === undefined) throw new Error("SECRET_READ_PLACES lost .netrc");
    if (SECRET_READ_PLACES.find((p) => p.path === ".ssh") === undefined) throw new Error("SECRET_READ_PLACES lost .ssh");
    mkdirSync(join(userDir, ".aws"), { recursive: true });
    mkdirSync(join(userDir, ".ssh"), { recursive: true });
    writeFileSync(fx.awsCreds, "FAKE-AWS-SECRET-1\n");
    writeFileSync(fx.netrc, "machine fake password FAKE-NETRC-SECRET-2\n");
    writeFileSync(fx.sshConfig, "Host fake\n  IdentityFile FAKE-SSH-SECRET-3\n");
    mkdirSync(dirname(fx.novaMemory), { recursive: true });
    writeFileSync(fx.novaMemory, "NOVA-MEMORY-orig\n");
    mkdirSync(join(home, "bots", "nova", "agents"), { recursive: true });
    writeFileSync(join(home, "settings.json"), "{}\n");

    const fence = new CloverFence({ home: userDir, cloverHome: home, temp: t });
    let level: "ask-risky" | "automatic" = "ask-risky";
    let granted: string[] = [fx.proj];
    let lastSettings: { allowWrite?: readonly string[]; denyWrite?: readonly string[]; denyRead?: readonly string[] } | undefined;
    const sandbox = (ctx: BotSessionContext) => {
      const s = botSandboxSettings(fence.forCaller(ctx.caller).policy(), {
        cloverHome: home, userHome: userDir, level, grantedWrite: granted,
        ownFolders: [ctx.paths.scratch, ctx.paths.root], pathFolders: [fx.bin],
      });
      lastSettings = { allowWrite: s.filesystem?.allowWrite, denyWrite: s.filesystem?.denyWrite, denyRead: s.filesystem?.denyRead };
      return s;
    };
    const driver = new BotSessionDriver(context(home, "winter-test/calls"), deps(home, spawn, { sandbox }));

    interface Row { phase: string; name: string; expected: string; ok: boolean; detail: string; }
    const rows: Row[] = [];
    const skippedRows: { phase: string; name: string; reason: string }[] = [];
    const settingsSeen: { phase: string; allowWrite: number; denyWrite: number; denyRead: number }[] = [];

    const read = (p: string): string | null => {
      try { return readFileSync(p, "utf8"); } catch { return null; }
    };

    try {
      const phases = [
        // The temp "home" is never a write root, at any level: it holds the
        // Clover home, so the settings leave it out (fail closed), and a write
        // directly into it is refused even at automatic.
        { tag: "ask-risky", level: "ask-risky" as const, granted: [fx.proj] },
        { tag: "automatic", level: "automatic" as const, granted: [fx.proj] },
        // ... even when the home itself is named as a granted folder.
        { tag: "automatic-home", level: "automatic" as const, granted: [fx.proj, userDir] },
      ];
      for (const phase of phases) {
        level = phase.level;
        granted = phase.granted;
        buildFixture(fx, scratch);
        const P = fx.proj;
        const caseInsensitive = existsSync(join(P, "NOTES.TXT"));
        const snap = new Map<string, string | null>();
        for (const f of [
          join(P, ".git", "config"), join(P, ".git", "HEAD"),
          join(P, "Tool.app", "Contents", "MacOS", "tool"), join(fx.bin, "prog"),
          join(P, "notes.txt"), join(P, "notes2.txt"), join(P, "src", "a.ts"),
          join(P, "sub", ".git", "config"),
          join(scratch, ".git", "config"), join(scratch, "notes.txt"),
          join(scratch, "Tool.app", "Contents", "MacOS", "tool"),
          fx.novaMemory, join(home, "settings.json"),
        ]) snap.set(f, read(f));
        const hooksBefore = readDirNames(join(P, ".git", "hooks"));
        const { probes, skipped } = buildProbes(fx, scratch, caseInsensitive);
        for (const s of skipped) skippedRows.push({ phase: phase.tag, name: s, reason: "temp volume is case-sensitive" });

        const outDir = join(t, `p-${phase.tag}`);
        rmSync(outDir, { recursive: true, force: true });
        mkdirSync(join(outDir, "err"), { recursive: true });
        mkdirSync(join(outDir, "out"), { recursive: true });
        const script = [
          `R=${q(join(outDir, "res"))}; E=${q(join(outDir, "err"))}; O=${q(join(outDir, "out"))}; set -u`,
          ...probes.map((p) => p.sh),
        ].join("\n");
        const end = await driver.turn(
          user(`CALL Bash ${JSON.stringify({ command: script, description: "probe shell denies" })}`),
          control(),
        );
        expect(end.reason).toBe("end_turn");
        const exits = new Map<string, string>();
        for (const line of (read(join(outDir, "res")) ?? "").trim().split("\n")) {
          const i = line.indexOf("=");
          if (i > 0) exits.set(line.slice(0, i), line.slice(i + 1));
        }
        settingsSeen.push({
          phase: phase.tag,
          allowWrite: lastSettings?.allowWrite?.length ?? -1,
          denyWrite: lastSettings?.denyWrite?.length ?? -1,
          denyRead: lastSettings?.denyRead?.length ?? -1,
        });
        // Fail closed: no drawn root may hold the Clover home (the temp home
        // holds it), so the home itself is left out of the write roots even
        // when it is the granted folder (automatic-home phase).
        const heldRoots = (lastSettings?.allowWrite ?? []).filter((r) => r === userDir);
        if (heldRoots.length > 0) {
          rows.push({ phase: phase.tag, name: "(settings) home left out", expected: "refused", ok: false, detail: `allowWrite holds ${JSON.stringify(heldRoots)}` });
        }

        const exitOf = (key: string): string | undefined => exits.get(key);
        const unchanged = (f: string): boolean => read(f) === snap.get(f);
        const absent = (f: string): boolean => !existsSync(f);
        const needleFor = (name: string): string => {
          if (name.startsWith("r-gitcfg") || name === "r-head" || name === "r-hook-create" || name === "r-sub-hook" ||
            name === "r-nested-git" || name === "r-info-attrs" || name === "r-rename-git" || name === "r-rename-parent" ||
            name === "r-fresh-git" || name === "r-fresh-hooks" || name === "r-dotgit-file" || name === "r-symlink-dir" ||
            name === "r-symlink-file" || name === "r-hardlink" || name === "r-cp-over" || name === "r-mv-over" ||
            name === "r-dotdot" || name === "r-case-git" || name === "r-case-hooks" || name === "r-extra-git" ||
            name === "r-hooksPath" || name.startsWith("r-own-")) return ".git";
          if (name.startsWith("r-app")) return ".app";
          if (name.startsWith("r-bin")) return "bin";
          if (name.startsWith("w-")) return name.slice(2).split("/")[0]!;
          if (name.startsWith("d-")) return name.slice(2).split("/").pop()!;
          return name;
        };
        const denyLines = (needle: string): string[] => {
          // Rendered denies spell names case-insensitively ([gG][iI][tT]), so
          // collapse those classes before comparing.
          const bare = (s: string) => s.replace(/\[([A-Za-z])([A-Za-z])\]/g, "$1").toLowerCase().replace(/[^a-z0-9*]/g, "");
          const n = bare(needle);
          return (lastSettings?.denyWrite ?? []).filter((d) => bare(d).includes(n));
        };

        const judge = (name: string): { expected: string; ok: boolean; detail: string } => {
          const fail = (why: string): { expected: string; ok: boolean; detail: string } => ({
            expected: "refused", ok: false,
            detail: `${why}; exits=${JSON.stringify(Object.fromEntries([...exits].filter(([k]) => k === name || k.startsWith(`${name}.`))))}; ` +
              `stderr=${JSON.stringify((read(join(outDir, "err", `${name}.err`)) ?? "").trim().slice(0, 300))}; ` +
              `denyWrite matching ${JSON.stringify(needleFor(name))}: ${JSON.stringify(denyLines(needleFor(name)))}`,
          });
          const refusedFileUnchanged = (key: string, f: string) => {
            if (exitOf(key) === "0") return fail(`${key} exited 0`);
            if (!unchanged(f)) return { expected: "refused", ok: false, detail: `${f} changed: ${JSON.stringify(read(f))?.slice(0, 200)}` };
            return { expected: "refused", ok: true, detail: `exit=${exitOf(key)} unchanged` };
          };
          const refusedAbsent = (key: string, f: string) => {
            if (exitOf(key) === "0") return fail(`${key} exited 0`);
            if (!absent(f)) return fail(`${f} was created`);
            return { expected: "refused", ok: true, detail: `exit=${exitOf(key)} absent` };
          };
          switch (true) {
            case name === "a-notes": {
              if (exitOf(name) !== "0") return { expected: "allowed", ok: false, detail: `exit=${exitOf(name)}` };
              return read(join(P, "notes.txt")) === "ALLOWED-NOTES"
                ? { expected: "allowed", ok: true, detail: "exit=0 written" }
                : { expected: "allowed", ok: false, detail: `content=${JSON.stringify(read(join(P, "notes.txt")))}` };
            }
            case name === "a-src": {
              if (exitOf(name) !== "0") return { expected: "allowed", ok: false, detail: `exit=${exitOf(name)}` };
              return read(join(P, "src", "b.ts")) === "// b"
                ? { expected: "allowed", ok: true, detail: "exit=0 written" }
                : { expected: "allowed", ok: false, detail: "b.ts missing/wrong" };
            }
            case name === "a-fresh": {
              if (exitOf(name) !== "0") return { expected: "allowed", ok: false, detail: `exit=${exitOf(name)}` };
              return absent(join(P, "fresh", "t"))
                ? { expected: "allowed", ok: true, detail: "exit=0 created+deleted" }
                : { expected: "allowed", ok: false, detail: "fresh/t left behind" };
            }
            case name === "a-own": {
              if (exitOf(name) !== "0") return { expected: "allowed", ok: false, detail: `exit=${exitOf(name)}` };
              return read(join(scratch, "notes.txt")) === "ALLOWED-OWN"
                ? { expected: "allowed", ok: true, detail: "exit=0 written" }
                : { expected: "allowed", ok: false, detail: "own notes wrong" };
            }
            case name === "a-read": {
              const out = read(join(outDir, "out", "a-read.out"));
              if (exitOf(name) !== "0") return { expected: "allowed", ok: false, detail: `exit=${exitOf(name)}` };
              return out === "ALLOWED-NOTES"
                ? { expected: "allowed", ok: true, detail: "exit=0 content shown" }
                : { expected: "allowed", ok: false, detail: `out=${JSON.stringify(out)}` };
            }
            case name === "r-gitcfg-overwrite" || name === "r-gitcfg-append" || name === "r-cp-over" ||
              name === "r-mv-over" || name === "r-dotdot" || name === "r-case-git":
              return refusedFileUnchanged(name, join(P, ".git", "config"));
            case name === "r-head": return refusedFileUnchanged(name, join(P, ".git", "HEAD"));
            case name === "r-app-overwrite": return refusedFileUnchanged(name, join(P, "Tool.app", "Contents", "MacOS", "tool"));
            case name === "r-bin-overwrite": return refusedFileUnchanged(name, join(fx.bin, "prog"));
            case name === "r-own-gitcfg": return refusedFileUnchanged(name, join(scratch, ".git", "config"));
            case name === "r-own-app": return refusedFileUnchanged(name, join(scratch, "Tool.app", "Contents", "MacOS", "tool"));
            case name === "r-sub-hook": return refusedAbsent(name, join(P, "sub", ".git", "hooks", "x"));
            case name === "r-hook-create": return refusedAbsent(name, join(P, ".git", "hooks", "pre-commit"));
            case name === "r-nested-git": return refusedAbsent(name, join(P, "nest2", ".git"));
            case name === "r-info-attrs": return refusedAbsent(name, join(P, ".git", "info", "attributes"));
            case name === "r-hooksPath": return refusedAbsent(name, join(P, "tools", "hooks", "pre-commit"));
            case name === "r-own-hook": return refusedAbsent(name, join(scratch, ".git", "hooks", "pre-commit"));
            case name === "r-own-freshgit": return refusedAbsent(name, join(scratch, "fresh", ".git", "config"));
            case name === "r-app-newfile": return refusedAbsent(name, join(P, "Tool.app", "Contents", "MacOS", "x2"));
            case name === "r-app-new": return refusedAbsent(name, join(P, "New.app"));
            case name === "r-extra-git": return refusedAbsent(name, join(P, "extra.git"));
            case name === "r-bin-new": return refusedAbsent(name, join(fx.bin, "newprog"));
            case name === "r-fresh-git": return refusedAbsent(name, join(P, "fresh", ".git"));
            case name === "r-fresh-hooks": return refusedAbsent(name, join(P, "fresh2", ".git"));
            case name === "r-dotgit-file": return refusedAbsent(name, join(P, "dgf", ".git"));
            case name === "r-case-hooks": return refusedAbsent(name, join(P, ".Git", "hooks", "x"));
            case name === "r-symlink-dir": return refusedFileUnchanged(name, join(P, ".git", "config"));
            case name === "r-symlink-file": return refusedFileUnchanged(name, join(P, ".git", "config"));
            case name === "r-hardlink": return refusedFileUnchanged(name, join(P, ".git", "config"));
            case name.startsWith("w-"): {
              const n = name.slice(2);
              const abs = join(P, n);
              if (exitOf(name) === "0") return fail(`${name} exited 0`);
              if (!absent(abs)) return fail(`${abs} was created`);
              return { expected: "refused", ok: true, detail: `exit=${exitOf(name)} absent` };
            }
            case name.startsWith("d-"): {
              const n = name.slice(2);
              const abs = join(P, ...n.split("/"));
              if (exitOf(name) === "0") return fail(`${name} exited 0`);
              if (!absent(abs)) return fail(`${abs} was created`);
              return { expected: "refused", ok: true, detail: `exit=${exitOf(name)} absent` };
            }
            case name === "r-app-rename": {
              const mv = exitOf("r-app-rename.mv"), write = exitOf("r-app-rename.write");
              const intact = unchanged(join(P, "Tool.app", "Contents", "MacOS", "tool")) && absent(join(P, "T2.app"));
              if (mv !== "0" && intact) return { expected: "refused", ok: true, detail: `rename refused exit=${mv} intact` };
              if (mv === "0" && write !== "0" && intact) return { expected: "refused", ok: true, detail: "renamed but write refused, restored intact" };
              return fail(`mv=${mv} write=${write} intact=${intact}`);
            }
            case name === "r-rename-git": {
              const mv = exitOf("r-rename-git.mv"), write = exitOf("r-rename-git.write"), hook = exitOf("r-rename-git.hook");
              const intact = existsSync(join(P, ".git")) && absent(join(P, "g")) &&
                unchanged(join(P, ".git", "config")) && unchanged(join(P, ".git", "HEAD")) &&
                readDirNames(join(P, ".git", "hooks")) === hooksBefore && absent(join(P, ".git", "info", "attributes"));
              if (mv !== "0" && intact) return { expected: "refused", ok: true, detail: `rename refused exit=${mv} intact` };
              if (mv === "0" && write !== "0" && hook !== "0" && intact) {
                return { expected: "refused", ok: true, detail: "renamed but writes refused, restored intact" };
              }
              return fail(`mv=${mv} write=${write} hook=${hook} intact=${intact}`);
            }
            case name === "r-rename-parent": {
              const write = exitOf("r-rename-parent.write"), mv = exitOf("r-rename-parent.mv");
              const parts = {
                sub: existsSync(join(P, "sub")),
                noSub2: absent(join(P, "sub2")),
                cfg: unchanged(join(P, "sub", ".git", "config")),
              };
              const intact = parts.sub && parts.noSub2 && parts.cfg;
              if (write !== "0" && intact) return { expected: "refused", ok: true, detail: `mv=${mv} write refused intact` };
              return fail(`mv=${mv} write=${write} ${JSON.stringify(parts)}`);
            }
            default: break;
          }
          if (name === "r-home-direct") {
            // Fail closed at every level and grant: the home holds the Clover
            // home, so the rendered settings must leave it out (asserted on the
            // settings below), and the write is refused.
            if (exitOf(name) === "0") return fail("home write exited 0");
            if (!absent(fx.direct)) return fail("direct.txt was created");
            return { expected: "refused", ok: true, detail: `exit=${exitOf(name)} absent` };
          }
          if (name === "a-nova-memory") {
            // Allowed on purpose: the fence's owner's amendment lets a bot
            // write every bot's memory. The append must land.
            if (exitOf(name) !== "0") return { expected: "allowed", ok: false, detail: `exit=${exitOf(name)}` };
            const want = `${snap.get(fx.novaMemory) ?? ""}x`;
            return read(fx.novaMemory) === want
              ? { expected: "allowed", ok: true, detail: "exit=0 appended (owner's amendment)" }
              : { expected: "allowed", ok: false, detail: `content=${JSON.stringify(read(fx.novaMemory))}` };
          }
          if (name === "r-nova-agents") {
            return refusedAbsent(name, join(home, "bots", "nova", "agents", "x"));
          }
          if (name === "r-home-settings") {
            return refusedFileUnchanged(name, join(home, "settings.json"));
          }
          if (name === "rd-aws" || name === "rd-netrc" || name === "rd-ssh") {
            const secret = name === "rd-aws" ? "FAKE-AWS-SECRET-1" : name === "rd-netrc" ? "FAKE-NETRC-SECRET-2" : "FAKE-SSH-SECRET-3";
            const out = read(join(outDir, "out", `${name}.out`)) ?? "";
            if (exitOf(name) === "0") return fail(`${name} exited 0`);
            if (out.includes(secret)) return fail(`${name} printed the secret`);
            return { expected: "refused", ok: true, detail: `exit=${exitOf(name)} nothing shown` };
          }
          throw new Error(`no judge for probe ${name}`);
        };

        for (const p of probes) {
          const key = `${phase.tag}:${p.name}`;
          const judged = judge(p.name);
          // A known gap still runs (finding it again is the point) but cannot
          // fail the suite; anything else must behave as expected.
          rows.push({ phase: phase.tag, name: p.name, expected: judged.expected, ok: judged.ok || KNOWN_GAPS.has(key), detail: judged.detail });
        }
        rmSync(fx.direct, { force: true });
      }
    } finally {
      await driver.stop();
    }

    const bad = rows.filter((r) => !r.ok);
    const fixedGaps = rows.filter((r) => r.ok && KNOWN_GAPS.has(`${r.phase}:${r.name}`));
    const lines = [
      `shell-denies: ${rows.length - bad.length}/${rows.length} rows behaved as expected` +
      (skippedRows.length > 0 ? `; skipped: ${skippedRows.map((s) => `${s.phase}:${s.name} (${s.reason})`).join(", ")}` : ""),
      ...settingsSeen.map((s) => `settings ${s.phase}: allowWrite=${s.allowWrite} denyWrite=${s.denyWrite} denyRead=${s.denyRead}`),
      // Every row only when asked (SHELL_DENIES_TABLE=1); a failing row is in the assertion below either way.
      ...(process.env.SHELL_DENIES_TABLE ? rows.map((r) => `${r.ok ? "PASS" : "FAIL"} ${r.phase}:${r.name} expected=${r.expected} ${r.detail}`) : []),
    ];
    if (process.env.SHELL_DENIES_TABLE || bad.length > 0) console.error(lines.join("\n"));
    expect(fixedGaps.map((r) => `${r.phase}:${r.name} now passes: remove it from KNOWN_GAPS`)).toEqual([]);
    expect(bad.map((r) => `${r.phase}:${r.name} expected=${r.expected} ${r.detail}`)).toEqual([]);
  }, 180_000);

  // A leftover child (stage 2, lane C): a shell command returns while its child
  // keeps swapping the bot's scratch/x between a regular file and a link to a
  // file outside every write root, then file-tool Writes run through the real
  // runtime. Row 1 races 200 Writes against the swapper; row 2 is the no-child
  // control (a plain Write succeeds, a Write to a pre-existing link is refused,
  // the outside file is unchanged). The driver's approval stub allows
  // everything (no broker, so no card can appear and the link-race interim
  // rule in bot-check.ts is bypassed); refusals below come from the file-fence
  // hook or the runtime's own path check.
  darwinTest("a leftover child cannot redirect a later Write; the no-child control", async () => {
    const userDir = realpathSync(mkdtempSync(join(tmpdir(), "clover-shell-leftover-")));
    temps.push(userDir);
    const home = join(userDir, "c");
    const t = join(userDir, "t");
    mkdirSync(t, { recursive: true });
    const ctx0 = context(home, "winter-test/calls");
    const scratch = ctx0.paths.scratch;
    mkdirSync(scratch, { recursive: true });
    mkdirSync(ctx0.paths.root, { recursive: true });
    const proj = join(userDir, "proj");
    mkdirSync(proj, { recursive: true });
    const outside = join(userDir, "outside");
    mkdirSync(outside, { recursive: true });
    const target = join(outside, "target.txt");
    writeFileSync(target, "ORIGINAL");
    const x = join(scratch, "x");
    writeFileSync(x, "plain");

    const fence = new CloverFence({ home: userDir, cloverHome: home, temp: t });
    const sandbox = (ctx: BotSessionContext) => botSandboxSettings(fence.forCaller(ctx.caller).policy(), {
      cloverHome: home, userHome: userDir, level: "ask-risky", grantedWrite: [proj],
      ownFolders: [ctx.paths.scratch, ctx.paths.root], pathFolders: [],
    });
    const driver = new BotSessionDriver(context(home, "winter-test/calls"),
      deps(home, spawn, { sandbox, fileFence: botFileFence(fence, home) }));

    const read = (p: string): string | null => { try { return readFileSync(p, "utf8"); } catch { return null; } };
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    const gone = (e: unknown): boolean => (e as { code?: string } | null)?.code === "ESRCH";
    const isAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (e) { return !gone(e); } };
    const num = (v: string | null): number | undefined => {
      if (v === null) return undefined;
      const n = parseInt(v.trim(), 10);
      return Number.isSafeInteger(n) && n > 0 ? n : undefined;
    };
    type R = { name: string | null; isError: boolean; content: string };
    const out = (end: { text?: string }): R[] => JSON.parse(end.text ?? "[]") as R[];
    const pids: number[] = [];
    const takePids = (files: string[]): number[] => {
      const got: number[] = [];
      for (const f of files) {
        const n = num(read(f));
        if (n === undefined) continue;
        got.push(n);
        if (!pids.includes(n)) pids.push(n);
      }
      return [...new Set(got)];
    };
    const killPids = (list: number[]): void => { for (const p of list) { try { process.kill(p, "SIGKILL"); } catch { /* already gone */ } } };
    const sawLink = (): boolean => { try { return lstatSync(x).isSymbolicLink(); } catch { return false; } };

    const rows: { name: string; expected: string; ok: boolean; gap: boolean; detail: string }[] = [];
    const pushRow = (name: string, expected: string, ok: boolean, detail: string): void => {
      const gap = !ok && KNOWN_GAPS.has(`leftover:${name}`);
      rows.push({ name, expected, ok: ok || gap, gap, detail });
    };

    const launch = async (tag: string, command: string): Promise<R[]> => {
      const end = await driver.turn(
        user(`CALL Bash ${JSON.stringify({ command, description: `leftover probe ${tag}` })}`),
        control(),
      );
      expect(end.reason).toBe("end_turn");
      return out(end);
    };

    // The swap loop: up to 15 seconds of alternating scratch/x between a
    // regular file and a link to the outside target, so it exits by itself
    // even if the test crashes. It never writes through the link (rm always
    // comes first), so only the Write tool can change the target.
    const body = (self: string | null, hb: string): string =>
      [
        ...(self === null ? [] : [`echo $$ > ${q(self)}`]),
        `end=$((SECONDS+15))`,
        `while [ $SECONDS -lt $end ]; do /bin/rm -f ${q(x)}; printf plain > ${q(x)}; /bin/rm -f ${q(x)}; /bin/ln -s ${q(target)} ${q(x)}; printf . >> ${q(hb)}; done`,
      ].join("; ");
    const cmdFor = (tag: string, pidFile: string, self: string, hb: string, log: string): string => {
      if (tag === "subshell") return `( ${body(null, hb)} & echo $! > ${q(pidFile)} ); echo launched-${tag}`;
      if (tag === "nohup") return `/usr/bin/nohup /bin/sh -c '${body(self, hb)}' >${q(log)} 2>&1 & echo $! > ${q(pidFile)}; echo launched-${tag}`;
      return `/usr/bin/setsid /bin/sh -c '${body(self, hb)}' >${q(log)} 2>&1 & echo $! > ${q(pidFile)}; echo launched-${tag}`;
    };

    const seen: Record<string, { alive: boolean; adopted: boolean; detail: string }> = {};
    try {
      const tags = ["subshell", ...(existsSync("/usr/bin/nohup") ? ["nohup"] : []), ...(existsSync("/usr/bin/setsid") ? ["setsid"] : [])];
      for (const tag of tags) {
        writeFileSync(x, "plain");
        const pidFile = join(scratch, `.${tag}.pid`);
        const self = join(scratch, `.${tag}.self`);
        const hb = join(scratch, `.${tag}.hb`);
        const log = join(scratch, `.${tag}.log`);
        const res = await launch(tag, cmdFor(tag, pidFile, self, hb, log));
        await sleep(1000);
        const got = takePids(tag === "subshell" ? [pidFile] : [pidFile, self]);
        const hbA = read(hb);
        await sleep(300);
        const hbB = read(hb);
        const aliveNow = got.some(isAlive);
        const grew = hbB !== null && hbB.length > 0 && (hbA === null || hbB.length > hbA.length);
        const adopted = res.some((r) => r.name === "Bash" && r.content.includes("still running"));
        seen[tag] = { alive: aliveNow && grew, adopted, detail: `pids=${JSON.stringify(got)} alive=${aliveNow} hbGrew=${grew} adoptedNote=${adopted}` };
        killPids(got);
        await sleep(300);
        writeFileSync(x, "plain");
      }
      if (!tags.includes("nohup")) seen["nohup"] = { alive: false, adopted: false, detail: "skipped: /usr/bin/nohup missing" };
      if (!tags.includes("setsid")) seen["setsid"] = { alive: false, adopted: false, detail: "skipped: /usr/bin/setsid missing" };

      // Row 1: race Writes against the most evasive form that stayed alive.
      const pick = ["setsid", "nohup", "subshell"].find((tag) => seen[tag]?.alive === true);
      if (pick === undefined) {
        pushRow("row-1", "outside unchanged", false, "no form stayed alive; race not run");
      } else {
        const pidFile = join(scratch, ".race.pid");
        const self = join(scratch, ".race.self");
        const hb = join(scratch, ".race.hb");
        const log = join(scratch, ".race.log");
        writeFileSync(x, "plain");
        await launch(`race-${pick}`, cmdFor(pick, pidFile, self, hb, log));
        await sleep(500);
        const got = takePids(pick === "subshell" ? [pidFile] : [pidFile, self]);
        let looperAlive = got.some(isAlive) && (read(hb) ?? "").length > 0;
        let linkSeen = sawLink();
        for (let n = 0; n < 20 && !linkSeen; n++) { await sleep(100); if (sawLink()) linkSeen = true; }
        let writes = 0, allowed = 0, refused = 0, firstChange = -1;
        for (let b = 0; b < 10 && firstChange === -1; b++) {
          if (!got.some(isAlive)) { looperAlive = false; break; }
          const calls = Array.from({ length: 20 }, () => `CALL Write ${JSON.stringify({ file_path: x, content: "REDIRECTED" })}`).join("\n");
          const end = await driver.turn(user(calls), control());
          expect(end.reason).toBe("end_turn");
          for (const r of out(end)) {
            if (r.name !== "Write") continue;
            writes++;
            if (r.isError || r.content.includes("was not run")) refused++; else allowed++;
          }
          if (read(target) !== "ORIGINAL" && firstChange === -1) firstChange = writes;
          looperAlive = got.some(isAlive);
        }
        const changed = read(target) !== "ORIGINAL";
        pushRow("row-1", "outside unchanged", !changed,
          `form=${pick} linkSeen=${linkSeen} writes=${writes} allowed=${allowed} refused=${refused} firstChange=${firstChange} looperAlive=${looperAlive} target=${JSON.stringify(read(target))?.slice(0, 40)}`);
        killPids(got);
        await sleep(300);
        writeFileSync(x, "plain");
      }

      // Row 2, the control: no child alive; fresh names (no read-ladder
      // residue from the race); a plain Write succeeds with no card, a Write
      // to a pre-existing link is refused, the outside file is byte-for-byte
      // what the race left. Each Write is preceded by a Read through the
      // driver so the runtime's read-ladder (read before overwrite) is
      // satisfied and cannot mask the path checks.
      const noChild = pids.every((p) => !isAlive(p));
      const base = read(target);
      const x2 = join(scratch, "x2");
      const link2 = join(scratch, "link2");
      rmSync(x2, { force: true });
      rmSync(link2, { force: true });
      writeFileSync(x2, "plain2");
      symlinkSync(target, link2);
      const readEnd = await driver.turn(user([
        `CALL Read ${JSON.stringify({ file_path: x2 })}`,
        `CALL Read ${JSON.stringify({ file_path: link2 })}`,
      ].join("\n")), control());
      expect(readEnd.reason).toBe("end_turn");
      const reads = out(readEnd).filter((r) => r.name === "Read");
      const readX2 = reads[0] !== undefined && !reads[0].isError && !reads[0].content.includes("was not run");
      const readLink = reads[1] === undefined ? "no-result"
        : reads[1].content.includes("was not run") ? "fence-refused"
        : reads[1].isError ? `runtime-refused:${reads[1].content.slice(0, 120)}`
        : `allowed:${reads[1].content.slice(0, 80)}`;
      const wPlainEnd = await driver.turn(user(`CALL Write ${JSON.stringify({ file_path: x2, content: "CONTROLLED2" })}`), control());
      expect(wPlainEnd.reason).toBe("end_turn");
      const plainR = out(wPlainEnd).find((r) => r.name === "Write");
      const plainOk = readX2 && plainR !== undefined && !plainR.isError && !plainR.content.includes("was not run") && read(x2) === "CONTROLLED2";
      const wLinkEnd = await driver.turn(user(`CALL Write ${JSON.stringify({ file_path: link2, content: "PWNED2" })}`), control());
      expect(wLinkEnd.reason).toBe("end_turn");
      const linkR = out(wLinkEnd).find((r) => r.name === "Write");
      const linkRefused = linkR !== undefined && (linkR.isError || linkR.content.includes("was not run"));
      const layer = linkR === undefined ? "no-result" : linkR.content.includes("was not run") ? "file-fence" : linkR.isError ? `runtime:${linkR.content.slice(0, 120)}` : "allowed?!";
      const sameTarget = read(target) === base;
      pushRow("row-2", "plain allowed, link refused, outside same", noChild && plainOk && linkRefused && sameTarget,
        `noChild=${noChild} readX2=${readX2} readLink=${readLink} plainOk=${plainOk} linkRefused=${linkRefused} layer=${layer} targetSame=${sameTarget} linkResult=${JSON.stringify(linkR?.content)?.slice(0, 200)}`);
    } finally {
      killPids(pids.splice(0));
      await driver.stop();
    }

    const bad = rows.filter((r) => !r.ok);
    const fixed = rows.filter((r) => !r.gap && r.ok && KNOWN_GAPS.has(`leftover:${r.name}`));
    const lines = [
      `leftover-child: ${rows.length - bad.length}/${rows.length} rows held (no broker: 0 cards possible, refusals are fence/runtime)`,
      ...Object.entries(seen).map(([k, v]) => `leftover form ${k}: alive=${v.alive} adoptedNote=${v.adopted} ${v.detail}`),
      ...rows.map((r) => `${r.ok ? (r.gap ? "GAP " : "PASS ") : "FAIL "}leftover:${r.name} expected=${r.expected} ${r.detail}`),
    ];
    console.error(lines.join("\n"));
    expect(fixed.map((r) => `leftover:${r.name} now holds: remove it from KNOWN_GAPS`)).toEqual([]);
    expect(bad.map((r) => `leftover:${r.name} expected=${r.expected} ${r.detail}`)).toEqual([]);
  }, 300_000);
});

function readDirNames(dir: string): string {
  try { return readdirSync(dir).sort().join(","); } catch { return "<missing>"; }
}
