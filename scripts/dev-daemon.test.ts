import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundledLinkBinary } from "../packages/core/src/links/sidecar-binary";
import { OTHER_INSTALL_HOMES } from "../packages/core/src/other-installs";
import { LINK_BUILD, LINK_OUTPUT } from "./build-packages";
import { describeDevDaemonPlan, designatedRequirementOf, DEV_DAEMON_IDENTIFIER, DEV_LINK_IDENTIFIER, devCompileCommand, devLinkSidecarPlan, devDaemonHome, devDaemonPlan, devDaemonRequirement, devOs, resolveDevSigningIdentity, signedFacts } from "./dev-daemon-lib";

const TEAM = "37N77U9RSZ";
const IDENTITIES = `  1) ${"A".repeat(40)} "Apple Development: someone@example.invalid (AAAAAAAAAA)"
  2) ${"B".repeat(40)} "Developer ID Application: Example Org (${TEAM})"
  3) ${"C".repeat(40)} "Apple Development: A Person (BBBBBBBBBB)"
     3 valid identities found
`;
const SUBJECTS: Record<string, string> = {
  "Apple Development: someone@example.invalid (AAAAAAAAAA)": "subject=UID=X, CN=Apple Development: someone@example.invalid (AAAAAAAAAA), OU=OTHERTEAM1, O=Someone, C=US",
  [`Developer ID Application: Example Org (${TEAM})`]: `subject=UID=${TEAM}, CN=Developer ID Application: Example Org (${TEAM}), OU=${TEAM}, O=Example Org, C=US`,
  "Apple Development: A Person (BBBBBBBBBB)": `subject=UID=Y, CN=Apple Development: A Person (BBBBBBBBBB), OU=${TEAM}, O=Example Org, C=US`,
};

describe("the dev daemon's signing identity", () => {
  test("the team is the certificate's OU, not the name's parenthetical; Apple Development preferred; by hash", () => {
    expect(resolveDevSigningIdentity({ identitiesOutput: IDENTITIES, teamId: TEAM, subjectOf: (n) => SUBJECTS[n] })).toEqual({ hash: "C".repeat(40), name: "Apple Development: A Person (BBBBBBBBBB)" });
    const noDev = IDENTITIES.split("\n").filter((l) => !l.includes("A Person")).join("\n");
    expect(resolveDevSigningIdentity({ identitiesOutput: noDev, teamId: TEAM, subjectOf: (n) => SUBJECTS[n] }).hash).toBe("B".repeat(40));
  });

  test("none for the team is a clear error; the override wins without a lookup", () => {
    expect(() => resolveDevSigningIdentity({ identitiesOutput: IDENTITIES, teamId: "NOSUCHTEAM", subjectOf: (n) => SUBJECTS[n] })).toThrow("no code-signing identity for team NOSUCHTEAM");
    expect(resolveDevSigningIdentity({ identitiesOutput: "", teamId: TEAM, subjectOf: () => undefined, override: " D1 " })).toEqual({ hash: "D1", name: "(CLOVER_DEV_SIGN_IDENTITY)" });
  });
});

describe("the dev daemon's build and home", () => {
  test("the build is compile:core itself with only the output moved (the pairing cannot drift)", () => {
    const script = (JSON.parse(readFileSync(join(import.meta.dir, "..", "packages", "cli", "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts["compile:core"]!;
    const dev = devCompileCommand(script, "/x/dist/dev/clover-core.1.tmp");
    expect(dev).toBe(script.replace("--outfile ../../dist/clover-core", '--outfile "/x/dist/dev/clover-core.1.tmp"'));
    expect(dev).toContain("src/embedded-worker.ts");
    expect(() => devCompileCommand("bun build --compile src/main.ts --outfile elsewhere", "/x")).toThrow("update scripts/dev-daemon-lib.ts");
  });

  test("home: CLOVER_HOME or ~/.clover-dev, never the dist home", () => {
    expect(devDaemonHome({}, "/Users/u")).toBe("/Users/u/.clover-dev");
    expect(devDaemonHome({ CLOVER_HOME: "/tmp/h" }, "/Users/u")).toBe("/tmp/h");
    expect(() => devDaemonHome({ CLOVER_HOME: "/Users/u/.clover/" }, "/Users/u")).toThrow("dist home");
  });

  // C0 review B1: never another install's home either (`other-installs.ts`, whose own test pins the list), by real
  // path. A stand-in user home; the real one is never named.
  test("home: never another install's home, nor anything inside one, nor a link to one", () => {
    const user = mkdtempSync(join(tmpdir(), "clover-fake-user-"));
    for (const { dir, what } of OTHER_INSTALL_HOMES) {
      mkdirSync(join(user, dir));
      expect(() => devDaemonHome({ CLOVER_HOME: join(user, dir) }, user)).toThrow(`that is ${what}, which Clover never touches`);
      expect(() => devDaemonHome({ CLOVER_HOME: join(user, dir, "inner") }, user)).toThrow("which Clover never touches");
    }
    const first = OTHER_INSTALL_HOMES[0]!;
    const link = join(mkdtempSync(join(tmpdir(), "clover-link-")), "dev-home");
    symlinkSync(join(user, first.dir), link);
    expect(() => devDaemonHome({ CLOVER_HOME: link }, user)).toThrow(first.what);
    mkdirSync(join(user, ".clover"));
    const distLink = join(mkdtempSync(join(tmpdir(), "clover-link-")), "dist");
    symlinkSync(join(user, ".clover"), distLink);
    expect(() => devDaemonHome({ CLOVER_HOME: distLink }, user)).toThrow("dist home");
  });

  test("the stated designated requirement: identifier + Clover's team under Apple's anchor, never a certificate's name; and how codesign prints it back", () => {
    expect(devDaemonRequirement(TEAM)).toBe(`identifier "com.waifucave.clover.core.dev" and anchor apple generic and certificate leaf[subject.OU] = "${TEAM}"`);
    expect(designatedRequirementOf(`Executable=/x\ndesignated => ${devDaemonRequirement(TEAM)}\n`)).toBe(devDaemonRequirement(TEAM));
    expect(designatedRequirementOf("# no requirement\n")).toBeUndefined();
  });

  test("the signature facts the build insists on", () => {
    const dv = `Executable=/x\nIdentifier=${DEV_DAEMON_IDENTIFIER}\nFormat=Mach-O thin (arm64)\nCodeDirectory v=20500 size=1 flags=0x10000(runtime) hashes=1+7 location=embedded\nTeamIdentifier=${TEAM}\n`;
    expect(signedFacts(dv)).toEqual({ identifier: DEV_DAEMON_IDENTIFIER, teamId: TEAM, runtime: true });
    expect(signedFacts("Identifier=bun\nCodeDirectory v=1 size=1 flags=0x2(adhoc) hashes=1\nTeamIdentifier=not set\n")).toEqual({ identifier: "bun", runtime: false });
  });
});

// M-M0: the dev daemon on every OS. The plan is decided before anything is built or started; `--dry-run` prints it.
describe("the dev daemon's plan on each OS", () => {
  const compileCoreScript = (JSON.parse(readFileSync(join(import.meta.dir, "..", "packages", "cli", "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts["compile:core"]!;
  const plan = (argv: string[], platform: NodeJS.Platform, env: NodeJS.ProcessEnv = {}) => devDaemonPlan({ argv, env, platform, userHome: "/home/u", compileCoreScript, pid: 7 });

  test("which OS", () => {
    expect([devOs("darwin"), devOs("linux"), devOs("win32")]).toEqual(["macos", "linux", "windows"]);
  });

  test("every OS builds compile:core beside the binary and runs `daemon run` on ~/.clover-dev; only macOS signs", () => {
    for (const [platform, os, binary, tmp] of [
      ["darwin", "macos", "dist/dev/clover-core", "../../dist/dev/clover-core.7.tmp"],
      ["linux", "linux", "dist/dev/clover-core", "../../dist/dev/clover-core.7.tmp"],
      ["win32", "windows", "dist/dev/clover-core.exe", "../../dist/dev/clover-core.7.tmp.exe"],
    ] as const) {
      const p = plan([], platform);
      expect(p).toEqual({
        os,
        home: "/home/u/.clover-dev",
        binary,
        build: { command: devCompileCommand(compileCoreScript, tmp), tmp, sign: os === "macos" },
        transition: false,
        args: ["daemon", "run"],
        env: { CLOVER_HOME: "/home/u/.clover-dev", CLOVER_PROFILE: "dev" },
        dryRun: false,
      });
    }
  });

  test("the flags: --no-build, --cli, pass-through after the first other word or a --, --dry-run", () => {
    expect(plan(["--no-build"], "linux").build).toBeUndefined();
    expect(plan(["--no-build", "--cli"], "linux").args).toEqual([]);
    expect(plan(["--no-build", "--cli", "credentials", "list"], "linux").args).toEqual(["credentials", "list"]);
    expect(plan(["credentials", "--no-build"], "linux")).toMatchObject({ args: ["credentials", "--no-build"] });
    expect(plan(["--", "--no-build"], "linux")).toMatchObject({ args: ["--no-build"] });
    expect(plan(["--dry-run", "--no-build"], "win32")).toMatchObject({ dryRun: true, build: undefined });
  });

  test("the Keychain transition is macOS-only and takes no other arguments", () => {
    expect(plan(["--transition"], "darwin").transition).toBe(true);
    expect(() => plan(["--transition"], "linux")).toThrow("--transition is macOS-only");
    expect(() => plan(["--transition"], "win32")).toThrow("--transition is macOS-only");
    expect(() => plan(["--transition", "daemon", "run"], "darwin")).toThrow("--transition takes no other arguments");
  });

  test("the home is refused before anything else, on every OS", () => {
    for (const platform of ["darwin", "linux", "win32"] as const) {
      expect(() => plan(["--dry-run"], platform, { CLOVER_HOME: "/home/u/.clover" })).toThrow("dist home");
    }
    expect(plan(["--dry-run"], "linux", { CLOVER_HOME: "/tmp/elsewhere" }).home).toBe("/tmp/elsewhere");
  });

  test("--dry-run says what would be built, signed and run", () => {
    const linux = describeDevDaemonPlan(plan(["--dry-run"], "linux"));
    expect(linux[0]).toBe("dev:daemon: the plan on linux (dry run: nothing is built, signed or started)");
    expect(linux).toContain("  sign     none (the dev binary is unsigned on linux); rename to dist/dev/clover-core");
    expect(linux.some((l) => l.startsWith("  seal     scripts/seal-bun-doors.ts"))).toBe(true);
    expect(linux.some((l) => l.startsWith("  beside "))).toBe(false);
    expect(linux).toContain("  run      dist/dev/clover-core daemon run");
    const mac = describeDevDaemonPlan(plan(["--dry-run", "--transition"], "darwin"));
    expect(mac.some((l) => l.startsWith(`  sign     codesign as ${DEV_DAEMON_IDENTIFIER}`))).toBe(true);
    expect(mac).toContain("  then     the one-time dev Keychain transition, and exit");
    expect(mac.some((l) => l.startsWith("  beside   dist/dev/clover-process-holder, signed under its own .dev identifier"))).toBe(true);
    expect(describeDevDaemonPlan(plan(["--dry-run", "--no-build"], "win32"))).toContain("  build    none (--no-build): dist/dev/clover-core.exe as it is");
  });
});

describe("the dev daemon's link sidecar", () => {
  test("built as the packages build it and staged beside the dev core, where the daemon looks for it; signed under its own .dev identifier on macOS", () => {
    const root = "/repo";
    const mac = devLinkSidecarPlan({ repoRoot: root, binary: "/repo/dist/dev/clover-core", platform: "darwin", linkBuild: LINK_BUILD, linkOutput: LINK_OUTPUT });
    expect(mac.build).toEqual([...LINK_BUILD]);
    expect(mac.from).toBe("/repo/native/link/target/release/clover-link");
    // Exactly where the daemon's own lookup finds it.
    expect(mac.to).toBe(bundledLinkBinary("/repo/dist/dev/clover-core", "darwin", (p) => p));
    expect(mac.sign).toBe(true);
    expect(DEV_LINK_IDENTIFIER).not.toBe(DEV_DAEMON_IDENTIFIER);
    expect(DEV_LINK_IDENTIFIER.endsWith(".dev")).toBe(true);
    const win = devLinkSidecarPlan({ repoRoot: root, binary: "/repo/dist/dev/clover-core.exe", platform: "win32", linkBuild: LINK_BUILD, linkOutput: LINK_OUTPUT });
    expect(win.to.endsWith("clover-link.exe")).toBe(true);
    expect(win.from.endsWith("clover-link.exe")).toBe(true);
    expect(win.sign).toBe(false);
  });
});
