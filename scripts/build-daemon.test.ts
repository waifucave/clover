// scripts/build-daemon.ts's pure half: the targets, the command each one runs, and the arguments. Nothing here
// compiles; CI's daemon job runs the real build on each of the four runners.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DAEMON_TARGETS, daemonCompileCommand, daemonFileName, daemonOutput, hostTarget, parseBuildDaemonArgs } from "./build-daemon";

const compileCore = (JSON.parse(readFileSync(join(import.meta.dir, "..", "packages", "cli", "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts["compile:core"]!;

describe("build:daemon", () => {
  test("the four targets, and which one this machine is", () => {
    expect(DAEMON_TARGETS).toEqual({ "darwin-arm64": "bun-darwin-arm64", "linux-x64": "bun-linux-x64", "linux-arm64": "bun-linux-arm64", "windows-x64": "bun-windows-x64" });
    expect(hostTarget("darwin", "arm64")).toBe("darwin-arm64");
    expect(hostTarget("linux", "x64")).toBe("linux-x64");
    expect(hostTarget("linux", "arm64")).toBe("linux-arm64");
    expect(hostTarget("win32", "x64")).toBe("windows-x64");
    expect(hostTarget("darwin", "x64")).toBeUndefined();
    expect(hostTarget("win32", "arm64")).toBeUndefined();
    expect(hostTarget("freebsd", "x64")).toBeUndefined();
  });

  test("each target's output, with .exe on Windows only", () => {
    expect(daemonFileName("windows-x64")).toBe("clover-core.exe");
    expect(daemonOutput("windows-x64")).toBe("dist/daemon/windows-x64/clover-core.exe");
    for (const t of ["darwin-arm64", "linux-x64", "linux-arm64"] as const) expect(daemonOutput(t)).toBe(`dist/daemon/${t}/clover-core`);
  });

  test("the command is compile:core itself, with only the target and the output changed", () => {
    for (const target of Object.keys(DAEMON_TARGETS) as (keyof typeof DAEMON_TARGETS)[]) {
      const command = daemonCompileCommand(compileCore, target);
      expect(command).toBe(compileCore
        .replace("bun build --compile", `bun build --compile --target=${DAEMON_TARGETS[target]} --compile-exec-argv=--use-system-ca`)
        .replace("--outfile ../../dist/clover-core", `--outfile ../../${daemonOutput(target)}`)
        .replaceAll("bun build ", "bun build --define __CLOVER_DIST__=true "));
      // The pre-bundles stay as they are but for the dist define, and the compile keeps all three entrypoints.
      const steps = command.split("&&").map((s) => s.trim());
      expect(steps.length).toBe(3);
      for (const step of steps) expect(step.startsWith("bun build --define __CLOVER_DIST__=true ")).toBe(true);
      expect(steps.slice(0, 2)).toEqual(compileCore.split("&&").map((s) => s.trim().replace("bun build ", "bun build --define __CLOVER_DIST__=true ")).slice(0, 2));
      expect(steps[2]).toContain("src/main.ts src/embedded-worker.ts src/fd-receiver-worker.ts");
    }
  });

  test("a compile:core of another shape is refused, not guessed at", () => {
    expect(() => daemonCompileCommand("bun build --compile src/main.ts --outfile elsewhere", "linux-x64")).toThrow("update scripts/build-daemon.ts");
    expect(() => daemonCompileCommand("bun build src/main.ts --outfile ../../dist/clover-core", "linux-x64")).toThrow("update scripts/build-daemon.ts");
  });

  test("arguments: the host by default, a list or --all, and --smoke only with the host's own target", () => {
    expect(parseBuildDaemonArgs([], "linux-x64")).toEqual({ targets: ["linux-x64"], smoke: false, dryRun: false });
    expect(parseBuildDaemonArgs(["--target", "linux-arm64,windows-x64", "--dry-run"], "darwin-arm64")).toEqual({ targets: ["linux-arm64", "windows-x64"], smoke: false, dryRun: true });
    expect(parseBuildDaemonArgs(["--target=darwin-arm64", "--smoke"], "darwin-arm64").smoke).toBe(true);
    expect(parseBuildDaemonArgs(["--all"], "darwin-arm64").targets).toEqual(["darwin-arm64", "linux-x64", "linux-arm64", "windows-x64"]);
    expect(() => parseBuildDaemonArgs(["--target", "darwin-x64"], "darwin-arm64")).toThrow("not darwin-x64");
    expect(() => parseBuildDaemonArgs(["--target"], "darwin-arm64")).toThrow("--target takes");
    expect(() => parseBuildDaemonArgs(["--target", "linux-x64", "--smoke"], "darwin-arm64")).toThrow("--smoke runs the host's own binary");
    expect(() => parseBuildDaemonArgs([], undefined)).toThrow("name one with --target");
    expect(() => parseBuildDaemonArgs(["--sign"], "darwin-arm64")).toThrow("unknown argument --sign");
  });
});
