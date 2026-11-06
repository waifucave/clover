#!/usr/bin/env bun
// The daemon's IDLE cost, measured: how often an idle `clover-core` wakes the CPU.
//
//   bun run check:idle-wakeups            # boots an isolated daemon, settles, measures 3 × 10 s, fails over 50/s
//   bun run check:idle-wakeups --pid N    # measures an already-running process of yours instead (read-only)
//
// THE METER. The process's own wakeup counters, read with `proc_pid_rusage` at each window's edges: `interrupt`, every
// wakeup by an interrupt (a timer firing, I/O arriving), which the gate holds, and `package idle`, the subset that
// woke an idle CPU package, which `top`'s IDLEW shows (and only with `-c d`; without it IDLEW counts since launch).
// The gate used to read IDLEW, but on macOS 26 under load it read 0 for every process (measured 2026-11-05:
// WindowServer, and a Bun process with a 5 ms timer that the interrupt counter put at 174 wakeups a second), so it
// passed whatever the daemon did. An idle Bun process measures 1 interrupt wakeup a second.
//
// ISOLATION. The booted daemon runs IN a child bun process on a temp CLOVER_HOME with a FILE secret store
// (`startDaemon({ secrets })`): every Keychain path in the daemon is gated on the profile's default home, and a
// random throwaway CLOVER_KEYCHAIN_SERVICE is set besides (no CLOVER_PROFILE). It never touches ~/.clover*.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dlopen, FFIType, ptr } from "bun:ffi";
import { USAGE_INERT_ENV } from "../packages/core/src/usage/wiring";

const LIMIT_PER_SECOND = 50;
const SETTLE_MS = 20_000;
const WINDOWS = 3;
const WINDOW_S = 10;

const CORE = join(import.meta.dir, "..", "packages", "core", "src");

/** A process's wakeup counts since it started (`proc_pid_rusage`, `RUSAGE_INFO_V0`). */
interface Wakeups { interrupt: number; packageIdle: number }

function wakeupCounter(): (pid: number) => Wakeups {
  if (process.platform !== "darwin") throw new Error("check:idle-wakeups measures on macOS only");
  const lib = dlopen("/usr/lib/libproc.dylib", { proc_pid_rusage: { args: [FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 } });
  return (pid) => {
    // rusage_info_v0: ri_uuid[16], ri_user_time, ri_system_time, ri_pkg_idle_wkups, ri_interrupt_wkups, … (uint64s).
    const info = new BigUint64Array(12);
    const r = lib.symbols.proc_pid_rusage(pid, 0, ptr(info));
    if (r !== 0) throw new Error(`proc_pid_rusage(${pid}) failed (${r}): is the process gone, or not yours?`);
    return { packageIdle: Number(info[4]), interrupt: Number(info[5]) };
  };
}

/** Wakeups in each of `windows` windows of `seconds`, per meter. */
async function idleWakeups(pid: number, windows: number, seconds: number): Promise<Wakeups[]> {
  const read = wakeupCounter();
  const out: Wakeups[] = [];
  let last = read(pid);
  for (let i = 0; i < windows; i++) {
    await Bun.sleep(seconds * 1000);
    const now = read(pid);
    out.push({ interrupt: now.interrupt - last.interrupt, packageIdle: now.packageIdle - last.packageIdle });
    last = now;
  }
  return out;
}

async function main(): Promise<void> {
  const at = process.argv.indexOf("--pid");
  if (at >= 0) {
    const pid = Number(process.argv[at + 1]);
    if (!Number.isInteger(pid) || pid <= 0) throw new Error("--pid takes a process id");
    report(await idleWakeups(pid, WINDOWS, WINDOW_S));
    return;
  }
  const home = mkdtempSync(join(tmpdir(), "clover-idle-check-"));
  const probe = join(home, "probe.ts");
  writeFileSync(probe, [
    `const { startDaemon } = await import(${JSON.stringify(join(CORE, "daemon.ts"))});`,
    `const { FileSecretStore } = await import(${JSON.stringify(join(CORE, "auth", "secret-store.ts"))});`,
    `const { USAGE_INERT } = await import(${JSON.stringify(join(CORE, "usage", "wiring.ts"))});`,
    `const d = await startDaemon({ home: ${JSON.stringify(home)}, secrets: new FileSecretStore(${JSON.stringify(join(home, "test-secrets"))}), usage: USAGE_INERT });`,
    `console.log("READY");`,
    `process.on("SIGTERM", async () => { try { await d.stop(); } finally { process.exit(0); } });`,
  ].join("\n"));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== "CLOVER_PROFILE") env[k] = v;
  Object.assign(env, { CLOVER_HOME: home, CLOVER_KEYCHAIN_SERVICE: `com.waifucave.clover.core.test-idle-${crypto.randomUUID().slice(0, 8)}`, CLOVER_LOGIN_SHELL_PATH: "off",
    // Usage tracking (docs/claude/usage.md): inert — every root and executable none, the background plan beat and the
    // catch-up off (`USAGE_INERT` above, and the same in the environment), so the measurement never touches the
    // developer's own Codex / Claude Code / Antigravity / OpenCode files or binaries. The gate does NOT cover the beat
    // (its 30-min and fast timers would not tick inside these 50 s anyway).
    ...USAGE_INERT_ENV });
  // This Bun, not the first on PATH: the daemon measured is the one the check runs on.
  const daemon = Bun.spawn([process.execPath, probe], { env, stdout: "pipe", stderr: "inherit" });
  try {
    const reader = daemon.stdout.getReader();
    let seen = "";
    const deadline = Date.now() + 60_000;
    while (!seen.includes("READY")) {
      if (Date.now() > deadline) throw new Error("the daemon did not come up within 60 s");
      const { value, done } = await reader.read();
      if (done) throw new Error("the daemon exited before it was ready");
      seen += new TextDecoder().decode(value);
    }
    console.log(`daemon up (pid ${daemon.pid}); settling ${SETTLE_MS / 1000} s`);
    await Bun.sleep(SETTLE_MS);
    report(await idleWakeups(daemon.pid, WINDOWS, WINDOW_S));
  } finally {
    daemon.kill("SIGTERM");
    await Promise.race([daemon.exited, Bun.sleep(5_000)]);
    rmSync(home, { recursive: true, force: true });
  }
}

function report(samples: Wakeups[]): void {
  if (samples.length === 0) throw new Error("no samples were taken");
  const perSecond = samples.map((w) => w.interrupt / WINDOW_S);
  const worst = Math.max(...perSecond);
  console.log(`wakeups per ${WINDOW_S} s, interrupt: ${samples.map((w) => w.interrupt).join(", ")}; package idle (top's IDLEW): ${samples.map((w) => w.packageIdle).join(", ")}`);
  console.log(`worst ${worst.toFixed(1)} interrupt wakeups/s (limit ${LIMIT_PER_SECOND}/s)`);
  if (worst > LIMIT_PER_SECOND) {
    console.error("FAIL: the idle daemon wakes too often");
    process.exit(1);
  }
  console.log("PASS");
}

await main();
