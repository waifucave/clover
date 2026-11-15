// scripts/workspaces.ts: which packages CI's per-OS run takes, by their `cloverCi` fields.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentOs, installGaps, main, plan, staleInstalls, workspacePackages, type WorkspacePackage } from "./workspaces";

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

  test("an install older than the manifests stops a run with the fix: a workspace: dependency with no link", () => {
    const root = mkdtempSync(join(tmpdir(), "clover-ws-"));
    try {
      writeFileSync(join(root, "package.json"), JSON.stringify({ name: "root", workspaces: ["packages/*"] }));
      for (const [name, deps] of [["sdk", {}], ["cli", { "@w/sdk": "workspace:*", "left-pad": "^1.0.0" }]] as const) {
        mkdirSync(join(root, "packages", name), { recursive: true });
        writeFileSync(join(root, "packages", name, "package.json"), JSON.stringify({ name: `@w/${name}`, dependencies: deps, scripts: { nothing: "true" } }));
      }
      const packages = workspacePackages(root);
      // The cli's install predates its sdk dependency (lane G's worktree on 590444d09): no link anywhere.
      expect(installGaps(root, packages)).toEqual(["packages/cli has no link for @w/sdk"]);
      expect(main(["run", "nothing"], root)).toBe(1);
      // Linked in its own node_modules (bun's way), or hoisted to the root's: no gap. A registry dependency isn't checked.
      mkdirSync(join(root, "packages", "cli", "node_modules", "@w"), { recursive: true });
      symlinkSync(join(root, "packages", "sdk"), join(root, "packages", "cli", "node_modules", "@w", "sdk"));
      expect(installGaps(root, workspacePackages(root))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an install older than the lockfile stops a run with the fix: a registry package at another version than it pins", () => {
    const root = mkdtempSync(join(tmpdir(), "clover-ws-"));
    try {
      writeFileSync(join(root, "package.json"), JSON.stringify({ name: "root", workspaces: ["packages/*"] }));
      mkdirSync(join(root, "packages", "core"), { recursive: true });
      writeFileSync(join(root, "packages", "core", "package.json"), JSON.stringify({ name: "@w/core", dependencies: { "@w/agent-sdk": "0.0.77", "left-pad": "^1.3.0", "only-on-linux": "1.0.0" }, scripts: { nothing: "true" } }));
      // bun.lock: JSON with trailing commas. The core has its own copy of left-pad (`@w/core/left-pad`).
      writeFileSync(join(root, "bun.lock"), `{
  "lockfileVersion": 1,
  "packages": {
    "@w/agent-sdk": ["@w/agent-sdk@0.0.77", "https://npm.example/@w/agent-sdk/0.0.77", {}, "sha512-x"],
    "@w/core": ["@w/core@workspace:packages/core"],
    "left-pad": ["left-pad@1.2.0", "", {}, "sha512-y"],
    "@w/core/left-pad": ["left-pad@1.3.0", "", {}, "sha512-z"],
    "only-on-linux": ["only-on-linux@1.0.0", "", {}, "sha512-w"],
  },
}
`);
      // bun's isolated install: the package's node_modules links into node_modules/.bun/<name>@<version>.
      const install = (name: string, version: string) => {
        const store = join(root, "node_modules", ".bun", `${name.replace("/", "+")}@${version}`, "node_modules", name);
        mkdirSync(store, { recursive: true });
        writeFileSync(join(store, "package.json"), JSON.stringify({ name, version }));
        const link = join(root, "packages", "core", "node_modules", name);
        rmSync(link, { force: true });
        mkdirSync(join(link, ".."), { recursive: true });
        symlinkSync(store, link);
      };
      install("@w/agent-sdk", "0.0.76"); // installed before the bump
      install("left-pad", "1.3.0");
      const packages = workspacePackages(root);
      // The worktree installed before the SDK bump (lane E's, 14 type errors in core): stopped, naming both versions.
      expect(staleInstalls(root, packages)).toEqual(["@w/agent-sdk in packages/core: installed 0.0.76, the lockfile pins 0.0.77"]);
      const errors: string[] = [];
      const error = console.error;
      console.error = (line: string) => void errors.push(line);
      try {
        expect(main(["run", "nothing"], root)).toBe(1);
      } finally {
        console.error = error;
      }
      expect(errors.join("\n")).toContain("@w/agent-sdk in packages/core: installed 0.0.76, the lockfile pins 0.0.77");
      // The fix: the install, with the registry token in that one command's environment.
      expect(errors.join("\n")).toContain("NODE_AUTH_TOKEN=$(gh auth token) scripts/pinned-bun install --frozen-lockfile");
      expect(errors.join("\n")).toContain("never in a file");
      // Installed again: current. The package's own copy is read against its own lock entry, and a dependency not
      // installed here (another OS's) is no mismatch.
      install("@w/agent-sdk", "0.0.77");
      expect(staleInstalls(root, packages)).toEqual([]);
      install("left-pad", "1.2.0");
      expect(staleInstalls(root, packages)).toEqual(["left-pad in packages/core: installed 1.2.0, the lockfile pins 1.3.0"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("this checkout's install is current (the gate's own precondition)", () => {
    const root = join(import.meta.dir, "..");
    expect(installGaps(root, workspacePackages(root))).toEqual([]);
    expect(staleInstalls(root, workspacePackages(root))).toEqual([]);
  });
});
