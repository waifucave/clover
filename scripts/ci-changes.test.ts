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

  test("a change to Clover's own plugins: their tests, the app that loads them, the gallery and the typecheck", () => {
    expect(on(["plugins/clover/plugins/shell/src/a.tsx", "plugins/clover/plugins/shell/test/a.test.ts"])).toEqual(["workspaces", "app", "gallery", "typecheck"]);
    expect(on(["plugins/clover/plugins/shell/package.json"])).toEqual(["workspaces", "app", "gallery", "typecheck", "lockfiles"]);
    // Another top-level plugin (a bot's) is not loaded by the app's own build.
    expect(on(["plugins/alpha/tab/theme.json"])).toEqual(["workspaces", "gallery", "typecheck"]);
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

  test("the core: its own, the CLI's and the scripts' tests, the daemon, the packages that carry it, the compiled gates and the Swift kits (WinterKit runs its daemon); not the app", () => {
    const core = on(["packages/core/src/daemon.ts"]);
    expect(core).toEqual(["workspaces", "daemon", "packages", "typecheck", "core", "cli", "scripts", "swift", "verify"]);
    expect(core).not.toContain("app");
  });

  test("a model plugin alone runs the core's suite (lane A's catalog and generator check), and other plugins don't", () => {
    expect(on(["plugins/clover/plugins/model-openai/clover.json"])).toContain("core");
    expect(on(["plugins/clover/plugins/model-anthropic/src/catalog.ts"])).toContain("core");
    expect(on(["plugins/clover/plugins/shell/src/a.tsx"])).not.toContain("core");
  });

  test("the tree job (Linux and Windows) runs for the tree's and the computers' code and tests, and their conformance suites", () => {
    for (const f of ["packages/core/src/tree/index.ts", "packages/core/src/computers/registry.ts", "packages/core/test/tree/x.test.ts",
      "packages/core/test/computers/x.test.ts", "packages/core/src/contracts/tests/tree.test.ts", "packages/core/src/contracts/tests/computer-registry.test.ts"]) {
      expect(on([f]), f).toContain("tree");
    }
    expect(on(["packages/core/src/daemon.ts"])).not.toContain("tree");
    expect(on(["packages/core/src/contracts/tests/secret-store.test.ts"])).not.toContain("tree");
  });

  test("the link job runs for the sidecar, the links, and the devices and identity under them; the sidecar's change builds the packages too", () => {
    expect(on(["native/link/src/main.rs"])).toEqual(["workspaces", "packages", "link"]);
    for (const f of ["packages/core/src/links/sidecar-wire.ts", "packages/core/src/devices/registry.ts", "packages/core/src/identity/account.ts",
      "packages/core/src/contracts/link-transport.ts", "packages/core/src/clock/system-clock.ts", "packages/protocol/src/index.ts"]) expect(on([f]), f).toContain("link");
    expect(on(["packages/core/src/daemon.ts"])).not.toContain("link");
    expect(on(["native/link-sidecar/src/main.rs"])).not.toContain("link");
  });

  test("every CI step that runs the link tests requires the sidecar, so a missing build fails instead of skipping", () => {
    const jobs = (Bun.YAML.parse(readFileSync(join(import.meta.dir, "..", ".github", "workflows", "ci.yml"), "utf8")) as { jobs: Record<string, { steps?: Array<{ run?: string; env?: Record<string, string> }> }> }).jobs;
    const steps = Object.values(jobs).flatMap((j) => j.steps ?? []).filter((s) => /bun test\b.*\bsrc\/links\b/.test(s.run ?? ""));
    expect(steps.length).toBe(2);
    for (const s of steps) expect(s.env?.CLOVER_LINK_REQUIRE_BINARY).toBe("1");
  });

  test("the fence launcher's build runs for its script and its notices' settings alone", () => {
    expect(on(["scripts/release/srt-win.ts"])).toContain("srtwin");
    expect(on(["packaging/windows/about.toml"])).toContain("srtwin");
    // Lane C's build script, its patches and core's pin run it too.
    for (const f of ["scripts/build-srt-win.ps1", "vendor/srt-win/patches/0001-per-principal-setup-records.patch", "packages/core/src/fence/windows-launcher.ts"]) expect(on([f]), f).toContain("srtwin");
    expect(on(["packaging/windows/installer.nsh"])).not.toContain("srtwin");
  });

  test("the services' shared source and the sign-in stub run the core's suite (its account tests import them)", () => {
    expect(on(["services/shared/account-token.ts"])).toContain("core");
    expect(on(["packages/test-harness/src/signin-stub.ts"])).toContain("core");
    expect(on(["packages/test-harness/src/workers.ts"])).not.toContain("core");
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
    jobs: Record<string, { if?: string; outputs?: Record<string, string>; steps?: { id?: string; run?: string; env?: Record<string, string> }[] }>;
  };

  test("the changes job hands on every area: its outputs are exactly the areas ci-changes.ts writes", () => {
    // A job keyed to an area the outputs leave out reads an empty string, is skipped every time, and the gate passes.
    const outputs = ci.jobs.changes?.outputs ?? {};
    expect(Object.keys(outputs).sort()).toEqual([...CI_AREA_NAMES].sort());
    for (const [name, value] of Object.entries(outputs)) expect(value, name).toBe(`\${{ steps.areas.outputs.${name} }}`);
  });

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
