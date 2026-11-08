// WS-27: the pure halves of `scripts/dev-daemon.ts` (unit-tested in `dev-daemon.test.ts`).
import { homedir } from "node:os";
import { PLUGIN_BUN_FILE, PLUGIN_BUN_IDENTIFIER } from "../packages/core/src/bundled-identities";
import { dirname, join, resolve, sep } from "node:path";
import { otherInstallHome, realPathOf } from "../packages/core/src/other-installs";

export type DevOs = "macos" | "linux" | "windows";

export function devOs(platform: NodeJS.Platform = process.platform): DevOs {
  return platform === "darwin" ? "macos" : platform === "win32" ? "windows" : "linux";
}

/** This script's own leading flags; everything from the first other argument (or after a `--`) goes to the binary. */
export type DevDaemonFlag = "--no-build" | "--transition" | "--cli" | "--dry-run";
const DEV_DAEMON_FLAGS: readonly string[] = ["--no-build", "--transition", "--cli", "--dry-run"];

export interface DevDaemonPlan {
  os: DevOs;
  /** The dev home (`devDaemonHome`). */
  home: string;
  /** The dev binary, relative to the repo root, with `/`. */
  binary: string;
  /** The build, or undefined with `--no-build`: `compile:core` redirected to `tmp` (relative to `packages/cli`),
   *  then, on macOS only, signed (the Keychain's partition lists need Clover's team; Linux and Windows have none). */
  build: { command: string; tmp: string; sign: boolean } | undefined;
  /** `--transition`: the one-time Keychain hand-over, macOS only. */
  transition: boolean;
  /** What the binary runs: `daemon run` unless told otherwise. */
  args: string[];
  /** Set for the binary on top of the caller's environment (the runtime executables are resolved at run time). */
  env: { CLOVER_HOME: string; CLOVER_PROFILE: "dev" };
  dryRun: boolean;
}

/**
 * What `bun run dev:daemon <argv>` will do, decided before anything is built, signed or started (`--dry-run`
 * prints it and stops). Throws on a refused home or a flag this OS cannot honor.
 */
export function devDaemonPlan(input: { argv: readonly string[]; env: NodeJS.ProcessEnv; platform: NodeJS.Platform; userHome?: string; compileCoreScript: string; pid: number }): DevDaemonPlan {
  const flags = new Set<DevDaemonFlag>();
  let i = 0;
  for (; i < input.argv.length && DEV_DAEMON_FLAGS.includes(input.argv[i]!); i++) flags.add(input.argv[i] as DevDaemonFlag);
  if (input.argv[i] === "--") i++;
  const passthrough = input.argv.slice(i);
  const os = devOs(input.platform);
  if (flags.has("--transition") && passthrough.length > 0) throw new Error("--transition takes no other arguments");
  if (flags.has("--transition") && os !== "macos") throw new Error("--transition is macOS-only: it moves the dev Keychain items from bun to the signed binary, and on Linux and Windows the dev binary is not signed, so its items are already its own");
  const home = devDaemonHome(input.env, input.userHome);
  const binary = os === "windows" ? "dist/dev/clover-core.exe" : "dist/dev/clover-core";
  // The temp output sits beside the binary, so the rename into place is atomic; on Windows it keeps the .exe.
  const tmp = os === "windows" ? `../../dist/dev/clover-core.${input.pid}.tmp.exe` : `../../dist/dev/clover-core.${input.pid}.tmp`;
  return {
    os,
    home,
    binary,
    build: flags.has("--no-build") ? undefined : { command: devCompileCommand(input.compileCoreScript, tmp), tmp, sign: os === "macos" },
    transition: flags.has("--transition"),
    args: passthrough.length > 0 || flags.has("--cli") ? passthrough : ["daemon", "run"],
    env: { CLOVER_HOME: home, CLOVER_PROFILE: "dev" },
    dryRun: flags.has("--dry-run"),
  };
}

/** `--dry-run`'s report. */
export function describeDevDaemonPlan(plan: DevDaemonPlan): string[] {
  const lines = [`dev:daemon: the plan on ${plan.os} (dry run: nothing is built, signed or started)`, `  home     ${plan.home}`];
  if (plan.build === undefined) lines.push(`  build    none (--no-build): ${plan.binary} as it is`);
  else {
    lines.push(`  build    (in packages/cli) ${plan.build.command}`);
    lines.push(`  seal     scripts/seal-bun-doors.ts: Bun's BUN_BE_BUN, BUN_OPTIONS, BUN_INSPECT*, BUN_CONFIG_VERBOSE_FETCH and NODE_PATH doors closed (not on Windows), then the byte check`);
    if (plan.os === "macos") lines.push(`  beside   ${dirname(plan.binary)}/clover-process-holder, signed under its own .dev identifier (scripts/bundled-binaries.ts); plugin Bun's dev copy goes in the dev home's bin/, where pluginBun() checks it`);
    lines.push(plan.build.sign
      ? `  sign     codesign as ${DEV_DAEMON_IDENTIFIER} with Clover's team, then the __keychain-ffi-probe, then rename to ${plan.binary}`
      : `  sign     none (the dev binary is unsigned on ${plan.os}); rename to ${plan.binary}`);
  }
  if (plan.transition) lines.push(`  then     the one-time dev Keychain transition, and exit`);
  else lines.push(`  run      ${plan.binary} ${plan.args.join(" ")}`.trimEnd());
  lines.push(`  env      CLOVER_HOME=${plan.env.CLOVER_HOME} CLOVER_PROFILE=${plan.env.CLOVER_PROFILE}, and CLOVER_RUNTIME_EXECUTABLE / CLOVER_ANT_EXECUTABLE when found`);
  return lines;
}

/** The dev daemon's code-signing identifier: stable, so its designated requirement (identifier + Clover's
 *  team certificate) survives every rebuild and the Keychain keeps trusting it. Distinct from the dist
 *  binary's (`clover-core`), which is signed in the app bundle. */
export const DEV_DAEMON_IDENTIFIER = "com.waifucave.clover.core.dev";

/**
 * The dev daemon's designated requirement, stated rather than derived: its identifier and Clover's team
 * (the certificate's OU), under Apple's anchor. The derived one would name the signing certificate's common
 * name, which changes with the person or the certificate type; this one holds for any Clover-team
 * certificate, so the Keychain keeps trusting every rebuild whoever signs it.
 */
export function devDaemonRequirement(teamId: string): string {
  return `identifier "${DEV_DAEMON_IDENTIFIER}" and anchor apple generic and certificate leaf[subject.OU] = "${teamId}"`;
}

/** The dev plugin Bun's signing identifier (#234's check 5, lane M's layout): never the core's, so no Keychain item's
 *  access list (which names the core alone) lets plugin code in. */
export const DEV_PLUGIN_BUN_IDENTIFIER = PLUGIN_BUN_IDENTIFIER.dev;

/** Where the dev daemon's plugin Bun goes (#234's check 6, L2): `<dev Clover home>/bin/clover-plugin-bun[.exe]`, inside
 *  the home no runner writes, where `pluginBun()` looks for it in the dev profile. */
export function devPluginBunPath(devHome: string, platform: NodeJS.Platform = process.platform): string {
  return join(devHome, "bin", platform === "win32" ? `${PLUGIN_BUN_FILE}.exe` : PLUGIN_BUN_FILE);
}

/** The ad-hoc signature the dev plugin Bun gets on macOS: its own identifier, the hardened runtime and the release
 *  copy's entitlements (`scripts/clover-plugin-bun.entitlements`, bundled-binaries.ts's `PLUGIN_BUN_ENTITLEMENTS`). */
export function devPluginBunSignArgs(path: string, entitlements: string): string[] {
  return ["--force", "--sign", "-", "--identifier", DEV_PLUGIN_BUN_IDENTIFIER, "--options", "runtime", "--timestamp=none", "--entitlements", entitlements, path];
}

/** Whether the dev plugin Bun must be made again: it's missing, it was made from a Bun other than `sourceHash`'s (the
 *  stamp beside it records the source's SHA-256), or it isn't the copy whose digest was recorded (swapped). */
export function devPluginBunStale(o: { exists: boolean; stamp: string | undefined; sourceHash: string; recordedDigest?: string; actualDigest?: string }): boolean {
  return !o.exists || o.stamp?.trim() !== o.sourceHash || o.recordedDigest === undefined || o.recordedDigest.trim() !== o.actualDigest;
}

/** `compile:core`'s own output, which the `verify:*` gates overwrite — the dev daemon is never built there. */
const COMPILE_CORE_OUTFILE = "--outfile ../../dist/clover-core";

/**
 * `packages/cli/package.json`'s `compile:core` script with only its output path changed, so the dev daemon is
 * the same two-entrypoint build (`cli/test/compile-core.test.ts` pins its shape) and cannot drift from it.
 * Throws when the script no longer names the expected output (a change to update here, not to guess around).
 */
export function devCompileCommand(compileCoreScript: string, outfile: string): string {
  if (!compileCoreScript.includes(COMPILE_CORE_OUTFILE)) throw new Error(`compile:core no longer writes ${COMPILE_CORE_OUTFILE} — update scripts/dev-daemon-lib.ts`);
  return compileCoreScript.replace(COMPILE_CORE_OUTFILE, `--outfile ${JSON.stringify(outfile)}`);
}

export interface SigningIdentity {
  hash: string;
  name: string;
}

/**
 * The identity to sign the dev daemon with: one whose certificate's ORGANIZATIONAL UNIT is `teamId` (an
 * "Apple Development" certificate names the person in its common name, not the team, so the name alone
 * cannot say), preferring "Apple Development" (a development build) over "Developer ID Application".
 * Returned by its SHA-1 hash, never a name, so two same-named certificates cannot make `codesign` guess.
 * `subjectOf(name)` answers a certificate's subject line (`security find-certificate -c <name> -p |
 * openssl x509 -noout -subject`); injected so this stays pure. `override` (`$CLOVER_DEV_SIGN_IDENTITY`) wins.
 */
export function resolveDevSigningIdentity(input: { identitiesOutput: string; teamId: string; subjectOf: (name: string) => string | undefined; override?: string }): SigningIdentity {
  if (input.override !== undefined && input.override.trim() !== "") return { hash: input.override.trim(), name: "(CLOVER_DEV_SIGN_IDENTITY)" };
  const candidates: SigningIdentity[] = [];
  for (const line of input.identitiesOutput.split("\n")) {
    const m = /\b([0-9A-Fa-f]{40})\s+"([^"]+)"/.exec(line);
    if (m === null) continue;
    const [, hash, name] = m as unknown as [string, string, string];
    const subject = input.subjectOf(name) ?? "";
    if (new RegExp(`(^|[,/\\s])OU\\s*=\\s*${input.teamId}([,/\\s]|$)`).test(subject)) candidates.push({ hash, name });
  }
  const rank = (name: string): number => (name.startsWith("Apple Development:") ? 0 : name.startsWith("Developer ID Application:") ? 1 : 2);
  candidates.sort((a, b) => rank(a.name) - rank(b.name));
  const chosen = candidates[0];
  if (chosen === undefined) throw new Error(`no code-signing identity for team ${input.teamId} in this keychain (security find-identity -v -p codesigning) — create one in Xcode, or set CLOVER_DEV_SIGN_IDENTITY`);
  return chosen;
}

/**
 * The dev daemon's home: `$CLOVER_HOME`, else `~/.clover-dev`. Refused by real path (links followed): Clover's dist
 * home `~/.clover`, and every other install's home (`other-installs.ts` names them), or anything inside one.
 */
export function devDaemonHome(env: NodeJS.ProcessEnv, home: string = homedir()): string {
  const chosen = resolve(env.CLOVER_HOME ?? join(home, ".clover-dev"));
  const real = realPathOf(chosen);
  const dist = realPathOf(join(home, ".clover"));
  if (real === dist || real.startsWith(dist + sep)) throw new Error(`refusing to run a dev daemon on ${chosen} — that is Clover's dist home, not the dev profile's`);
  const other = otherInstallHome(chosen, home);
  if (other !== undefined) throw new Error(`refusing to run a dev daemon on ${chosen} — that is ${other.what}, which Clover never touches`);
  return chosen;
}

/** `codesign -dv` facts the build checks after signing. */
export function designatedRequirementOf(codesignDr: string): string | undefined {
  return /^designated => (.+)$/m.exec(codesignDr)?.[1]?.trim();
}

export function signedFacts(codesignDv: string): { identifier?: string; teamId?: string; runtime: boolean } {
  const identifier = /^Identifier=(.+)$/m.exec(codesignDv)?.[1]?.trim();
  const teamId = /^TeamIdentifier=(.+)$/m.exec(codesignDv)?.[1]?.trim();
  const flags = /^CodeDirectory .*flags=0x[0-9a-f]+\(([^)]*)\)/m.exec(codesignDv)?.[1] ?? "";
  return { ...(identifier !== undefined ? { identifier } : {}), ...(teamId !== undefined && teamId !== "not set" ? { teamId } : {}), runtime: flags.split(",").includes("runtime") };
}
