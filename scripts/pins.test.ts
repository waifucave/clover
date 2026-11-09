// Winter Phase 8d (P8d-16), P9a-8 — pin-consistency tripwire. `.github/workflows/ci.yml`'s
// retired `winter-binary` job used to hardcode `ref: v0.0.4` (the pinned-tag checkout) AND
// the uploaded artifact's name with the same version as two separate literals — and
// `packages/core/package.json`'s own SDK version ranges are a THIRD place the same pin could
// silently drift from `packages/core/src/runtime-sdk/versions.ts`'s `REQUIRED_*` constants (it
// happened once already, in 8c's spine). This test is the tripwire for both directions.
//
// P9a-8: the uploaded/downloaded ARTIFACT is gone (the `winter` binary comes from the installed npm platform
// package now) — that derivation test is DROPPED, never made conditional, since there is no
// artifact name left anywhere to derive. The pinned-tag checkout REF still appears, but only
// inside each job's dated FALLBACK block (test-core/test-cli/verify — P9a-8, removed at the
// 0.0.5 pin flip); that test's own comment is updated to say so, never widened or weakened.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REQUIRED_WINTER_AGENT_SDK, REQUIRED_WINTER_RUNTIME_SDK } from "../packages/core/src/runtime-sdk/versions";

const REPO_ROOT = join(import.meta.dir, "..");
const CI_YML = readFileSync(join(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8");
const CORE_PACKAGE_JSON = JSON.parse(readFileSync(join(REPO_ROOT, "packages", "core", "package.json"), "utf8")) as {
  dependencies?: Record<string, string>;
};
/** `bun.lock` is JSON with trailing commas allowed (a JSON5-lite dialect bun writes and reads,
 *  never plain JSON) — strip them before `}`/`]` so `JSON.parse` accepts it. No comments to worry
 *  about (measured: this repo's `bun.lock` carries none), so this narrow fixup is sufficient. */
function parseBunLock(text: string): { packages?: Record<string, [string, ...unknown[]]> } {
  return JSON.parse(text.replace(/,(\s*[}\]])/g, "$1"));
}
const BUN_LOCK = parseBunLock(readFileSync(join(REPO_ROOT, "bun.lock"), "utf8"));

/** Strips a leading `^`/`~` semver range operator — this repo's own convention for "the pin, as a
 *  range that installs" vs. "the pin, as the exact version the code is written against"
 *  (`versions.ts`'s own doc: "The ^ ranges in package.json are what INSTALLS; these are what the
 *  tests PROVE installed"). */
/** The version of a package core resolves through a `link:` (its own manifest, wherever the link points). */
function linkedVersion(name: string): string {
  const { createRequire } = require("node:module") as typeof import("node:module");
  const manifest = createRequire(join(import.meta.dir, "../packages/core/package.json")).resolve(`${name}/package.json`);
  return (JSON.parse(readFileSync(manifest, "utf8")) as { version: string }).version;
}

function bareVersion(range: string): string {
  return range.replace(/^[\^~]/, "");
}

/** `bun.lock`'s own `packages` entries are `"<name>": ["<name>@<version>", ...]` — the RESOLVED
 *  version bun actually installed, as opposed to package.json's own (possibly ranged) pin. The
 *  version always starts with a digit, which is what lets this regex not be fooled by the `@` in
 *  a scoped package name like `@waifucave/clover-agent-sdk@0.0.4`. */
function lockedVersion(name: string): string {
  const entry = BUN_LOCK.packages?.[name];
  if (entry === undefined) throw new Error(`pins.test: bun.lock has no "packages" entry for ${JSON.stringify(name)}`);
  const m = entry[0].match(/@(\d[^@]*)$/);
  if (!m) throw new Error(`pins.test: could not parse a version out of bun.lock entry ${JSON.stringify(entry[0])}`);
  return m[1]!;
}

describe("CI takes the `winter` binary from the installed platform package ONLY (P9a-8, since the 0.0.5 pin flip)", () => {
  test("no literal 'ref: v<digits>' checkout of clover-sdk, no FALLBACK block, no `versions` job remain", () => {
    expect(CI_YML).not.toMatch(/ref:\s*v\d+\.\d+\.\d+/);
    expect(CI_YML).not.toContain("FALLBACK");
    expect(CI_YML).not.toContain("needs.versions");
    expect(CI_YML).not.toMatch(/^  versions:$/m);
  });
  test("every job that needs the `winter` binary fails loudly when the platform package did not install (never a silent skip)", () => {
    const jobs = (Bun.YAML.parse(CI_YML) as { jobs: Record<string, { steps?: { run?: string }[] }> }).jobs;
    const LOUD = "did not install — bun install is the ONLY winter source since";
    // A job needs the binary when it copies it to dist/winter or runs the gate that stages it.
    const needing = Object.keys(jobs).filter((id) => ["dist/winter", "verify:runtimes"].some((s) => JSON.stringify(jobs[id]).includes(s))).sort();
    expect(needing).toEqual(["macos"]);
    for (const id of needing) expect([id, (jobs[id]!.steps ?? []).some((s) => s.run?.includes(LOUD) === true)]).toEqual([id, true]);
    expect((CI_YML.match(new RegExp(LOUD, "g")) ?? []).length).toBe(needing.length);
  });
});

describe("packages/core/package.json's SDK pins agree with versions.ts's REQUIRED_* (P8d-16)", () => {
  test("winter-agent-sdk", () => {
    const range = CORE_PACKAGE_JSON.dependencies?.["@waifucave/clover-agent-sdk"];
    expect(range).toBeDefined();
    // A-M1: until `@waifucave/clover-*` is published the SDK is a local link (`bun link` in a clover-sdk
    // checkout); the version the pin names is then the linked package's own.
    expect(range!.startsWith("link:") ? linkedVersion("@waifucave/clover-agent-sdk") : bareVersion(range!)).toBe(REQUIRED_WINTER_AGENT_SDK);
  });

  // A-M1 (spec §3.3): the router is archived, and what the daemon still needs of it lives in core
  // (`runtime-sdk/host/`). Its pin names the release that code came from; no package installs it.
  test("winter-runtime-sdk (the router) is no longer a daemon dependency", () => {
    expect(CORE_PACKAGE_JSON.dependencies?.["@yanlinglabs/winter-runtime-sdk"]).toBeUndefined();
    expect(BUN_LOCK.packages?.["@yanlinglabs/winter-runtime-sdk"]).toBeUndefined();
    expect(REQUIRED_WINTER_RUNTIME_SDK).toBe("0.0.16");
  });

  // WS-23: the official leg is retired — the daemon depends on no claude-agent-sdk at all.
  test("claude-agent-sdk is no longer a daemon dependency", () => {
    expect(CORE_PACKAGE_JSON.dependencies?.["@anthropic-ai/claude-agent-sdk"]).toBeUndefined();
  });
});

// P9a-8: the ladder's platform-package rung (`resolvePlatformPackageWinter`) and every
// stage-runtimes/release-lib version assertion key off `REQUIRED_WINTER_AGENT_SDK` matching
// WHATEVER `bun install` actually resolved for the wrapper — package.json's `^0.0.4` range is
// what INSTALLS, `bun.lock` is what actually got resolved, and a drift between the two (a `bun
// update` bumping the lockfile without this constant following) would make every "installed
// package version === REQUIRED_WINTER_AGENT_SDK" assertion in this codebase either falsely
// refuse a genuinely-fine install or, worse, silently accept a DIFFERENT version than the one the
// daemon is actually written against.
describe("REQUIRED_WINTER_AGENT_SDK matches the wrapper's ACTUALLY RESOLVED version in bun.lock (P9a-8)", () => {
  test("bun.lock's @waifucave/clover-agent-sdk resolves to exactly REQUIRED_WINTER_AGENT_SDK", () => {
    const entry = (BUN_LOCK.packages?.["@waifucave/clover-agent-sdk"] as unknown[] | undefined)?.[0];
    // A-M1: a `link:` entry carries no version; the linked package's own manifest does.
    expect(typeof entry === "string" && entry.includes("@link:") ? linkedVersion("@waifucave/clover-agent-sdk") : lockedVersion("@waifucave/clover-agent-sdk")).toBe(REQUIRED_WINTER_AGENT_SDK);
  });
});

// M1 review: every Bun pin follows `.bun-version`. A new workspace copied from an older one brings that one's
// `@types/bun`, and the types then describe a Bun CI does not run (1.4's `signalCode` type differs from 1.3.14's).
// Spikes are left out: each is frozen evidence with its own lockfile, measured on the Bun it names.
describe("the Bun pins follow .bun-version", () => {
  const PINNED_BUN = readFileSync(join(REPO_ROOT, ".bun-version"), "utf8").trim();
  const manifests = Bun.spawnSync(["git", "ls-files", "*package.json"], { cwd: REPO_ROOT }).stdout.toString().split("\n")
    .filter((f) => f.endsWith("package.json") && !f.startsWith("spikes/"));

  test(".bun-sha256 pins the binary of every asset scripts/pinned-bun can pick, for the pinned version", () => {
    const lines = readFileSync(join(REPO_ROOT, ".bun-sha256"), "utf8").split("\n").filter((l) => l.trim() !== "" && !l.startsWith("#"));
    const pinned = new Map(lines.map((l) => l.split(/\s+/)).filter((f) => f[0] === PINNED_BUN).map((f) => [f[1]!, f[2]!]));
    const assets = ["darwin-aarch64", "darwin-x64", "darwin-x64-baseline", "linux-aarch64", "linux-aarch64-musl", "linux-x64", "linux-x64-baseline", "linux-x64-musl", "linux-x64-musl-baseline"].map((a) => `bun-${a}`);
    for (const asset of assets) expect(pinned.get(asset)).toMatch(/^[0-9a-f]{64}$/);
    // Every line is `<version> <asset> <sha256>`.
    for (const l of lines) expect(l).toMatch(/^\d+\.\d+\.\d+ bun-[a-z0-9-]+ [0-9a-f]{64}$/);
  });

  test("every tracked package.json's @types/bun is exactly the pinned version", () => {
    expect(manifests.length).toBeGreaterThan(10);
    const drift: string[] = [];
    for (const file of manifests) {
      const pkg = JSON.parse(readFileSync(join(REPO_ROOT, file), "utf8")) as Record<string, Record<string, string> | undefined>;
      for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
        const v = pkg[field]?.["@types/bun"];
        if (v !== undefined && v !== PINNED_BUN) drift.push(`${file} ${field}: @types/bun ${v}`);
      }
    }
    expect(drift).toEqual([]);
  });

  test("bun.lock resolves @types/bun to the pinned version", () => {
    expect(lockedVersion("@types/bun")).toBe(PINNED_BUN);
  });

  test("the root package.json's engines.bun asks for at least the pinned version", () => {
    const root = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { engines?: { bun?: string } };
    expect(root.engines?.bun).toBe(`>=${PINNED_BUN}`);
  });
});
