// #312's review, S1: what a plugin process starts from is written whole (never through a planted link) and checked by
// its SHA-256 right before the start; the host checks each worker's files before every Worker.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, lstatSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkRunFiles, parseRunCheckArgs, readRunFile, runCheckArgs, sha256Hex, writeRunFile } from "../run-file";
import { hostProcessLaunch, spawnHostProcess } from "../launch";
import { bunWorker } from "../mux";
import { ensurePluginRunFiles, pluginRunFileChecks } from "../../registry/plugin-run";

const dirs: string[] = [];
const scratch = (): string => {
  const d = mkdtempSync(join(tmpdir(), "clover-run-file-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("writeRunFile", () => {
  test("replaces a link planted at the name (its target untouched), private, and leaves no temporary file", () => {
    const d = scratch();
    const target = join(d, "elsewhere.txt");
    writeFileSync(target, "the user's file");
    symlinkSync(target, join(d, "guard.mjs"));
    writeRunFile(join(d, "guard.mjs"), "guard text");
    expect(readFileSync(target, "utf8")).toBe("the user's file");
    expect(lstatSync(join(d, "guard.mjs")).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(d, "guard.mjs"), "utf8")).toBe("guard text");
    expect(lstatSync(join(d, "guard.mjs")).mode & 0o777).toBe(0o600);
    expect(readdirSync(d).sort()).toEqual(["elsewhere.txt", "guard.mjs"]);
  });

  test("a changed file is replaced whole; an unchanged one is left as it is", () => {
    const d = scratch();
    const p = join(d, "plugin-host.js");
    writeRunFile(p, "one");
    const ino = lstatSync(p).ino;
    writeRunFile(p, "one");
    expect(lstatSync(p).ino).toBe(ino);
    writeFileSync(p, "tampered");
    writeRunFile(p, "one");
    expect(readFileSync(p, "utf8")).toBe("one");
    expect(lstatSync(p).ino).not.toBe(ino);
  });
});

describe("checkRunFiles", () => {
  test("passes the text Clover wrote; refuses a changed file, a link to the same text, and a missing one", () => {
    const d = scratch();
    const p = join(d, "plugin-worker.js");
    writeRunFile(p, "worker text");
    const check = [{ path: p, sha256: sha256Hex("worker text") }];
    expect(() => checkRunFiles(check, "w")).not.toThrow();
    writeFileSync(p, "worker text, changed");
    expect(() => checkRunFiles(check, "w")).toThrow("changed since Clover wrote it");
    rmSync(p);
    writeFileSync(join(d, "copy.js"), "worker text");
    symlinkSync(join(d, "copy.js"), p);
    expect(readRunFile(p)).toBeUndefined();
    expect(() => checkRunFiles(check, "w")).toThrow("isn't a regular file Clover wrote");
    expect(() => checkRunFiles([{ path: join(d, "none"), sha256: sha256Hex("") }], "w")).toThrow("isn't a regular file");
  });

  test("the argv form round-trips, ignores other arguments and refuses a malformed one", () => {
    const checks = [{ path: "/run/plugin-worker.js", sha256: sha256Hex("a") }, { path: "/run/a b/guard.mjs", sha256: sha256Hex("b") }];
    expect(parseRunCheckArgs(["bun", "/run/plugin-host.js", ...runCheckArgs(checks), "--other"])).toEqual(checks);
    expect(() => parseRunCheckArgs(["--clover-check=nothex:/x"])).toThrow("malformed");
  });
});

describe("the run files and the host's start", () => {
  test("ensurePluginRunFiles writes the bunfig, both guards and the spawn trampoline whole, and each check matches what it wrote", () => {
    const home = scratch();
    const files = ensurePluginRunFiles(join(home, "run"), { cloverHome: home });
    expect(() => checkRunFiles(pluginRunFileChecks(files, { host: true }), "run files")).not.toThrow();
    writeFileSync(files.guard, `${readFileSync(files.guard, "utf8")}\n// a plugin was here\n`);
    expect(() => checkRunFiles(pluginRunFileChecks(files), "run files")).toThrow("changed since Clover wrote it");
    // The next ensure writes it back whole.
    ensurePluginRunFiles(join(home, "run"), { cloverHome: home });
    expect(() => checkRunFiles(pluginRunFileChecks(files, { host: true }), "run files")).not.toThrow();
    // The spawn trampoline a fenced start runs through (#357) is checked too.
    const trampoline = join(dirname(files.guard), "spawn.mjs");
    writeFileSync(trampoline, `${readFileSync(trampoline, "utf8")}\n// a plugin was here\n`);
    expect(() => checkRunFiles(pluginRunFileChecks(files), "run files")).toThrow("changed since Clover wrote it");
  });

  test("the host doesn't start from a bundle or guard that changed after the launch was made; its worker checks ride in argv", async () => {
    const home = scratch();
    const launch = await hostProcessLaunch({ runDir: join(home, "run"), computer: "c", base: { PATH: process.env.PATH }, cloverHome: home });
    const host = launch.cmd.find((a) => a.endsWith("plugin-host.js"))!;
    const worker = launch.env.CLOVER_PLUGIN_WORKER!;
    expect(parseRunCheckArgs(launch.cmd).map((c) => c.path).sort()).toEqual([worker, join(dirname(host), "bunfig.toml"), join(dirname(host), "guard.mjs"), join(dirname(host), "spawn.mjs")].sort());
    expect(Object.keys(launch.env).some((k) => /check/i.test(k))).toBe(false);
    expect(launch.checks!.map((c) => c.path).sort()).toEqual([host, join(dirname(host), "bunfig.toml"), join(dirname(host), "guard.mjs"), join(dirname(host), "spawn.mjs"), join(dirname(host), "host-guard.mjs")].sort());
    writeFileSync(host, `${readFileSync(host, "utf8")}\n// swapped\n`);
    expect(() => spawnHostProcess(launch)).toThrow("the plugin host: ");
  });

  test("the host refuses a worker whose bundle changed, before the Worker exists", () => {
    const d = scratch();
    const entry = join(d, "plugin-worker.js");
    writeRunFile(entry, "export {};\n");
    const spawn = bunWorker("c", entry, [{ path: entry, sha256: sha256Hex("export {};\n") }]);
    writeFileSync(entry, "export const evil = 1;\n");
    mkdirSync(join(d, "p"));
    expect(() => spawn({ pluginId: "p", folder: join(d, "p") } as Parameters<typeof spawn>[0])).toThrow("plugin p's worker: ");
  });
});
