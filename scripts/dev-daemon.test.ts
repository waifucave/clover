import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OTHER_INSTALL_HOMES } from "../packages/core/src/other-installs";
import { designatedRequirementOf, DEV_DAEMON_IDENTIFIER, devCompileCommand, devDaemonHome, devDaemonRequirement, resolveDevSigningIdentity, signedFacts } from "./dev-daemon-lib";

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
