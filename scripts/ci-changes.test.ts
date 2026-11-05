// scripts/ci-changes.ts: which CI jobs a change runs, for the kinds of change the lanes make.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { areasFor, CI_AREA_NAMES, matches, type CiArea } from "./ci-changes";

const on = (changed: string[]): CiArea[] => CI_AREA_NAMES.filter((a) => areasFor(changed)[a]);

describe("ci-changes", () => {
  test("patterns: a folder prefix, a one-folder file prefix, globs, and exact paths", () => {
    expect(matches("apps/desktop/src/main/index.ts", "apps/")).toBe(true);
    expect(matches("appsx/a.ts", "apps/")).toBe(false);
    expect(matches("scripts/verify-runtimes-compiled.ts", "scripts/verify-")).toBe(true);
    expect(matches("scripts/verify-x/y.ts", "scripts/verify-")).toBe(false);
    expect(matches("plugins/clover/plugins/shell/package.json", "**/package.json")).toBe(true);
    expect(matches("package.json", "**/package.json")).toBe(true);
    expect(matches("services/hello/tsconfig.test.json", "**/tsconfig*.json")).toBe(true);
    expect(matches("VERSION", "VERSION")).toBe(true);
    expect(matches("VERSIONS.json", "VERSION")).toBe(false);
  });

  test("docs and reports run no area (only the names-and-layout checks and the gate)", () => {
    expect(on(["docs/clover-plan.md", "docs/research/2026-11-05-x.md", "README.md"])).toEqual([]);
  });

  test("a plugin lane's change: the workspace tests, the gallery and the typecheck, and nothing on macOS but its own tests", () => {
    expect(on(["plugins/clover/plugins/shell/src/a.tsx", "plugins/clover/plugins/shell/test/a.test.ts"])).toEqual(["workspaces", "gallery", "typecheck"]);
    expect(on(["plugins/clover/plugins/shell/package.json"])).toEqual(["workspaces", "gallery", "typecheck", "lockfiles"]);
  });

  test("the packages: packaging/ and the app's builder config build and open the Linux packages; an app change does too", () => {
    expect(on(["packaging/linux/after-install.sh"])).toEqual(["packages", "scripts"]);
    expect(on(["apps/desktop/electron-builder.yml"])).toEqual(["workspaces", "app", "packages", "typecheck", "scripts"]);
  });

  test("a service's change: its tests and the typecheck", () => {
    expect(on(["services/forwarder/src/index.ts"])).toEqual(["workspaces", "typecheck"]);
  });

  test("macOS: a change takes at most three macOS jobs (its machine's, the one for core, cli, scripts and verify, and Swift)", () => {
    const jobs = (Bun.YAML.parse(readFileSync(join(import.meta.dir, "..", ".github", "workflows", "ci.yml"), "utf8")) as { jobs: Record<string, { if?: string; "runs-on"?: string; strategy?: { matrix?: { include?: Array<{ runner: string }> } } }> }).jobs;
    const macJobs = (changed: string[]): string[] => {
      const areas = areasFor(changed);
      return Object.entries(jobs).flatMap(([id, j]) => {
        const wanted = [...(j.if ?? "").matchAll(/needs\.changes\.outputs\.(\w+) == 'true'/g)].some((m) => areas[m[1] as CiArea]);
        const mac = j["runs-on"] === "macos-latest" || (j.strategy?.matrix?.include ?? []).some((r) => r.runner.startsWith("macos"));
        return wanted && mac ? [id] : [];
      });
    };
    expect(macJobs(["packages/core/src/daemon.ts"])).toEqual(["machine", "macos", "swift"]);
    expect(macJobs(["bun.lock"])).toEqual(["machine", "macos", "swift"]);
    expect(macJobs(["packages/cli/src/main.ts"])).toEqual(["machine", "macos"]);
    expect(macJobs(["apple/WinterKit/Sources/WinterKit/Client.swift"])).toEqual(["macos", "swift"]);
    expect(macJobs(["plugins/clover/plugins/shell/src/a.tsx"])).toEqual(["machine"]);
    expect(macJobs(["docs/clover-plan.md"])).toEqual([]);
  });

  test("the core: its own, the CLI's and the scripts' tests, the daemon, the compiled gates and the Swift kits (WinterKit runs its daemon); not the app", () => {
    const core = on(["packages/core/src/daemon.ts"]);
    expect(core).toEqual(["workspaces", "daemon", "typecheck", "core", "cli", "scripts", "swift", "verify"]);
    expect(core).not.toContain("app");
  });

  test("the Swift kits run for apple/, the protocol's generated fixtures and the core, and not for the rest of the protocol or the CLI", () => {
    expect(on(["apple/WinterKit/Sources/WinterKit/Client.swift"])).toEqual(["scripts", "swift"]);
    expect(on(["apple/WinterProtocol/Tests/WinterProtocolTests/Fixtures/x.json"])).toEqual(["scripts", "codegen", "swift"]);
    expect(on(["packages/protocol/generated/fixtures/x.json"])).toContain("swift");
    expect(on(["packages/protocol/src/methods.ts"])).not.toContain("swift");
    expect(on(["packages/cli/src/main.ts"])).not.toContain("swift");
  });

  test("CI itself, the toolchain, the root manifest or a lockfile run every area; so does no diff", () => {
    for (const f of [".github/workflows/ci.yml", "scripts/ci-changes.ts", ".bun-version", "package.json", "bun.lock", "pnpm-lock.yaml"]) expect(on([f])).toEqual(CI_AREA_NAMES);
    expect(CI_AREA_NAMES.filter((a) => areasFor(undefined)[a])).toEqual(CI_AREA_NAMES);
  });

  test("ci.yml has a job, or a matrix of them, behind every area, and the gate waits for them all", () => {
    const jobs = (Bun.YAML.parse(readFileSync(join(import.meta.dir, "..", ".github", "workflows", "ci.yml"), "utf8")) as { jobs: Record<string, { if?: string; needs?: string | string[] }> }).jobs;
    // A job may serve several areas (`… == 'true' || … == 'true'`), each step taking its own.
    const gated = Object.values(jobs).flatMap((j) => [...(j.if ?? "").matchAll(/needs\.changes\.outputs\.(\w+) == 'true'/g)].map((m) => m[1]!));
    expect([...new Set(gated)].sort()).toEqual([...CI_AREA_NAMES].sort());
    const gateNeeds = jobs.gate?.needs;
    const all = Object.keys(jobs).filter((id) => id !== "gate" && jobs[id]!.if !== "github.event_name == 'workflow_dispatch'");
    expect([...(Array.isArray(gateNeeds) ? gateNeeds : [])].sort()).toEqual(all.sort());
  });
});

// The merge queue (main's protection): a queued PR is tested on top of the latest main before it lands, which needs CI,
// and so `gate`, to run on its merge group, with the areas taken from the group's own base.
describe("CI on a merge-queue group", () => {
  const ci = Bun.YAML.parse(readFileSync(join(import.meta.dir, "..", ".github", "workflows", "ci.yml"), "utf8")) as {
    on: Record<string, unknown>;
    jobs: Record<string, { if?: string; steps?: { id?: string; run?: string; env?: Record<string, string> }[] }>;
  };

  test("ci.yml runs on merge_group, and gate runs whatever happened", () => {
    expect(Object.keys(ci.on)).toContain("merge_group");
    expect(ci.jobs.gate?.if).toBe("always()");
  });

  test("the changes job compares a group with the base it was built on", () => {
    const step = ci.jobs.changes?.steps?.find((s) => s.id === "areas");
    expect(step?.env?.GROUP_BASE).toBe("${{ github.event.merge_group.base_sha }}");
    expect(step?.run).toContain('merge_group)');
    expect(step?.run).toContain('--base "$GROUP_BASE"');
  });
});
