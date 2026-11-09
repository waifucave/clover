// The workflow worker's guard on Linux (`linuxConfinementState`): confined only when the process's status says
// no_new_privs and a seccomp filter AND a Unix socket is refused; anything else, or anything unreadable, is not.
// The fake-probe cases hold anywhere; the real ones need Linux: the test runner itself (not confined), and a probe
// started by the agent SDK's own launcher (`linuxConfineMain`: Landlock, seccomp, no_new_privs, then the exec).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LINUX_CONFINE_ARGV_FLAG } from "@waifucave/clover-agent-runtime";
import { linuxConfinementState, type LinuxConfinementProbe } from "./sandbox-guard";

const onLinux = process.platform === "linux";
const temps: string[] = [];
afterAll(() => { for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true }); });

const status = (noNewPrivs: string | null, seccomp: string | null) =>
  ["Name:\tbun", ...(noNewPrivs === null ? [] : [`NoNewPrivs:\t${noNewPrivs}`]), ...(seccomp === null ? [] : [`Seccomp:\t${seccomp}`]), "Seccomp_filters:\t1", ""].join("\n");
const probe = (s: string | undefined, sock: { fd: number; errno: number }): LinuxConfinementProbe => ({ status: () => s, unixSocket: () => sock });
const DENIED = { fd: -1, errno: 1 };

describe("linuxConfinementState with a given probe", () => {
  test("confined: NoNewPrivs 1, a seccomp filter, and a Unix socket refused (EPERM or EACCES)", () => {
    expect(linuxConfinementState(probe(status("1", "2"), DENIED))).toEqual({ ok: true });
    expect(linuxConfinementState(probe(status("1", "2"), { fd: -1, errno: 13 }))).toEqual({ ok: true });
  });

  test("not confined: either flag missing or off, a socket made, an unreadable status", () => {
    expect(linuxConfinementState(probe(status("0", "2"), DENIED))).toEqual({ ok: false, reason: "this process is not confined (NoNewPrivs: 0)" });
    expect(linuxConfinementState(probe(status("1", "0"), DENIED))).toEqual({ ok: false, reason: "this process is not confined (Seccomp: 0, not a filter)" });
    expect(linuxConfinementState(probe(status("1", "1"), DENIED))).toMatchObject({ ok: false });
    expect(linuxConfinementState(probe(status(null, "2"), DENIED))).toEqual({ ok: false, reason: "the process's status names no NoNewPrivs or Seccomp" });
    expect(linuxConfinementState(probe(status("1", null), DENIED))).toMatchObject({ ok: false });
    expect(linuxConfinementState(probe(status("1", "2"), { fd: 5, errno: 0 }))).toEqual({ ok: false, reason: "the confinement allows a Unix socket (the secret service is reached over one)" });
    expect(linuxConfinementState(probe(undefined, DENIED))).toEqual({ ok: false, reason: "the process's status (/proc/self/status) could not be read" });
  });

  test("ambiguous answers fail closed: another errno, a probe that throws", () => {
    // EMFILE (24): out of descriptors says nothing about the confinement.
    expect(linuxConfinementState(probe(status("1", "2"), { fd: -1, errno: 24 }))).toMatchObject({ ok: false });
    expect(linuxConfinementState(probe(status("1", "2"), { fd: -1, errno: -1 }))).toMatchObject({ ok: false });
    const throwing: LinuxConfinementProbe = { status: () => status("1", "2"), unixSocket: () => { throw new Error("no libc"); } };
    expect(linuxConfinementState(throwing)).toEqual({ ok: false, reason: "the confinement could not be inspected (no libc)" });
  });
});

/** Runs a probe that prints `keychainSandboxState()`, directly or through the SDK's launcher. */
function runProbe(confined: boolean): { code: number; out: string; err: string } {
  const dir = mkdtempSync(join(tmpdir(), "clover-linux-guard-"));
  temps.push(dir);
  const probeFile = join(dir, "probe.ts");
  writeFileSync(probeFile, `import { keychainSandboxState } from ${JSON.stringify(join(import.meta.dir, "sandbox-guard.ts"))};\nprocess.stdout.write(JSON.stringify(keychainSandboxState()));\n`);
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" };
  let cmd = [process.execPath, probeFile];
  if (confined) {
    const launcher = join(dir, "launcher.ts");
    writeFileSync(launcher, `import { linuxConfineMain } from ${JSON.stringify(Bun.resolveSync("@waifucave/clover-agent-runtime", import.meta.dir))};\nprocess.exit(linuxConfineMain(process.argv));\n`);
    // The launcher's spec (the SDK's `LinuxConfinementSpec`, version 1): the worker to exec once confined, nothing
    // read-denied beyond the SDK's own rules, the SDK's Landlock floor.
    const spec = Buffer.from(JSON.stringify({ version: 1, target: { file: process.execPath, args: [probeFile] }, readDeny: [], minLandlockAbi: 3 }), "utf8").toString("base64url");
    cmd = [process.execPath, launcher, LINUX_CONFINE_ARGV_FLAG, spec];
  }
  const r = Bun.spawnSync({ cmd, cwd: dir, env, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode ?? -1, out: r.stdout.toString(), err: r.stderr.toString() };
}

describe("keychainSandboxState on Linux, for real", () => {
  test.if(onLinux)("the test runner itself is not confined, in process and in a child", () => {
    expect(linuxConfinementState()).toMatchObject({ ok: false });
    const r = runProbe(false);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ ok: false });
  });

  test.if(onLinux)("a probe the SDK's launcher confined is ok", () => {
    const r = runProbe(true);
    expect({ code: r.code, err: r.err }).toMatchObject({ code: 0 });
    expect(JSON.parse(r.out)).toEqual({ ok: true });
  }, 30_000);
});
