// The workflow worker's guard on Linux (`linuxConfinementState`): confined only when the process's status says
// no_new_privs and a seccomp filter AND a Unix socket is refused; anything else, or anything unreadable, is not.
// The fake-probe cases hold anywhere; the real ones need Linux: the test runner itself (not confined), and a probe
// started by the agent SDK's own launcher (`linuxConfineMain`: Landlock, seccomp, no_new_privs, then the exec).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LINUX_CONFINE_ARGV_FLAG } from "@waifucave/clover-agent-runtime";
import { linuxConfinementState, PROBED_SOCKET_TYPES, type LinuxConfinementProbe } from "./sandbox-guard";

const onLinux = process.platform === "linux";
const temps: string[] = [];
afterAll(() => { for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true }); });

const status = (noNewPrivs: string | null, seccomp: string | null) =>
  ["Name:\tbun", ...(noNewPrivs === null ? [] : [`NoNewPrivs:\t${noNewPrivs}`]), ...(seccomp === null ? [] : [`Seccomp:\t${seccomp}`]), "Seccomp_filters:\t1", ""].join("\n");
/** The spawner's pid in the fake probes, and the peer each fake socket descriptor reports. */
const PARENT = 4100;
const probe = (s: string | undefined, sock: { fd: number; errno: number } | ((type: number) => { fd: number; errno: number }), fds: readonly string[] | null = ["/dev/null", "pipe:[1]", "anon_inode:[eventpoll]"],
  peers: Record<number, number | undefined> = {}, addresses: Record<number, "unnamed" | "named" | undefined> = {}): LinuxConfinementProbe =>
  ({ status: () => s, unixSocket: typeof sock === "function" ? sock : () => sock, descriptors: () => fds?.map((target, fd) => ({ fd, target })), peerPid: (fd) => peers[fd],
    peerAddress: (fd) => (fd in addresses ? addresses[fd] : "unnamed"), parentPid: () => PARENT });
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
    expect(linuxConfinementState(probe(status("1", "2"), { fd: 5, errno: 0 }))).toEqual({ ok: false, reason: "the confinement allows a Unix socket (type 1; the secret service is reached over one)" });
    expect(linuxConfinementState(probe(undefined, DENIED))).toEqual({ ok: false, reason: "the process's status (/proc/self/status) could not be read" });
  });

  test("every kind of Unix socket is asked for: one allowed type is enough to refuse", () => {
    for (const allowed of PROBED_SOCKET_TYPES) {
      const r = linuxConfinementState(probe(status("1", "2"), (type) => (type === allowed ? { fd: 7, errno: 0 } : DENIED)));
      expect(r).toEqual({ ok: false, reason: `the confinement allows a Unix socket (type ${allowed}; the secret service is reached over one)` });
    }
    // A stream, its flags, a datagram and a seqpacket socket.
    expect(PROBED_SOCKET_TYPES).toEqual([1, 1 | 0o2000000 | 0o4000, 2, 2 | 0o2000000, 5]);
  });

  test("a socket it holds already refuses, and descriptors it can't read do too", () => {
    expect(linuxConfinementState(probe(status("1", "2"), DENIED, ["/dev/null", "pipe:[1]", "pipe:[2]", "socket:[4242]"], { 3: PARENT }))).toEqual({ ok: false, reason: "this process holds a socket it was handed (descriptor 3)" });
    expect(linuxConfinementState(probe(status("1", "2"), DENIED, null))).toEqual({ ok: false, reason: "the process's descriptors (/proc/self/fd) could not be read" });
  });

  test("its stdio may be a socketpair its spawner made (the peer is its parent); nothing else is", () => {
    // Bun's spawn gives a child's stdio as a socketpair on Linux: the spawner's own pair passes.
    expect(linuxConfinementState(probe(status("1", "2"), DENIED, ["pipe:[1]", "socket:[11]", "socket:[12]"], { 1: PARENT, 2: PARENT }))).toEqual({ ok: true });
    // A stdio socket whose peer is another process (the session bus, say), or unreadable, or none (not a Unix socket).
    expect(linuxConfinementState(probe(status("1", "2"), DENIED, ["socket:[11]", "pipe:[1]", "pipe:[2]"], { 0: 777 }))).toEqual({ ok: false, reason: `this process holds a socket it was handed (descriptor 0, its peer 777, not its spawner ${PARENT})` });
    expect(linuxConfinementState(probe(status("1", "2"), DENIED, ["pipe:[1]", "socket:[11]", "pipe:[2]"]))).toEqual({ ok: false, reason: `this process holds a socket it was handed (descriptor 1, its peer unknown, not its spawner ${PARENT})` });
    // The parent's peer is not enough: a socket connected to a listener the parent owns has a named or abstract
    // address, and refuses; so does one whose address can't be read.
    expect(linuxConfinementState(probe(status("1", "2"), DENIED, ["pipe:[1]", "socket:[11]", "pipe:[2]"], { 1: PARENT }, { 1: "named" }))).toEqual({ ok: false, reason: "this process holds a socket it was handed (descriptor 1, connected to a named address, not a pair)" });
    expect(linuxConfinementState(probe(status("1", "2"), DENIED, ["pipe:[1]", "pipe:[2]", "socket:[11]"], { 2: PARENT }, { 2: undefined }))).toEqual({ ok: false, reason: "this process holds a socket it was handed (descriptor 2, connected to an unreadable address, not a pair)" });
    // At 3 or above (the launcher closes those on exec), a socket refuses even when the spawner made it.
    expect(linuxConfinementState(probe(status("1", "2"), DENIED, ["pipe:[1]", "socket:[11]", "pipe:[2]", "socket:[13]"], { 1: PARENT, 3: PARENT }))).toEqual({ ok: false, reason: "this process holds a socket it was handed (descriptor 3)" });
  });

  test("ambiguous answers fail closed: another errno, a probe that throws", () => {
    // EMFILE (24): out of descriptors says nothing about the confinement.
    expect(linuxConfinementState(probe(status("1", "2"), { fd: -1, errno: 24 }))).toMatchObject({ ok: false });
    expect(linuxConfinementState(probe(status("1", "2"), { fd: -1, errno: -1 }))).toMatchObject({ ok: false });
    const throwing: LinuxConfinementProbe = { status: () => status("1", "2"), unixSocket: () => { throw new Error("no libc"); }, descriptors: () => [], peerPid: () => undefined, peerAddress: () => undefined, parentPid: () => PARENT };
    expect(linuxConfinementState(throwing)).toEqual({ ok: false, reason: "the confinement could not be inspected (no libc)" });
  });
});

/** Runs a probe that prints `keychainSandboxState()`, directly or through the SDK's launcher. */
function runProbe(confined: boolean): { code: number; out: string; err: string } {
  const dir = mkdtempSync(join(tmpdir(), "clover-linux-guard-"));
  temps.push(dir);
  const probeFile = join(dir, "probe.ts");
  // The state, and (pinning that the launcher's filter refuses the call whatever the domain) an AF_INET socket's answer.
  writeFileSync(probeFile, [
    `import { keychainSandboxState } from ${JSON.stringify(join(import.meta.dir, "sandbox-guard.ts"))};`,
    `import { dlopen, FFIType } from "bun:ffi";`,
    `const state = keychainSandboxState();`,
    `const lib = dlopen("libc.so.6", { socket: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 }, close: { args: [FFIType.i32], returns: FFIType.i32 } });`,
    `const inet = lib.symbols.socket(2, 1, 0); if (inet >= 0) lib.symbols.close(inet);`,
    `process.stdout.write(JSON.stringify({ state, inet }));`,
  ].join("\n"));
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
    expect(JSON.parse(r.out).state).toMatchObject({ ok: false });
  });

  test.if(onLinux)("a probe the SDK's launcher confined is ok", () => {
    const r = runProbe(true);
    expect({ code: r.code, err: r.err }).toMatchObject({ code: 0 });
    const got = JSON.parse(r.out) as { state: unknown; inet: number };
    expect(got.state).toEqual({ ok: true });
    // The launcher's filter refuses the socket call itself, whatever the domain: an AF_INET socket fails too.
    expect(got.inet).toBe(-1);
  }, 30_000);
});
