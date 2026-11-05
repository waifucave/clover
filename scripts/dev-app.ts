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
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { devDaemonHome, devOs, type DevOs } from "./dev-daemon-lib";

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
    `  run      ${electron} ${plan.args.join(" ")}`,
    `  as       Clover Dev (com.waifucave.clover.dev), CLOVER_HOME=${plan.env.CLOVER_HOME} CLOVER_PROFILE=${plan.env.CLOVER_PROFILE}`,
  ];
}

function die(message: string): never {
  console.error(`dev:app: ${message}`);
  process.exit(1);
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
  const child = spawn(electron, plan.args, { cwd: root, stdio: "inherit", env });
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { try { child.kill(sig); } catch { /* gone */ } });
  child.on("close", (code, signal) => process.exit(code ?? (signal !== null ? 1 : 0)));
}

if (import.meta.main) main();
