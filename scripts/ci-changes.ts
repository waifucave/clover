// Which CI jobs a change needs (ci.yml's `changes` job). Each area lists the paths its jobs read; a change to CI itself
// runs every area, and one to the toolchain, the root manifest or a lockfile every area but the Swift kits'. The
// names-and-layout checks and the gate run always.
//
//   bun scripts/ci-changes.ts --base <rev>   the files changed between <rev> and HEAD decide
//   bun scripts/ci-changes.ts --all          every area (a push to main, a manual run)
//
// Prints `<area>=true|false` per area, and appends the same lines to $GITHUB_OUTPUT when it is set.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

export type CiArea =
  | "workspaces" | "daemon" | "app" | "gallery" | "typecheck" | "lockfiles"
  | "extension" | "core" | "cli" | "scripts" | "codegen" | "swift" | "verify";

/** A path pattern: `dir/` is a prefix, a `*` matches within one segment, `**` across segments, else an exact path. */
type Pattern = string;

/** Changes to any of these run every area: CI itself, the toolchain, the root manifest and the lockfiles. */
export const CI_GLOBAL: readonly Pattern[] = [
  ".github/workflows/ci.yml", "scripts/ci-changes.ts", ".bun-version", "package.json", "bun.lock", "pnpm-lock.yaml",
  "pnpm-workspace.yaml", "tsconfig.base.json", "bunfig.toml",
];

/** CI itself, the part of CI_GLOBAL that also runs the areas below; the JavaScript toolchain and lockfiles don't. */
export const CI_ITSELF: readonly Pattern[] = [".github/workflows/ci.yml", "scripts/ci-changes.ts"];

/** Areas no JavaScript toolchain or lockfile change can reach: the Swift kits build with SwiftPM alone. */
export const NOT_FROM_TOOLCHAIN: readonly CiArea[] = ["swift"];

const CORE: readonly Pattern[] = ["packages/core/", "packages/protocol/", "packages/plugin-sdk/"];

/** What each area's jobs read. */
export const CI_AREAS: Readonly<Record<CiArea, readonly Pattern[]>> = {
  // every workspace package's own tests, on all four machines
  workspaces: ["packages/", "apps/", "plugins/", "services/", "native/", "examples/", "spikes/", "scripts/workspaces.ts", "scripts/with-private-secret-service.sh"],
  daemon: [...CORE, "packages/cli/", "scripts/build-daemon.ts"],
  app: ["apps/"],
  gallery: ["plugins/"],
  typecheck: ["packages/", "apps/", "plugins/", "services/", "examples/", "scripts/", "**/tsconfig*.json"],
  lockfiles: ["**/package.json"],
  extension: ["extensions/"],
  core: CORE,
  cli: [...CORE, "packages/cli/"],
  // the repo scripts' tests read the core, the CLI, the app, the release inputs and the workflows
  scripts: ["scripts/", "packages/core/", "packages/cli/", "apps/", "apple/", "packaging/", "VERSION", "VERSIONS.json", ".github/"],
  codegen: ["packages/protocol/", "apple/WinterProtocol/"],
  // the Swift kits: only their own tree and the protocol's generated fixtures
  swift: ["apple/", "Package.swift", "packages/protocol/generated/"],
  verify: [...CORE, "packages/cli/", "scripts/verify-", "scripts/stage-runtimes.ts", "scripts/fetch-ant.ts", "scripts/build-winter.ts", "VERSIONS.json"],
};

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

/** The areas `changed` needs. `undefined` (no diff to go on) runs every area. */
export function areasFor(changed: readonly string[] | undefined): Record<CiArea, boolean> {
  const all = changed === undefined || changed.some((p) => CI_ITSELF.some((g) => matches(p, g)));
  const toolchain = changed !== undefined && changed.some((p) => CI_GLOBAL.some((g) => matches(p, g)));
  return Object.fromEntries(CI_AREA_NAMES.map((a) => [a,
    all || (toolchain && !NOT_FROM_TOOLCHAIN.includes(a)) || changed!.some((p) => CI_AREAS[a].some((g) => matches(p, g)))])) as Record<CiArea, boolean>;
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
