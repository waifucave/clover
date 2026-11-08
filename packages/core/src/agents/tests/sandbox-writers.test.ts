// The sandbox writers (writers.ts): the fence's SandboxPolicy in Codex's and Claude Code's own formats; the vendors'
// own config write-denied; no entry reopening a stricter folder, by case or by link; Claude Code with no settings
// sources and a mode floor the session holds; their admission rows stay `unverified` until the live gates pass; and
// the live gates' probes (live-gates.ts) each succeed without a sandbox, so a refusal under one means something.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxPolicy } from "../../contracts/fence";
import { ADMISSIONS, admissionFor } from "../sandbox/admission";
import { againstBaseline, codexSandboxArgv, gateFixture, gateProbes, judgeBaseline, runProbes, type ProbeResult } from "../sandbox/live-gates";
import {
  CODEX_MODE_FLOOR, CODEX_PROFILE, WRITERS, claudeCodeModeFloor, claudeCodeWriter, codexProfile, codexWriter, literalDenials, vendorConfigPaths,
} from "../sandbox/writers";
import { World, waitFor, type WorldOptions } from "./world";

setDefaultTimeout(60_000);

const H = "/u/me", C = "/u/me/.clover";
const policy = (over: Partial<SandboxPolicy> = {}): SandboxPolicy => ({
  allowWrite: [H, "/tmp"],
  denyWrite: [`${C}/settings.json`, `${C}/credentials`, `${C}/run`, `${C}/bots/*/memory`, `${C}/bots`, `${H}/dev`, C],
  denyRead: [`${C}/run`, `${C}/bots/*/memory`, `${C}/sessions-runtime`, C],
  closedDoors: ["open", "launchctl", "osascript"],
  blockedAddresses: ["169.254.169.254"],
  network: "none",
  ...over,
});
const ctx = { root: `${H}/work`, dir: `${C}/sessions-runtime/s1/setup`, home: H };
const VENDOR = [`${H}/.codex`, `${H}/.claude`, `${H}/.claude.json`, `${H}/work/.codex`, `${H}/work/.claude`, `${H}/work/.mcp.json`, `${H}/.mcp.json`];
const message = (f: () => unknown) => {
  try {
    f();
    return "written";
  } catch (e) {
    return (e as Error).message;
  }
};
const claudeOptions = (p: SandboxPolicy, c: typeof ctx & { level?: "ask" | "accept-edits" } = ctx) =>
  (claudeCodeWriter(p, c).meta as { claudeCode: { options: Record<string, any> } }).claudeCode.options;

describe("the writers' input", () => {
  test("a pattern item is dropped where a literal denial holds it, widened to its folder otherwise, refused without one", () => {
    expect(literalDenials(policy())).toEqual({
      denyRead: [`${C}/run`, `${C}/sessions-runtime`, C],
      denyWrite: [`${C}/settings.json`, `${C}/credentials`, `${C}/run`, `${C}/bots`, `${H}/dev`, C],
    });
    expect(literalDenials(policy({ denyRead: [`${C}/bots/*/memory`], denyWrite: [`${C}/bots/*/memory`] }))).toEqual({ denyRead: [`${C}/bots`], denyWrite: [] });
    expect(literalDenials(policy({ denyRead: [], denyWrite: [`${C}/bots/*/memory`] }))).toEqual({ denyRead: [], denyWrite: [`${C}/bots`] });
    // Held exactly: `/u/me/.Clover` doesn't hold `/u/me/.clover/…`, so the pattern widens instead of dropping.
    expect(literalDenials(policy({ denyRead: ["/u/me/.Clover", `${C}/bots/*/memory`], denyWrite: [] })).denyRead).toEqual(["/u/me/.Clover", `${C}/bots`]);
    expect(message(() => codexWriter(policy({ denyRead: ["*/secrets"] }), ctx))).toContain("has no folder to deny");
  });

  test("a bot's own memory or a filtered network is refused, never written", () => {
    expect(message(() => codexWriter({ ...policy(), ownMemory: `${C}/bots/alpha/memory` }, ctx))).toContain("ownMemory");
    expect(message(() => claudeCodeWriter({ ...policy(), ownMemory: `${C}/bots/alpha/memory` }, ctx))).toContain("ownMemory");
    expect(message(() => codexWriter(policy({ network: "filtered" }), ctx))).toContain("only \"none\" is written");
    expect(message(() => claudeCodeWriter(policy({ network: "filtered" }), ctx))).toContain("only \"none\" is written");
  });

  test("the vendors' config: the home's, a moved vendor home, and the project files from the root up to the home", () => {
    expect(vendorConfigPaths(ctx)).toEqual(VENDOR);
    expect(vendorConfigPaths({ ...ctx, root: `${H}/a/b`, env: { CODEX_HOME: "/v/codex", CLAUDE_CONFIG_DIR: "/v/claude/", HOME: H } })).toEqual([
      `${H}/.codex`, `${H}/.claude`, `${H}/.claude.json`, "/v/codex", "/v/claude",
      `${H}/a/b/.codex`, `${H}/a/b/.claude`, `${H}/a/b/.mcp.json`, `${H}/a/.codex`, `${H}/a/.claude`, `${H}/a/.mcp.json`, `${H}/.mcp.json`,
    ]);
    // A root outside the home: its own files, nothing above it.
    expect(vendorConfigPaths({ ...ctx, root: "/srv/x" })).toEqual([`${H}/.codex`, `${H}/.claude`, `${H}/.claude.json`, "/srv/x/.codex", "/srv/x/.claude", "/srv/x/.mcp.json"]);
  });
});

describe("Codex's profile", () => {
  test("CODEX_CONFIG names the clover profile as the default: the root readable, writes where allowed, denials closed, the vendors' config read-only, no network", () => {
    const setup = codexWriter(policy(), ctx);
    expect(Object.keys(setup)).toEqual(["env", "modeFloor"]);
    expect(setup.modeFloor!("automatic")).toEqual(CODEX_MODE_FLOOR);
    expect(Object.keys(setup.env!)).toEqual(["CODEX_CONFIG"]);
    const config = JSON.parse(setup.env!["CODEX_CONFIG"]!);
    expect(config.default_permissions).toBe(CODEX_PROFILE);
    expect(config.permissions[CODEX_PROFILE]).toEqual({
      filesystem: { ":root": "read", [H]: "write", "/tmp": "write", [`${H}/dev`]: "read", [C]: "deny", ...Object.fromEntries(VENDOR.map((v) => [v, "read"])) },
      network: { enabled: false },
    });
  });

  test("an entry never reopens what a folder above it closes; a stricter entry inside a looser one stays", () => {
    const fs = codexProfile(policy({ allowWrite: [H, `${C}/scratch`], denyWrite: [`${H}/dev`, `${C}/credentials`], denyRead: [C, `${H}/dev/keys`] }), ctx).filesystem;
    expect(fs).toEqual({ ":root": "read", [H]: "write", [`${H}/dev`]: "read", [C]: "deny", [`${H}/dev/keys`]: "deny", ...Object.fromEntries(VENDOR.map((v) => [v, "read"])) });
    // The same path in two lists keeps its strictest access.
    expect(codexProfile(policy({ allowWrite: [H], denyWrite: [`${H}/x`], denyRead: [`${H}/x`] }), ctx).filesystem[`${H}/x`]).toBe("deny");
    // No write folders: the session's root, as clover-code does.
    expect(codexProfile(policy({ allowWrite: [] }), ctx).filesystem[ctx.root]).toBe("write");
  });

  test("compared case-folded: a looser entry under a denial by another case is left out (the review's probe)", () => {
    const fs = codexProfile(policy({ allowWrite: ["/Users/k", "/Users/K/.clover/scratch"], denyRead: ["/Users/k/.clover"], denyWrite: ["/Users/K/.clover/bots"] }), { ...ctx, home: "/Users/k", root: "/Users/k/w" }).filesystem;
    expect(fs["/Users/k/.clover"]).toBe("deny");
    expect(fs["/Users/K/.clover/bots"]).toBeUndefined();
    expect(fs["/Users/K/.clover/scratch"]).toBeUndefined();
    for (const [path, a] of Object.entries(fs)) if (path.toLowerCase().startsWith("/users/k/.clover/")) expect(a).toBe("deny");
  });
});

describe.skipIf(process.platform === "win32")("a home reached through a link", () => {
  let root: string | undefined;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  test("each denial is written by the path it was given and by its real path, in both writers; nothing under it reopens", () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "clover-k-wr-")));
    const real = join(root, "real-home"), link = join(root, "home");
    mkdirSync(join(real, ".clover", "credentials"), { recursive: true });
    symlinkSync(real, link);
    const p = policy({ allowWrite: [link], denyWrite: [join(link, ".clover", "credentials"), join(link, ".clover")], denyRead: [join(link, ".clover")] });
    const c = { ...ctx, home: link, root: join(link, "work") };
    const fs = codexProfile(p, c).filesystem;
    expect(fs[join(link, ".clover")]).toBe("deny");
    expect(fs[join(real, ".clover")]).toBe("deny");
    // `credentials` by either form is inside the denied home by its real path: never written as "read".
    expect(fs[join(link, ".clover", "credentials")]).toBeUndefined();
    expect(fs[join(real, ".clover", "credentials")]).toBeUndefined();
    expect(fs[join(real, ".codex")]).toBe("read");
    const o = claudeOptions(p, c);
    expect(o["sandbox"].filesystem.denyRead).toEqual([join(link, ".clover"), join(real, ".clover")]);
    expect(o["sandbox"].filesystem.denyWrite).toEqual(expect.arrayContaining([join(real, ".clover"), join(real, ".clover", "credentials"), join(real, ".claude")]));
    expect(o["settings"].permissions.deny).toEqual(expect.arrayContaining([`Read(/${join(real, ".clover")}/**)`, `Edit(/${join(real, ".claude")}/**)`]));
  });
});

describe("Claude Code's _meta", () => {
  test("no settings sources, the sandbox with no way out of it, the fence's folders, no network, and the file tools' deny rules", () => {
    const setup = claudeCodeWriter(policy(), ctx);
    expect(Object.keys(setup)).toEqual(["meta", "modeFloor"]);
    const o = claudeOptions(policy());
    expect(o["settingSources"]).toEqual([]);
    expect(o["sandbox"]).toMatchObject({
      enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: false, allowUnsandboxedCommands: false, excludedCommands: [],
      enableWeakerNestedSandbox: false, enableWeakerNetworkIsolation: false,
      network: { allowedDomains: [], allowLocalBinding: false, allowAllUnixSockets: false, allowUnixSockets: [] },
    });
    const fsys = o["sandbox"].filesystem as { allowWrite: string[]; denyWrite: string[]; denyRead: string[] };
    expect(fsys.allowWrite).toEqual([H, "/tmp"]);
    expect(fsys.denyRead).toEqual([`${C}/run`, `${C}/sessions-runtime`, C]);
    // A read-denied folder is write-denied too, the vendors' config is, and no pattern reaches the vendor.
    for (const d of [...fsys.denyRead, ...VENDOR]) expect(fsys.denyWrite).toContain(d);
    expect([...fsys.denyRead, ...fsys.denyWrite].some((p) => p.includes("*"))).toBe(false);
    const deny = o["settings"].permissions.deny as string[];
    expect(deny).toContain(`Read(/${C})`);
    expect(deny).toContain(`Read(/${C}/**)`);
    expect(deny).toContain(`Edit(/${H}/dev/**)`);
    expect(deny).not.toContain(`Read(/${H}/dev/**)`); // dev folders are write-denied only
    for (const v of VENDOR) expect(deny).toEqual(expect.arrayContaining([`Edit(/${v})`, `Write(/${v}/**)`]));
    expect(deny).toEqual(expect.arrayContaining(["Bash(open:*)", "Bash(launchctl:*)", "Bash(osascript:*)"]));
  });

  test("the mode floor: never bypassPermissions; acceptEdits only at a level that accepts edits; absent counts as strictest", () => {
    expect(claudeCodeModeFloor(undefined)).toEqual({ refused: ["bypassPermissions", "acceptEdits"], fallback: "default" });
    for (const l of ["read-only", "ask", "ask-risky"] as const) expect(claudeCodeModeFloor(l).refused).toEqual(["bypassPermissions", "acceptEdits"]);
    for (const l of ["accept-edits", "automatic"] as const) expect(claudeCodeModeFloor(l).refused).toEqual(["bypassPermissions"]);
    // The writer hands the floor by level, so the session holds it against the level at each turn.
    expect(claudeCodeWriter(policy(), ctx).modeFloor).toBe(claudeCodeModeFloor);
  });
});

describe("the session holds the mode floor", () => {
  let world: World | undefined;
  afterEach(async () => {
    await world?.close();
    world = undefined;
  });
  const make = (o: WorldOptions) => (world = new World({ ...o, modeFloor: claudeCodeModeFloor }));
  const notification = (w: World) => w.parentInputs("task-notification")[0]?.input as { text: string; stopReason?: string } | undefined;

  test("started in bypassPermissions (the user's defaultMode) at ask: switched to default before the first turn", async () => {
    const w = make({ level: "ask", modes: ["bypassPermissions", "default", "acceptEdits"], script: [[{ say: "done" }]] });
    await w.delegate();
    expect((await waitFor(() => notification(w), "the notification")).text).toContain("done");
    expect(w.report("config")).toEqual([expect.objectContaining({ option: "mode", value: "default" })]);
  });

  test("acceptEdits is switched at ask and kept at accept-edits", async () => {
    const w = make({ level: "ask", modes: ["acceptEdits", "default"], script: [[{ say: "done" }]] });
    await w.delegate();
    await waitFor(() => notification(w), "the notification");
    expect(w.report("config")).toEqual([expect.objectContaining({ option: "mode", value: "default" })]);
    await w.close();
    world = undefined;
    const w2 = make({ level: "accept-edits", modes: ["acceptEdits", "default"], script: [[{ say: "done" }]] });
    await w2.delegate();
    await waitFor(() => notification(w2), "the notification");
    expect(w2.report("config")).toEqual([]);
  });

  test("the level drops from accept-edits to ask mid-session: acceptEdits is switched to default before the next turn", async () => {
    const w = make({ level: "accept-edits", modes: ["acceptEdits", "default"], script: [[{ say: "one" }], [{ say: "two" }], [{ say: "three" }]] });
    const r = await w.delegate();
    await waitFor(() => notification(w), "the first notification");
    expect(w.report("config")).toEqual([]); // allowed at accept-edits
    w.level = "ask";
    await w.host.deliver(r.sessionId, { from: "bot", bot: "alpha", session: "s_alpha", text: "Two." });
    await waitFor(() => w.parentInputs("task-notification").length === 2, "the second notification");
    expect(w.report("config").map((c) => [c["option"], c["value"]])).toEqual([["mode", "default"]]);
    expect(w.report("prompt")).toHaveLength(2);
    // Raised again: the floor allows acceptEdits, and nothing is switched back on its own.
    w.level = "accept-edits";
    await w.host.deliver(r.sessionId, { from: "bot", bot: "alpha", session: "s_alpha", text: "Three." });
    await waitFor(() => w.parentInputs("task-notification").length === 3, "the third notification");
    expect(w.report("config")).toHaveLength(1);
  });

  test("the level drops and the agent can't leave acceptEdits: its session is ended, and the turn isn't sent", async () => {
    const w = make({ level: "automatic", modes: ["acceptEdits"], script: [[{ say: "one" }], [{ say: "never" }]] });
    const r = await w.delegate();
    await waitFor(() => notification(w), "the first notification");
    w.level = "ask";
    await w.host.deliver(r.sessionId, { from: "bot", bot: "alpha", session: "s_alpha", text: "Two." });
    const second = await waitFor(() => w.parentInputs("task-notification")[1]?.input as { text: string; stopReason?: string } | undefined, "the second notification");
    expect(second.text).toContain("acceptEdits mode");
    expect(w.report("prompt")).toHaveLength(1);
  });

  test("an agent that can't leave a refused mode isn't started", async () => {
    const w = make({ level: "automatic", modes: ["bypassPermissions"], script: [[{ say: "never" }]] });
    await w.delegate();
    const n = await waitFor(() => notification(w), "the notification");
    expect(n.stopReason).toBe("error");
    expect(n.text).toContain("bypassPermissions mode");
    expect(w.report("prompt")).toEqual([]);
  });
});

describe("the writers' admission", () => {
  test("Codex's and Claude Code's rows stay unverified, writer ready, until the live gates pass; no row is protected", () => {
    for (const id of Object.keys(WRITERS)) {
      for (const os of ["macos", "linux", "windows"] as const) {
        const a = admissionFor(ADMISSIONS, id, os, "9.9.9");
        expect(a.status).not.toBe("protected");
        if (id === "claude-code" && os === "windows") expect(a.status).toBe("unsupported");
        else expect(a).toEqual({ status: "unverified", reason: expect.stringContaining("writer ready; awaiting live gates") });
      }
    }
    for (const rows of Object.values(ADMISSIONS)) for (const row of Object.values(rows)) expect(row!.status).not.toBe("protected");
  });
});

describe.skipIf(process.platform === "win32")("the live gates' fixture and probes", () => {
  const env = (f: ReturnType<typeof gateFixture>) => ({ HOME: f.home, PATH: process.env["PATH"] ?? "/usr/bin:/bin", TMPDIR: f.temp });

  test("the real fence's policy for the fixture denies the Clover home; Codex's -c overrides parse back to the writer's profile", () => {
    const f = gateFixture();
    try {
      expect(f.policy.denyRead).toContain(f.cloverHome);
      expect(f.policy.denyWrite).toContain(f.cloverHome);
      const argv = codexSandboxArgv(f);
      expect(argv.slice(0, 6)).toEqual(["codex", "sandbox", "-C", f.work, "-P", CODEX_PROFILE]);
      expect(argv.at(-1)).toBe("--");
      const table = argv.find((a) => a.startsWith(`permissions.${CODEX_PROFILE}.filesystem=`))!;
      const parsed = Bun.TOML.parse(`fs = ${table.slice(table.indexOf("=") + 1)}`) as { fs: Record<string, string> };
      expect(parsed.fs).toEqual(codexProfile(f.policy, f.ctx).filesystem);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  for (const linkedHome of [false, true]) {
    test(`the baseline${linkedHome ? ", the home through a link" : ""}: every allowed probe passes and every refused one succeeds with no sandbox`, () => {
      const f = gateFixture(tmpdir(), { linkedHome });
      try {
        const probes = gateProbes(f, { doors: false, network: false });
        const names = probes.map((p) => p.name);
        expect(probes.filter((p) => p.expect === "refused").length).toBeGreaterThan(30);
        for (const want of ["credentials/token", "bots/beta/memory", "list a denied folder", "remove a fenced file", "rename a fenced folder inside the root",
          "remove a fenced folder inside the root", "create the root's .codex/config.toml", "create the root's .claude/settings.json", "create the root's .mcp.json",
          "write /home/.codex/config.toml", "write /home/.claude/settings.json", "write /home/.claude.json"]) {
          expect(names.some((n) => n.includes(want))).toBe(true);
        }
        // The case-variant read is macOS's (its disks fold case), whichever OS builds the list.
        expect(gateProbes(f, { os: "macos", doors: false, network: false }).map((p) => p.name)).toContain("read by another case");
        expect(gateProbes(f, { os: "linux", doors: false, network: false }).map((p) => p.name)).not.toContain("read by another case");
        if (linkedHome) expect(names).toEqual(expect.arrayContaining(["read by the home's real path", "write by the home's real path"]));
        const judged = judgeBaseline(runProbes(f, probes, [], env(f)));
        expect(judged.filter((r) => !r.pass).map((r) => r.name)).toEqual([]);
      } finally {
        rmSync(f.root, { recursive: true, force: true });
      }
    });
  }

  test("a sandboxed refusal whose baseline didn't succeed fails as vacuous", () => {
    const r = (name: string, expect_: "ok" | "refused", exit: number): ProbeResult => ({ name, expect: expect_, exit, pass: expect_ === "ok" ? exit === 0 : exit !== 0, hostUnchanged: true, diagnostic: "" });
    const sandboxed = [r("write the root", "ok", 0), r("read a secret", "refused", 1), r("read nothing", "refused", 1)];
    const baseline = [r("write the root", "ok", 0), r("read a secret", "refused", 0), r("read nothing", "refused", 1)];
    expect(againstBaseline(sandboxed, baseline).map((x) => [x.name, x.pass, x.vacuous ?? false])).toEqual([
      ["write the root", true, false], ["read a secret", true, false], ["read nothing", false, true],
    ]);
  });
});
