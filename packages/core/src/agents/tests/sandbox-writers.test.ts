// The sandbox writers (writers.ts): the fence's SandboxPolicy in Codex's and Claude Code's own formats, pure; their
// admission rows stay `unverified` until the live gates pass; and the live gates' probes (live-gates.ts) each fail
// without a sandbox, so a pass under one means something.
import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import type { SandboxPolicy } from "../../contracts/fence";
import { ADMISSIONS, admissionFor } from "../sandbox/admission";
import { codexSandboxArgv, gateFixture, gateProbes, runProbes } from "../sandbox/live-gates";
import { CODEX_PROFILE, WRITERS, claudeCodeWriter, codexProfile, codexWriter, literalDenials } from "../sandbox/writers";

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
const ctx = { root: `${H}/work`, dir: `${C}/sessions-runtime/s1/setup` };
const message = (f: () => unknown) => {
  try {
    f();
    return "written";
  } catch (e) {
    return (e as Error).message;
  }
};

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
});

describe("Codex's profile", () => {
  test("CODEX_CONFIG names the clover profile as the default: the root readable, writes where allowed, denials closed, no network", () => {
    const setup = codexWriter(policy(), ctx);
    expect(Object.keys(setup)).toEqual(["env"]);
    expect(Object.keys(setup.env!)).toEqual(["CODEX_CONFIG"]);
    const config = JSON.parse(setup.env!["CODEX_CONFIG"]!);
    expect(config.default_permissions).toBe(CODEX_PROFILE);
    expect(config.permissions[CODEX_PROFILE]).toEqual({
      filesystem: { ":root": "read", [H]: "write", "/tmp": "write", [`${H}/dev`]: "read", [C]: "deny" },
      network: { enabled: false },
    });
  });

  test("an entry never reopens what a folder above it closes; a stricter entry inside a looser one stays", () => {
    const fs = codexProfile(policy({ allowWrite: [H, `${C}/scratch`], denyWrite: [`${H}/dev`, `${C}/credentials`], denyRead: [C, `${H}/dev/keys`] }), ctx.root).filesystem;
    expect(fs).toEqual({ ":root": "read", [H]: "write", [`${H}/dev`]: "read", [C]: "deny", [`${H}/dev/keys`]: "deny" });
    // The same path in two lists keeps its strictest access.
    expect(codexProfile(policy({ allowWrite: [H], denyWrite: [`${H}/x`], denyRead: [`${H}/x`] }), ctx.root).filesystem[`${H}/x`]).toBe("deny");
    // No write folders: the session's root, as clover-code does.
    expect(codexProfile(policy({ allowWrite: [] }), ctx.root).filesystem[ctx.root]).toBe("write");
  });
});

describe("Claude Code's _meta", () => {
  test("the sandbox with no way out of it, the fence's folders, no network, and the file tools' deny rules", () => {
    const setup = claudeCodeWriter(policy(), ctx);
    expect(Object.keys(setup)).toEqual(["meta"]);
    const o = (setup.meta as { claudeCode: { options: Record<string, any> } }).claudeCode.options;
    expect(o["sandbox"]).toMatchObject({
      enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: false, allowUnsandboxedCommands: false, excludedCommands: [],
      enableWeakerNestedSandbox: false, enableWeakerNetworkIsolation: false,
      network: { allowedDomains: [], allowLocalBinding: false, allowAllUnixSockets: false, allowUnixSockets: [] },
    });
    const fsys = o["sandbox"].filesystem as { allowWrite: string[]; denyWrite: string[]; denyRead: string[] };
    expect(fsys.allowWrite).toEqual([H, "/tmp"]);
    expect(fsys.denyRead).toEqual([`${C}/run`, `${C}/sessions-runtime`, C]);
    // A read-denied folder is write-denied too, and no pattern reaches the vendor.
    for (const d of fsys.denyRead) expect(fsys.denyWrite).toContain(d);
    expect([...fsys.denyRead, ...fsys.denyWrite].some((p) => p.includes("*"))).toBe(false);
    const deny = o["settings"].permissions.deny as string[];
    expect(deny).toContain(`Read(/${C})`);
    expect(deny).toContain(`Read(/${C}/**)`);
    expect(deny).toContain(`Edit(/${H}/dev/**)`);
    expect(deny).not.toContain(`Read(/${H}/dev/**)`); // dev folders are write-denied only
    expect(deny).toEqual(expect.arrayContaining(["Bash(open:*)", "Bash(launchctl:*)", "Bash(osascript:*)"]));
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
      expect(parsed.fs).toEqual(codexProfile(f.policy, f.work).filesystem);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  test("unsandboxed, every allowed probe passes and every refused one fails: each probe can tell a sandbox from none", () => {
    const f = gateFixture();
    try {
      const probes = gateProbes(f, { doors: false, network: false });
      expect(probes.filter((p) => p.expect === "refused").length).toBeGreaterThan(20);
      expect(probes.some((p) => p.name.includes("credentials/token"))).toBe(true);
      expect(probes.some((p) => p.name.includes("bots/beta/memory"))).toBe(true); // a bot the fence doesn't name
      const results = runProbes(f, probes, [], { HOME: f.home, PATH: process.env["PATH"] ?? "/usr/bin:/bin", TMPDIR: f.temp });
      const wrong = results.filter((r) => r.pass !== (r.expect === "ok")).map((r) => r.name);
      expect(wrong).toEqual([]);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
});
