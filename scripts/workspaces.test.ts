// scripts/workspaces.ts: which packages CI's per-OS run takes, by their `cloverCi` fields.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { currentOs, plan, workspacePackages, type WorkspacePackage } from "./workspaces";

const pkg = (name: string, extra: Partial<WorkspacePackage> = {}): WorkspacePackage => ({
  name, dir: `packages/${name}`, scripts: { test: "bun test", typecheck: "tsc --noEmit -p ." }, testOs: ["macos", "linux", "windows"], ownJob: false, ...extra,
});

describe("scripts/workspaces.ts", () => {
  test("the OS names", () => {
    expect([currentOs("darwin"), currentOs("linux"), currentOs("win32")]).toEqual(["macos", "linux", "windows"]);
  });

  test("test: a package's own job and its OS list decide; other scripts run wherever asked", () => {
    const all = [pkg("a"), pkg("own", { ownJob: true }), pkg("mac-only", { testOs: ["macos"] }), pkg("no-tests", { scripts: {} })];
    expect(plan(all, "test", { os: "linux" }).map((p) => p.name)).toEqual(["a"]);
    expect(plan(all, "test", { os: "macos" }).map((p) => p.name)).toEqual(["a", "mac-only"]);
    expect(plan(all, "typecheck", { os: "windows" }).map((p) => p.name)).toEqual(["a", "own", "mac-only"]);
    expect(plan(all, "test", { os: "macos", skip: ["a"] }).map((p) => p.name)).toEqual(["mac-only"]);
  });

  test("this repo: core and cli test in their own jobs, everything else on every OS unless it says otherwise", () => {
    const packages = workspacePackages(join(import.meta.dir, ".."));
    const byName = new Map(packages.map((p) => [p.name, p]));
    expect(byName.get("@waifucave/clover-core")?.ownJob).toBe(true);
    expect(byName.get("@waifucave/clover-cli")?.ownJob).toBe(true);
    expect(plan(packages, "test", { os: "linux" }).map((p) => p.name)).not.toContain("@waifucave/clover-core");
    for (const name of ["@waifucave/clover-protocol", "@waifucave/clover-plugin-sdk", "@waifucave/clover-test-harness", "@waifucave/clover-desktop", "@waifucave/clover-service-hello"]) {
      expect(plan(packages, "test", { os: "windows" }).map((p) => p.name)).toContain(name);
    }
  });
});
