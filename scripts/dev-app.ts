// The DEV app: apps/desktop run unpackaged under Electron as "Clover Dev" (`com.waifucave.clover.dev`, its own
// user-data folder), on the dev profile's home, `~/.clover-dev` — the home the dev daemon (scripts/dev-daemon.ts)
// runs on. macOS, Linux and Windows alike.
//
//   bun run dev:app                    build apps/desktop, then run it
//   bun run dev:app --no-build         run the last build as it is
//   bun run dev:app --dry-run [...]    print what the other flags would do, and stop: nothing built or opened
//   bun run dev:app -- <electron args> pass the rest to Electron after the app's folder
//
// It sets both CLOVER_HOME and CLOVER_PROFILE=dev, since the two are independent; the dist home and every other
// install's are refused (`devDaemonHome`). It opens a window: run it on your own screen, never from an agent on a
// screen someone else is using (plan §8).
//
// macOS: the daemon takes an `app` hello only from a process signed as the profile's Clover app (the caller check's
// peer-image check, packages/core/src/platform/peer-signature.ts), and Electron from npm is signed ad hoc. So the dev
// app runs a COPY, `dist/dev/app/Clover Dev.app`: Electron.app with the bundle identifier com.waifucave.clover.dev,
// every nested framework and helper and then the app signed with the dev identity (the one dev:daemon uses: Clover's
// team, `CLOVER_DEV_SIGN_IDENTITY` to choose another), checked against the daemon's requirement. It is made again when
// Electron's version or the identity changes.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appRequirement, CLOVER_APP_IDENTIFIER, CLOVER_TEAM_ID } from "../packages/core/src/bundled-identities";
import { devDaemonHome, devOs, resolveDevSigningIdentity, type DevOs } from "./dev-daemon-lib";
import { codesignDevArgs } from "./release/lib";

export interface DevAppPlan {
  os: DevOs;
  home: string;
  /** `bun run build` in apps/desktop, unless `--no-build`. */
  build: boolean;
  /** What Electron is given: the app's folder (relative to the repo root), then the pass-through. */
  args: string[];
  env: { CLOVER_HOME: string; CLOVER_PROFILE: "dev" };
  dryRun: boolean;
}

const DEV_APP_FLAGS: readonly string[] = ["--no-build", "--dry-run"];

export function devAppPlan(input: { argv: readonly string[]; env: NodeJS.ProcessEnv; platform: NodeJS.Platform; userHome?: string }): DevAppPlan {
  const flags = new Set<string>();
  let i = 0;
  for (; i < input.argv.length && DEV_APP_FLAGS.includes(input.argv[i]!); i++) flags.add(input.argv[i]!);
  if (input.argv[i] === "--") i++;
  const passthrough = input.argv.slice(i);
  const home = devDaemonHome(input.env, input.userHome);
  return {
    os: devOs(input.platform),
    home,
    build: !flags.has("--no-build"),
    args: ["apps/desktop", ...passthrough],
    env: { CLOVER_HOME: home, CLOVER_PROFILE: "dev" },
    dryRun: flags.has("--dry-run"),
  };
}

export function describeDevAppPlan(plan: DevAppPlan, electron: string): string[] {
  return [
    `dev:app: the plan on ${plan.os} (dry run: nothing is built or opened)`,
    `  home     ${plan.home}`,
    `  build    ${plan.build ? "(in apps/desktop) bun run build" : "none (--no-build): apps/desktop/out as it is"}`,
    ...(plan.os === "macos" ? [`  sign     ${DEV_APP_BUNDLE} (a copy of Electron.app as ${CLOVER_APP_IDENTIFIER.dev}, signed with the dev identity of team ${CLOVER_TEAM_ID}), unless it is already`] : []),
    `  run      ${plan.os === "macos" ? join(DEV_APP_BUNDLE, DEV_APP_EXECUTABLE) : electron} ${plan.args.join(" ")}`,
    `  as       Clover Dev (com.waifucave.clover.dev), CLOVER_HOME=${plan.env.CLOVER_HOME} CLOVER_PROFILE=${plan.env.CLOVER_PROFILE}`,
  ];
}

/** macOS: the dev app's signed copy of Electron.app (relative to the repo root), and its executable inside it. */
export const DEV_APP_BUNDLE = join("dist", "dev", "app", "Clover Dev.app");
export const DEV_APP_EXECUTABLE = join("Contents", "MacOS", "Electron");
/** What the copy was made from, beside it (never inside the bundle, which the signature seals). */
export const DEV_APP_STAMP = join("dist", "dev", "app", "signed.json");

export interface DevAppSignInput {
  /** Electron.app from the electron package. */
  source: string;
  /** Where the signed copy goes (`DEV_APP_BUNDLE` under the repo root). */
  target: string;
  /** The names in Electron.app's `Contents/Frameworks` (its frameworks and helper apps). */
  nested: readonly string[];
  identityHash: string;
  teamId: string;
  entitlements: string;
  keychain?: string;
}

/**
 * The commands that make the dev app's signed copy, in order: copy Electron.app, give it the dev app's identifier and
 * name, sign each nested framework and helper app (helpers with the app's entitlements, as a release does), then the
 * app itself as `com.waifucave.clover.dev` with the team's designated requirement, and check the result against the
 * daemon's own requirement for the dev app.
 */
export function devAppSignSteps(input: DevAppSignInput): string[][] {
  const plist = join(input.target, "Contents", "Info.plist");
  const keychain = input.keychain === undefined ? [] : ["--keychain", input.keychain];
  const nested = [...input.nested].filter((n) => n.endsWith(".framework") || n.endsWith(".app"))
    .sort((a, b) => Number(a.endsWith(".app")) - Number(b.endsWith(".app")) || a.localeCompare(b));
  return [
    ["rm", "-rf", input.target],
    ["mkdir", "-p", dirname(input.target)],
    ["ditto", input.source, input.target],
    ["plutil", "-replace", "CFBundleIdentifier", "-string", CLOVER_APP_IDENTIFIER.dev, plist],
    ["plutil", "-replace", "CFBundleName", "-string", "Clover Dev", plist],
    ["plutil", "-replace", "CFBundleDisplayName", "-string", "Clover Dev", plist],
    ...nested.map((n) => ["codesign", "--force", "--deep", "--sign", input.identityHash, "--options", "runtime", "--timestamp=none",
      ...(n.endsWith(".app") ? ["--entitlements", input.entitlements] : []), ...keychain, join(input.target, "Contents", "Frameworks", n)]),
    codesignDevArgs(input.target, input.identityHash, CLOVER_APP_IDENTIFIER.dev, input.teamId, input.entitlements, input.keychain),
    ["codesign", "--verify", "--deep", "--strict", `-R=${appRequirement("dev", input.teamId)}`, input.target],
  ];
}

/** Whether the signed copy must be made again: none yet, or made from another Electron or with another identity. */
export function devAppStale(stamp: string | null, want: { electron: string; identity: string }): boolean {
  if (stamp === null) return true;
  try {
    const got = JSON.parse(stamp) as { electron?: unknown; identity?: unknown };
    return got.electron !== want.electron || got.identity !== want.identity;
  } catch { return true; }
}

/** Electron's own install step fetches its binary (`install.js`, a postinstall); bun doesn't run postinstalls of
 *  dependencies it isn't told to trust, so after `bun install` the package is there with no binary. True when the
 *  binary is missing (no `path.txt` beside the package's index), so the caller runs `install.js` once. */
export function electronBinaryMissing(electronPackageDir: string): boolean {
  return !existsSync(join(electronPackageDir, "path.txt"));
}

/** Fetches Electron's binary when the install left it out (the one place that does; `bun install` stays offline of it). */
function ensureElectron(appDir: string): void {
  const dir = dirname(createRequire(join(appDir, "package.json")).resolve("electron/package.json"));
  if (!electronBinaryMissing(dir)) return;
  console.log("dev:app: Electron's binary isn't installed (bun skips its postinstall); fetching it once");
  const r = spawnSync("node", [join(dir, "install.js")], { cwd: dir, stdio: "inherit" });
  if (r.status !== 0) die(`fetching Electron's binary failed (exit ${r.status ?? r.signal}); run node ${join(dir, "install.js")} to see why`);
}

function die(message: string): never {
  console.error(`dev:app: ${message}`);
  process.exit(1);
}

/** macOS: the signed copy of Electron.app the dev app runs as (see the head of this file); its executable. */
function devSignedElectron(root: string, electron: string): string {
  const source = dirname(dirname(dirname(electron)));
  if (!source.endsWith("Electron.app")) die(`Electron's binary isn't inside an Electron.app (${electron})`);
  const target = join(root, DEV_APP_BUNDLE);
  const stampPath = join(root, DEV_APP_STAMP);
  const run = (args: string[], input?: string) => spawnSync(args[0]!, args.slice(1), { encoding: "utf8", ...(input !== undefined ? { input } : {}) });
  const identity = resolveDevSigningIdentity({
    identitiesOutput: run(["security", "find-identity", "-v", "-p", "codesigning"]).stdout ?? "",
    teamId: CLOVER_TEAM_ID,
    override: process.env.CLOVER_DEV_SIGN_IDENTITY,
    subjectOf: (name) => {
      const pem = run(["security", "find-certificate", "-c", name, "-p"]).stdout ?? "";
      if (pem === "") return undefined;
      const r = run(["openssl", "x509", "-noout", "-subject"], pem);
      return r.status === 0 ? r.stdout : undefined;
    },
  });
  const version = (JSON.parse(readFileSync(join(dirname(dirname(source)), "package.json"), "utf8")) as { version: string }).version;
  const want = { electron: version, identity: identity.hash };
  const stamp = existsSync(stampPath) ? readFileSync(stampPath, "utf8") : null;
  const executable = join(target, DEV_APP_EXECUTABLE);
  if (!devAppStale(stamp, want) && existsSync(executable)
    && run(["codesign", "--verify", "--strict", `-R=${appRequirement("dev")}`, target]).status === 0) return executable;
  console.log(`dev:app: signing ${DEV_APP_BUNDLE} (Electron ${version}) with ${identity.name}`);
  const steps = devAppSignSteps({
    source, target, nested: readdirSync(join(source, "Contents", "Frameworks")), identityHash: identity.hash, teamId: CLOVER_TEAM_ID,
    entitlements: join(root, "packaging", "macos", "entitlements.mac.plist"),
    ...(process.env.CLOVER_MAC_DEV_KEYCHAIN ? { keychain: process.env.CLOVER_MAC_DEV_KEYCHAIN } : {}),
  });
  for (const step of steps) {
    const r = run(step);
    if (r.status !== 0) die(`${step[0]} failed (exit ${r.status ?? r.signal}): ${(r.stderr ?? "").trim().slice(0, 400)}`);
  }
  writeFileSync(stampPath, `${JSON.stringify(want)}\n`);
  return executable;
}

function main(): void {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const appDir = join(root, "apps", "desktop");
  let plan: DevAppPlan;
  try {
    plan = devAppPlan({ argv: process.argv.slice(2), env: process.env, platform: process.platform });
  } catch (err) {
    die((err as Error).message);
  }
  if (plan.dryRun) {
    // Not resolved here: the first `require("electron")` downloads its binary when the install has not.
    for (const line of describeDevAppPlan(plan, "electron")) console.log(line);
    process.exit(0);
  }
  // `electron`'s main export is the path of its binary (downloaded on first use when the install did not).
  let electron: string;
  try {
    ensureElectron(appDir);
    electron = createRequire(join(appDir, "package.json"))("electron") as string;
  } catch (err) {
    die(`Electron is not installed (bun install at the repo root): ${(err as Error).message}`);
  }
  if (plan.build) {
    const built = spawnSync("bun", ["run", "build"], { cwd: appDir, stdio: "inherit", shell: process.platform === "win32" });
    if (built.status !== 0) die(`the build failed (exit ${built.status ?? built.signal})`);
  }
  if (!existsSync(join(appDir, "out", "main", "index.js"))) die("apps/desktop/out/main/index.js does not exist — run without --no-build");
  const env: NodeJS.ProcessEnv = { ...process.env, ...plan.env };
  delete env.CLOVER_KEYCHAIN_SERVICE;
  delete env.ELECTRON_RUN_AS_NODE;
  // macOS: the dev-signed copy, which the daemon's app check takes (the plain npm Electron is refused).
  const binary = plan.os === "macos" ? devSignedElectron(root, electron) : electron;
  const child = spawn(binary, plan.args, { cwd: root, stdio: "inherit", env });
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { try { child.kill(sig); } catch { /* gone */ } });
  child.on("close", (code, signal) => process.exit(code ?? (signal !== null ? 1 : 0)));
}

if (import.meta.main) main();
