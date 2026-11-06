// Which CI jobs a change needs (ci.yml's `changes` job). Each area lists the paths its jobs read; a change to CI itself,
// the toolchain, the root manifest or a lockfile runs every area but the Swift kits, which a change to CI itself runs. The names-and-layout checks and the gate run always.
//
//   bun scripts/ci-changes.ts --base <rev>   the files changed between <rev> and HEAD decide (a pull request's base,
//                                            or the main a merge-queue group was built on)
//   bun scripts/ci-changes.ts --all          every area (a push to main, a manual run)
//
// Prints `<area>=true|false` per area, and appends the same lines to $GITHUB_OUTPUT when it is set.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

export type CiArea =
  | "workspaces" | "daemon" | "app" | "packages" | "installers" | "gallery" | "typecheck" | "lockfiles"
  | "extension" | "core" | "cli" | "scripts" | "codegen" | "swift" | "verify" | "tree" | "link";

/** A path pattern: `dir/` is a prefix, a `*` matches within one segment, `**` across segments, else an exact path. */
type Pattern = string;

/** Changes to any of these run every area: CI itself, the toolchain, the root manifest and the lockfiles. */
export const CI_GLOBAL: readonly Pattern[] = [
  ".github/workflows/ci.yml", "scripts/ci-changes.ts", ".bun-version", "package.json", "bun.lock", "pnpm-lock.yaml",
  "pnpm-workspace.yaml", "tsconfig.base.json", "bunfig.toml",
];

// The update feed's check is in the daemon's binary (packages/cli's `__verify-feed`) and, after E-M1, the app's updater.
const CORE: readonly Pattern[] = ["packages/core/", "packages/protocol/", "packages/plugin-sdk/", "packages/update-feed/"];

/** What each area's jobs read. */
export const CI_AREAS: Readonly<Record<CiArea, readonly Pattern[]>> = {
  // every workspace package's own tests, on all four machines
  workspaces: ["packages/", "apps/", "plugins/", "services/", "native/", "examples/", "spikes/", "scripts/workspaces.ts", "scripts/with-private-secret-service.sh"],
  daemon: [...CORE, "packages/cli/", "scripts/build-daemon.ts"],
  // the app, and what it loads: Clover's own plugins and the plugin SDK's UI API (E-M1)
  app: ["apps/", "plugins/clover/", "packages/plugin-sdk/"],
  // the Linux packages: the app, its builder config, packaging/, the scripts that build them, and the daemon and the
  // link sidecar they carry (the job installs the deb and runs its `clover`)
  packages: ["apps/desktop/", "packaging/", "scripts/build-packages.ts", "scripts/build-daemon.ts", "scripts/release/", ...CORE, "packages/cli/", "native/link/"],
  // the macOS and Windows installers (the unsigned release build: dmg, zip, NSIS), on macOS and Windows machines: only
  // what makes them, so a code change alone doesn't spend a macOS job on them (the app and daemon jobs build those)
  installers: ["apps/desktop/electron-builder.yml", "apps/desktop/package.json", "packaging/", "scripts/release/", "scripts/build-daemon.ts"],
  gallery: ["plugins/"],
  typecheck: ["packages/", "apps/", "plugins/", "services/", "examples/", "scripts/", "**/tsconfig*.json"],
  lockfiles: ["**/package.json"],
  extension: ["extensions/"],
  // lane A's model plugins: the core's catalog and generator check reads them; the core's account tests import the
  // services' shared account-token check and the harness's sign-in stub
  core: [...CORE, "plugins/clover/plugins/model-*/**/*", "services/shared/", "packages/test-harness/src/signin-stub.ts"],
  cli: [...CORE, "packages/cli/"],
  // the repo scripts' tests read the core, the CLI, the app, the release inputs and the workflows
  scripts: ["scripts/", "packages/core/", "packages/cli/", "apps/", "apple/", "packaging/", "VERSION", "VERSIONS.json", ".github/"],
  codegen: ["packages/protocol/", "apple/WinterProtocol/"],
  // the predecessor's Swift kits, on a macOS runner: their own tree and the protocol's generated fixtures their round
  // trips read, and nothing else (SWIFT_GLOBAL). WinterKit's tests also start the core's daemon through bun
  // (apple/WinterKit/Tests/WinterKitTests/support/RealDaemon.swift), but a core, Bun or lockfile change no longer runs
  // them in a pull request or a merge group: macOS runners are the queue's bottleneck, and a push to main still runs
  // every area, so such a break shows on main's own run.
  swift: ["apple/", "Package.swift", "packages/protocol/generated/"],
  verify: [...CORE, "packages/cli/", "scripts/verify-", "scripts/stage-runtimes.ts", "scripts/fetch-ant.ts", "scripts/build-winter.ts", "VERSIONS.json"],
  // the tree and the computers on Linux and Windows (macOS runs them in the core suite): their code, their tests and
  // lane B's conformance suites for them
  tree: ["packages/core/src/computers/", "packages/core/src/tree/", "packages/core/test/computers/", "packages/core/test/tree/",
    "packages/core/src/contracts/tests/tree.test.ts", "packages/core/src/contracts/tests/computer-registry.test.ts"],
  // the link sidecar (clover-link) built on every OS, and the core's link tests over it: the sidecar, the links, and
  // what they import (the devices and identity the handshake and pairing use, the contracts, the clock, the protocol)
  link: ["native/link/", "packages/core/src/links/", "packages/core/src/devices/", "packages/core/src/identity/",
    "packages/core/src/contracts/", "packages/core/src/clock/", "packages/protocol/"],
};

/** The CI_GLOBAL changes that still run the Swift kits: CI's own definition, not the toolchain or the lockfiles. */
export const SWIFT_GLOBAL: readonly Pattern[] = [".github/workflows/ci.yml", "scripts/ci-changes.ts"];

export const CI_AREA_NAMES = Object.keys(CI_AREAS) as CiArea[];

function globToRegex(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") {
      re += "(?:.*/)?";
      i += glob[i + 2] === "/" ? 2 : 1;
    } else if (c === "*") re += "[^/]*";
    else re += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

export function matches(path: string, pattern: Pattern): boolean {
  if (pattern.includes("*")) return globToRegex(pattern).test(path);
  if (pattern.endsWith("/")) return path.startsWith(pattern);
  // `scripts/verify-` style: a file-name prefix within one folder
  if (pattern.endsWith("-")) return path.startsWith(pattern) && !path.slice(pattern.length).includes("/");
  return path === pattern;
}

/** Areas CI_GLOBAL turns on only through these of its files: the Swift kits through CI's own definition, and the
 *  installers' release build (a macOS and a Windows machine for a quarter of an hour) through none, so a change keeps
 *  to three macOS jobs. A push to main still runs every area. */
export const NARROW_GLOBAL: Readonly<Partial<Record<CiArea, readonly Pattern[]>>> = { swift: SWIFT_GLOBAL, installers: [] };

/** The areas `changed` needs. `undefined` (no diff to go on) runs every area. */
export function areasFor(changed: readonly string[] | undefined): Record<CiArea, boolean> {
  if (changed === undefined) return Object.fromEntries(CI_AREA_NAMES.map((a) => [a, true])) as Record<CiArea, boolean>;
  const touches = (patterns: readonly Pattern[]): boolean => changed.some((p) => patterns.some((g) => matches(p, g)));
  const all = touches(CI_GLOBAL);
  return Object.fromEntries(CI_AREA_NAMES.map((a) => {
    const narrow = NARROW_GLOBAL[a];
    return [a, (narrow === undefined ? all : touches(narrow)) || touches(CI_AREAS[a])];
  })) as Record<CiArea, boolean>;
}

function changedSince(base: string): string[] | undefined {
  try {
    return execFileSync("git", ["diff", "--name-only", base, "HEAD"], { encoding: "utf8" }).split("\n").filter(Boolean);
  } catch {
    return undefined; // no such revision here: run everything rather than guess
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--base");
  const changed = argv.includes("--all") || i === -1 ? undefined : changedSince(argv[i + 1] ?? "");
  const areas = areasFor(changed);
  const lines = CI_AREA_NAMES.map((a) => `${a}=${areas[a]}`);
  console.log(changed === undefined ? "ci-changes: every area" : `ci-changes: ${changed.length} file(s) changed`);
  for (const l of lines) console.log(l);
  const out = process.env.GITHUB_OUTPUT;
  if (out !== undefined && out !== "") appendFileSync(out, `${lines.join("\n")}\n`);
}
