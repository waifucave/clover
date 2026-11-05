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
    expect(matches("plugins/clover/shell/package.json", "**/package.json")).toBe(true);
    expect(matches("package.json", "**/package.json")).toBe(true);
    expect(matches("services/hello/tsconfig.test.json", "**/tsconfig*.json")).toBe(true);
    expect(matches("VERSION", "VERSION")).toBe(true);
    expect(matches("VERSIONS.json", "VERSION")).toBe(false);
  });

  test("docs and reports run no area (only the names-and-layout checks and the gate)", () => {
    expect(on(["docs/clover-plan.md", "docs/research/2026-11-05-x.md", "README.md"])).toEqual([]);
  });

  test("a plugin lane's change: the workspace tests, the gallery and the typecheck, and nothing on macOS but its own tests", () => {
    expect(on(["plugins/clover/shell/src/a.tsx", "plugins/clover/shell/test/a.test.ts"])).toEqual(["workspaces", "gallery", "typecheck"]);
    expect(on(["plugins/clover/shell/package.json"])).toEqual(["workspaces", "gallery", "typecheck", "lockfiles"]);
  });

  test("a service's change: its tests and the typecheck", () => {
    expect(on(["services/forwarder/src/index.ts"])).toEqual(["workspaces", "typecheck"]);
  });

  test("macOS: a core change takes two macOS jobs (its machine's, and the one for core, cli, scripts and verify); a lockfile change no Swift", () => {
    const jobs = (Bun.YAML.parse(readFileSync(join(import.meta.dir, "..", ".github", "workflows", "ci.yml"), "utf8")) as { jobs: Record<string, { if?: string; "runs-on"?: string; strategy?: { matrix?: { include?: Array<{ runner: string }> } } }> }).jobs;
    const macJobs = (changed: string[]): string[] => {
      const areas = areasFor(changed);
      return Object.entries(jobs).flatMap(([id, j]) => {
        const wanted = [...(j.if ?? "").matchAll(/needs\.changes\.outputs\.(\w+) == 'true'/g)].some((m) => areas[m[1] as CiArea]);
        const mac = j["runs-on"] === "macos-latest" || (j.strategy?.matrix?.include ?? []).some((r) => r.runner.startsWith("macos"));
        return wanted && mac ? [id] : [];
      });
    };
    expect(macJobs(["packages/core/src/daemon.ts"])).toEqual(["machine", "macos"]);
    expect(macJobs(["bun.lock"])).toEqual(["machine", "macos"]);
    expect(macJobs(["apple/WinterKit/Sources/WinterKit/Client.swift"])).toEqual(["macos", "swift"]);
    expect(macJobs(["plugins/clover/shell/src/a.tsx"])).toEqual(["machine"]);
    expect(macJobs(["docs/clover-plan.md"])).toEqual([]);
  });

  test("the core: its own, the CLI's and the scripts' tests, the daemon, the compiled gates; not the Swift kits or the app", () => {
    const core = on(["packages/core/src/daemon.ts"]);
    expect(core).toEqual(["workspaces", "daemon", "typecheck", "core", "cli", "scripts", "verify"]);
    expect(core).not.toContain("swift");
    expect(core).not.toContain("app");
  });

  test("the Swift kits run only for apple/ and the protocol's generated fixtures", () => {
    expect(on(["apple/WinterKit/Sources/WinterKit/Client.swift"])).toEqual(["scripts", "swift"]);
    expect(on(["apple/WinterProtocol/Tests/WinterProtocolTests/Fixtures/x.json"])).toEqual(["scripts", "codegen", "swift"]);
    expect(on(["packages/protocol/generated/fixtures/x.json"])).toContain("swift");
    expect(on(["packages/protocol/src/methods.ts"])).not.toContain("swift");
  });

  test("CI itself runs every area, and so does no diff; the toolchain, the root manifest or a lockfile every area but Swift's", () => {
    for (const f of [".github/workflows/ci.yml", "scripts/ci-changes.ts"]) expect(on([f])).toEqual(CI_AREA_NAMES);
    expect(CI_AREA_NAMES.filter((a) => areasFor(undefined)[a])).toEqual(CI_AREA_NAMES);
    for (const f of [".bun-version", "package.json", "bun.lock", "pnpm-lock.yaml"]) expect(on([f])).toEqual(CI_AREA_NAMES.filter((a) => a !== "swift"));
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
