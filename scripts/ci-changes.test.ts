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
    expect(on(["packaging/linux/after-install.sh"])).toEqual(["packages", "installers", "scripts"]);
    expect(on(["apps/desktop/electron-builder.yml"])).toEqual(["workspaces", "app", "packages", "installers", "typecheck", "scripts"]);
  });

  test("the installers' release build runs for what makes them, never for code, CI's own files or a lockfile alone", () => {
    for (const f of ["scripts/release/lib.ts", "packaging/windows/installer.nsh", "apps/desktop/electron-builder.yml", "apps/desktop/package.json", "scripts/build-packages.ts", "packages/update-feed/src/index.ts"]) {
      expect(areasFor([f]).installers).toBe(true);
    }
    for (const f of ["bun.lock", ".bun-version", ".github/workflows/ci.yml", "packages/core/src/daemon.ts", "apps/desktop/src/main/index.ts", "packages/cli/src/main.ts"]) {
      expect(areasFor([f]).installers).toBe(false);
    }
    expect(areasFor(undefined).installers).toBe(true);
  });

  test("the merge queue's sweep (its own workflow): the scripts' tests, which run its step against stand-ins", () => {
    expect(on([".github/workflows/queue-sweep.yml"])).toEqual(["scripts"]);
  });

  test("a service's change: its tests and the typecheck", () => {
    expect(on(["services/forwarder/src/index.ts"])).toEqual(["workspaces", "typecheck"]);
  });

  test("macOS: a merge-queue run takes at most two macOS jobs (its machine's and the one for core, cli, scripts and verify); a pull request takes none (the local gate); Swift runs on demand only", () => {
    type Job = { if?: string; "runs-on"?: string; strategy?: { matrix?: { include?: string | Array<{ runner: string }> } } };
    const jobs = (Bun.YAML.parse(readFileSync(join(import.meta.dir, "..", ".github", "workflows", "ci.yml"), "utf8")) as { jobs: Record<string, Job> }).jobs;
    type Event = "pull_request" | "merge_group" | "workflow_dispatch";
    const runsOn = (j: Job, event: Event): boolean => {
      const cond = j.if ?? "";
      if (cond.includes("github.event_name == 'workflow_dispatch'") && event !== "workflow_dispatch") return false;
      if (cond.includes("github.event_name != 'pull_request'") && event === "pull_request") return false;
      return true;
    };
    const isMac = (j: Job, event: Event): boolean => {
      if (j["runs-on"] === "macos-latest") return true;
      const include = j.strategy?.matrix?.include;
      if (typeof include === "string") return include.includes("macos");
      return (include ?? []).some((r) => r.runner.startsWith("macos"));
    };
    const macJobs = (changed: string[], event: Event = "merge_group"): string[] => {
      const areas = areasFor(changed);
      return Object.entries(jobs).flatMap(([id, j]) => {
        const wanted = [...(j.if ?? "").matchAll(/needs\.changes\.outputs\.(\w+) == 'true'/g)].some((m) => areas[m[1] as CiArea]);
        return wanted && runsOn(j, event) && isMac(j, event) ? [id] : [];
      });
    };
    // The machine job runs every machine, macOS among them, and never on a pull request.
    expect((jobs.machine!.strategy!.matrix!.include as Array<{ runner: string }>).map((r) => r.runner)).toContain("macos-latest");
    expect(jobs.machine!.if).toStartWith("github.event_name != 'pull_request' && ");
    expect(macJobs(["packages/core/src/daemon.ts"])).toEqual(["machine", "macos"]);
    expect(macJobs(["bun.lock"])).toEqual(["machine", "macos"]);
    expect(macJobs([".github/workflows/ci.yml"])).toEqual(["machine", "macos"]);
    expect(macJobs(["packages/cli/src/main.ts"])).toEqual(["machine", "macos"]);
    // An apple/ change: the Swift kits on demand only, and the scripts' tests on Linux, never the macos job (its
    // scripts step runs only the scripts' own macOS tests, for a change to scripts/).
    expect(macJobs(["apple/WinterKit/Sources/WinterKit/Client.swift"])).toEqual([]);
    expect(macJobs(["apple/WinterKit/Sources/WinterKit/Client.swift"], "workflow_dispatch")).toEqual(["swift"]);
    expect(on(["apple/WinterKit/Sources/WinterKit/Client.swift"])).not.toContain("scriptsmac");
    expect(macJobs(["scripts/embed-runtimes.sh"])).toEqual(["macos"]);
    expect(on(["scripts/embed-runtimes.sh"])).toEqual(expect.arrayContaining(["scripts", "scriptsmac"]));
    expect(macJobs(["plugins/clover/plugins/shell/src/a.tsx"])).toEqual(["machine"]);
    expect(macJobs(["docs/clover-plan.md"])).toEqual([]);
    // A pull request takes no hosted macOS runner, whatever it changes.
    for (const change of ["packages/core/src/daemon.ts", ".github/workflows/ci.yml", "apple/WinterKit/Sources/WinterKit/Client.swift", "scripts/embed-runtimes.sh", "plugins/clover/plugins/shell/src/a.tsx"]) {
      expect(macJobs([change], "pull_request")).toEqual([]);
    }
  });

  // Owner's ruling, November 10: a pull request runs the quick Linux checks only; the four machines and everything
  // else run in the merge queue (and on a manual run). `gate` needs every job either path can run.
  test("a pull request runs only the quick Linux jobs; the merge queue and a manual run run every job; gate needs them all", () => {
    type Job = { if?: string; "runs-on"?: string; needs?: string | string[]; strategy?: { matrix?: { include?: Array<{ runner: string }>; runner?: string[] } } };
    const jobs = (Bun.YAML.parse(readFileSync(join(import.meta.dir, "..", ".github", "workflows", "ci.yml"), "utf8")) as { jobs: Record<string, Job> }).jobs;
    type Event = "pull_request" | "merge_group" | "workflow_dispatch";
    const can = (j: Job, event: Event): boolean => {
      const cond = j.if ?? "";
      if (cond.includes("github.event_name == 'workflow_dispatch'") && event !== "workflow_dispatch") return false;
      if (cond.includes("github.event_name == 'pull_request'") && event !== "pull_request") return false;
      if (cond.includes("github.event_name != 'pull_request'") && event === "pull_request") return false;
      return true;
    };
    const runners = (j: Job): string[] => [...(j["runs-on"] !== undefined && !j["runs-on"].includes("${{") ? [j["runs-on"]] : []), ...(j.strategy?.matrix?.include ?? []).map((r) => r.runner), ...(j.strategy?.matrix?.runner ?? [])];
    const on = (event: Event): string[] => Object.keys(jobs).filter((id) => id !== "gate" && can(jobs[id]!, event)).sort();
    expect(on("pull_request")).toEqual(["changes", "core-linux", "lockfiles", "names", "protocol-codegen", "scripts", "test-extension", "typecheck", "workspaces-pr"]);
    for (const id of on("pull_request")) expect([id, runners(jobs[id]!).every((r) => r.startsWith("ubuntu-24.04") && !r.endsWith("-arm"))]).toEqual([id, true]);
    // The merge queue: every job a change can take, but the PR-only one and the dispatch-only ones.
    expect(on("merge_group")).toEqual(Object.keys(jobs).filter((id) => !["gate", "workspaces-pr", "swift", "swift-cowork-launcher", "libkrun-queue"].includes(id)).sort());
    for (const id of ["machine", "packages", "installers", "tree", "link", "linux-repo-signatures", "gallery", "macos"]) {
      expect([id, on("merge_group").includes(id), on("workflow_dispatch").includes(id), on("pull_request").includes(id)]).toEqual([id, true, true, false]);
    }
    expect(runners(jobs.machine!).sort()).toEqual(["macos-latest", "ubuntu-24.04", "ubuntu-24.04-arm", "windows-latest"]);
    // gate: always, and it needs every job any of the three runs can take (the dispatch-only Cowork jobs aside, which
    // were never part of it).
    const gate = jobs.gate!;
    expect(gate.if).toBe("always()");
    const needs = new Set(Array.isArray(gate.needs) ? gate.needs : [gate.needs]);
    const ran = new Set([...on("pull_request"), ...on("merge_group"), ...on("workflow_dispatch")].filter((id) => !["swift-cowork-launcher", "libkrun-queue"].includes(id)));
    expect([...ran].filter((id) => !needs.has(id))).toEqual([]);
    // The PR's workspaces job is the machine job's step, on linux-x64.
    expect(JSON.stringify(jobs["workspaces-pr"])).toContain("scripts/with-private-secret-service.sh bun scripts/workspaces.ts run test");
  });

  test("any package's source runs the scripts job, whose source scans (the native channel's anti-wiring test) read every src/", () => {
    for (const f of ["packages/cli/src/worker-entry-probe.ts", "packages/test-harness/src/x.ts", "packages/core/src/daemon.ts", "scripts/build-daemon.ts"]) {
      expect([f, on([f]).includes("scripts")]).toEqual([f, true]);
    }
    const jobs = (Bun.YAML.parse(readFileSync(join(import.meta.dir, "..", ".github", "workflows", "ci.yml"), "utf8")) as { jobs: Record<string, { steps?: Array<{ run?: string; "working-directory"?: string }> }> }).jobs;
    const scan = jobs.scripts?.steps?.find((s) => (s.run ?? "").includes("anti-wiring.test.ts"));
    expect([scan?.["working-directory"], scan?.run]).toEqual(["packages/core", "bun test test/cowork/native/anti-wiring.test.ts"]);
  });

  test("the core: its own, the CLI's and the scripts' tests, the daemon, the packages that carry it, the compiled gates and the Swift kits (WinterKit runs its daemon); not the app", () => {
    const core = on(["packages/core/src/daemon.ts"]);
    expect(core).toEqual(["workspaces", "daemon", "packages", "typecheck", "core", "cli", "scripts", "verify"]);
    expect(core).not.toContain("app");
  });

  test("a model plugin alone runs the core's suite (lane A's catalog and generator check), and other plugins don't", () => {
    expect(on(["plugins/clover/plugins/model-openai/clover.json"])).toContain("core");
    expect(on(["plugins/clover/plugins/model-anthropic/src/catalog.ts"])).toContain("core");
    expect(on(["plugins/clover/plugins/shell/src/a.tsx"])).not.toContain("core");
  });

  test("the tree job (Linux and Windows) runs for the tree's and the computers' code and tests, and their conformance suites", () => {
    for (const f of ["packages/core/src/tree/index.ts", "packages/core/src/computers/registry.ts", "packages/core/test/tree/x.test.ts",
      "packages/core/test/computers/x.test.ts", "packages/core/src/contracts/tests/tree.test.ts", "packages/core/src/contracts/tests/computer-registry.test.ts",
      "packages/core/src/agents/backend.ts", "packages/core/src/agents/process/launch.ts", "packages/core/src/agents/tests/windows-path.test.ts",
      "plugins/clover/plugins/agent-cursor/clover.json", "plugins/clover/plugins/agent-gemini/clover.json"]) {
      expect(on([f]), f).toContain("tree");
    }
    expect(on(["packages/core/src/daemon.ts"])).not.toContain("tree");
    expect(on(["plugins/clover/plugins/agent-cursor/quirks.json"])).not.toContain("tree");
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
    // Only apple/, the root Package.swift, the generated fixtures and CI's own definition run the Swift kits: not the
    // core (main's push run still covers WinterKit's daemon tests), not the toolchain or a lockfile.
    expect(on(["packages/core/src/daemon.ts"])).not.toContain("swift");
    for (const g of [".bun-version", "package.json", "bun.lock", "pnpm-lock.yaml"]) expect(on([g]), g).not.toContain("swift");
    expect(on(["scripts/ci-changes.ts"])).toContain("swift");
    expect(on(["Package.swift"])).toContain("swift");
  });

  test("CI itself runs every area but the installers; the toolchain, the root manifest or a lockfile every area but the Swift kits and the installers; so does no diff", () => {
    for (const f of [".github/workflows/ci.yml", "scripts/ci-changes.ts"]) expect(on([f])).toEqual(CI_AREA_NAMES.filter((a) => a !== "installers"));
    for (const f of [".bun-version", "package.json", "bun.lock", "pnpm-lock.yaml"]) expect(on([f]), f).toEqual(CI_AREA_NAMES.filter((a) => a !== "swift" && a !== "installers"));
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
