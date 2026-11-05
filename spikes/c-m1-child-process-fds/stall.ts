// Lane C, C-M1: S7's "Linux stall" isolated without a browser (S7 report, "For lane C: reproducing
// the Linux stall", step 2). One Bun process keeps descriptors open (regular files, echo children on
// pipe(2) pairs made over bun:ffi as fdpipe.ts does, `cat` children with Bun-managed pipes) and,
// between checks, starts short-lived children through node:child_process or Bun.spawn. After every
// step it fstat()s each descriptor and, for the echo and `cat` children, writes a line and reads it
// back. EBADF, EPIPE, a missing reply or an early EOF reproduces the stall.
//
// Finding (Bun 1.3.14; results/): a node:child_process spawn with a stdio entry past fd 2 later
// closes descriptor numbers the process has since reused, on macOS, Linux and Windows; a regular
// file's descriptor reads EBADF. Three-entry spawns, and Bun.spawn with extra pipes or plain
// descriptor numbers, never did. packages/core/test/platform/child-process-stdio.test.ts keeps such
// spawns out of the Bun code.
//
//   bun stall.ts <steps> <iterations> [gapMs]
//   steps, a comma list run in order each iteration:
//     file            open a regular file and keep it
//     echo            a `cat <&3 >&4` child on two pipe(2) pairs (macOS, Linux)
//     cat             a `cat` child with Bun.spawn's stdin/stdout pipes
//     cp3-<how>       node:child_process, stdio ["ignore","ignore","pipe"]
//     cp4-<how>       node:child_process, stdio ["ignore","ignore","pipe","pipe"]
//     cp4i-<how>      node:child_process, stdio ["ignore","ignore","ignore","pipe"]
//     cp5-<how>       node:child_process, stdio ["ignore","ignore","pipe","pipe","pipe"]
//     bun5-<how>      Bun.spawn, stdio ["ignore","ignore","pipe","pipe","pipe"]
//     bunfd-<how>     Bun.spawn with two pipe(2) ends as fds 3 and 4 (macOS, Linux)
//   <how>: crash (exit 133), clean (exit 0) or run (runs a second; killed for cp*)
import { createReadStream, fstatSync, mkdtempSync, openSync, rmSync, write as fsWrite } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn as cpSpawn } from "node:child_process";

// libc's pipe(2) and close(2), loaded only where a step needs them (never on Windows).
let libc: { pipe(fds: Int32Array): number; close(fd: number): number; ioctl(fd: number, req: number): number } | undefined;
async function lc() {
  if (libc) return libc;
  const { dlopen, FFIType, ptr } = await import("bun:ffi");
  const l = dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
    pipe: { args: [FFIType.ptr], returns: FFIType.i32 },
    close: { args: [FFIType.i32], returns: FFIType.i32 },
    ioctl: { args: [FFIType.i32, FFIType.u64], returns: FFIType.i32 },
  });
  libc = { pipe: (fds) => l.symbols.pipe(ptr(fds)), close: (fd) => l.symbols.close(fd), ioctl: (fd, req) => l.symbols.ioctl(fd, req) };
  return libc;
}
const [CLOEXEC_ON, CLOEXEC_OFF] = process.platform === "darwin" ? [0x20006601, 0x20006602] : [0x5451, 0x5450];
const close = (fd: number) => libc!.close(fd);
function makePipe(): [number, number] {
  const fds = new Int32Array(2);
  if (libc!.pipe(fds) !== 0) throw new Error("pipe() failed");
  for (const fd of fds) libc!.ioctl(fd, CLOEXEC_ON);
  return [fds[0]!, fds[1]!];
}
/** A child that exits with `how` (crash 133, clean 0) or runs a second ("run"). */
function dyingArgv(how: string): [string, string[]] {
  if (process.platform === "win32") return ["cmd.exe", ["/d", "/c", how === "crash" ? "exit 133" : how === "clean" ? "exit 0" : "ping -n 2 127.0.0.1 >nul"]];
  return ["sh", ["-c", how === "crash" ? "exit 133" : how === "clean" ? "exit 0" : "sleep 1"]];
}

interface Echo { id: number; ourWrite: number; ourRead: number; proc: ReturnType<typeof Bun.spawn>; buf: string; eof: boolean; err?: string; waiters: Array<() => void> }
const echoes: Echo[] = [];
let echoSeq = 0;
const failures: Array<Record<string, unknown>> = [];
const files: Array<{ fd: number; id: number }> = [];
const scratch = mkdtempSync(join(tmpdir(), "lane-c-stall-"));
const cats: Array<{ id: number; proc: ReturnType<typeof Bun.spawn>; out: string; reader: Promise<void> }> = [];

function startEcho(): Echo {
  const [childRead, ourWrite] = makePipe();
  const [ourRead, childWrite] = makePipe();
  if (childRead === 3) libc!.ioctl(childRead, CLOEXEC_OFF);
  if (childWrite === 4) libc!.ioctl(childWrite, CLOEXEC_OFF);
  const proc = Bun.spawn(["sh", "-c", "cat <&3 >&4"], { stdio: ["ignore", "ignore", "inherit", childRead, childWrite] });
  close(childRead); close(childWrite);
  const e: Echo = { id: ++echoSeq, ourWrite, ourRead, proc, buf: "", eof: false, waiters: [] };
  const input = createReadStream("", { fd: ourRead, autoClose: false });
  input.on("data", (d) => { e.buf += d.toString(); for (const w of e.waiters.splice(0)) w(); });
  input.on("end", () => { e.eof = true; for (const w of e.waiters.splice(0)) w(); });
  input.on("error", (err) => { e.err = String(err); for (const w of e.waiters.splice(0)) w(); });
  echoes.push(e);
  return e;
}

async function check(e: Echo, tag: string): Promise<void> {
  for (const [name, fd] of [["write", e.ourWrite], ["read", e.ourRead]] as const) {
    try { fstatSync(fd); } catch (err) { failures.push({ tag, echo: e.id, fstat: name, fd, err: String(err) }); }
  }
  const line = `ping ${tag} ${e.id}\n`;
  const wrote = await new Promise<string | null>((res) => fsWrite(e.ourWrite, line, (err) => res(err ? String(err) : null)));
  if (wrote !== null) { failures.push({ tag, echo: e.id, write: wrote }); return; }
  const ok = await new Promise<boolean>((res) => {
    const done = () => { if (e.buf.includes(line)) { clearTimeout(t); res(true); } else if (e.eof || e.err) { clearTimeout(t); res(false); } else e.waiters.push(done); };
    const t = setTimeout(() => res(false), 2000);
    done();
  });
  if (!ok) failures.push({ tag, echo: e.id, reply: "missing", eof: e.eof, err: e.err, exited: e.proc.exitCode });
}

let cpHangs = 0;
function waitCp(child: ReturnType<typeof cpSpawn>): Promise<void> {
  return new Promise((res) => {
    const t = setTimeout(() => { cpHangs++; res(); }, 3000);
    child.once("close", () => { clearTimeout(t); res(); });
  });
}

async function step(name: string): Promise<void> {
  const [kind, how] = name.split("-") as [string, string];
  const [cmd, cmdArgs] = dyingArgv(how);
  if (kind === "echo") { await lc(); startEcho(); return; }
  if (kind === "file") { files.push({ fd: openSync(join(scratch, `f${files.length}`), "w"), id: files.length }); return; }
  if (kind === "cat") {
    const proc = Bun.spawn(["cat"], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
    const c = { id: cats.length, proc, out: "", reader: Promise.resolve() };
    c.reader = (async () => { const dec = new TextDecoder(); for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) c.out += dec.decode(chunk); })().catch(() => {});
    cats.push(c);
    return;
  }
  if (kind === "cp5" || kind === "cp4" || kind === "cp3" || kind === "cp4i") {
    const stdio = kind === "cp5" ? ["ignore", "ignore", "pipe", "pipe", "pipe"] : kind === "cp4" ? ["ignore", "ignore", "pipe", "pipe"]
      : kind === "cp4i" ? ["ignore", "ignore", "ignore", "pipe"] : ["ignore", "ignore", "pipe"];
    const child = cpSpawn(cmd, cmdArgs, { stdio: stdio as never, windowsHide: true });
    if (how === "run") { await new Promise((r) => setTimeout(r, 200)); child.kill(); }
    await waitCp(child);
    return;
  }
  if (kind === "bunfd") {
    await lc();
    const [cr, ow] = makePipe(); const [or, cw] = makePipe();
    const p = Bun.spawn([cmd, ...cmdArgs], { stdio: ["ignore", "ignore", "pipe", cr, cw] });
    close(cr); close(cw);
    await p.exited;
    close(ow); close(or);
    return;
  }
  if (kind === "bun5") {
    const p = Bun.spawn([cmd, ...cmdArgs], { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] as never, windowsHide: true });
    await p.exited;
    return;
  }
  throw new Error(`unknown step ${name}`);
}

const steps = (process.argv[2] ?? "bunfd-crash,cp5-crash,cp3-crash,echo,cp3-run").split(",");
const iterations = Number(process.argv[3] ?? 20);
const gapMs = Number(process.argv[4] ?? 0);
const started = Date.now();
if (process.platform !== "win32") { await lc(); startEcho(); }
for (let i = 0; i < iterations; i++) {
  for (const s of steps) {
    if (process.env.STALL_VERBOSE) console.error(`${Date.now() - started}ms ${i}:${s}`);
    await step(s);
    if (gapMs > 0) await new Promise((r) => setTimeout(r, gapMs));
    for (const e of echoes) await check(e, `${i}:${s}`);
    for (const f of files) { try { fstatSync(f.fd); } catch (err) { failures.push({ tag: `${i}:${s}`, file: f.id, fd: f.fd, err: String(err) }); } }
    for (const c of cats) {
      const line = `cat ${i}:${s}\n`;
      try { (c.proc.stdin as import("bun").FileSink).write(line); (c.proc.stdin as import("bun").FileSink).flush(); } catch (err) { failures.push({ tag: `${i}:${s}`, cat: c.id, write: String(err) }); continue; }
      const t0 = Date.now();
      while (!c.out.includes(line) && Date.now() - t0 < 2000) await new Promise((r) => setTimeout(r, 5));
      if (!c.out.includes(line)) failures.push({ tag: `${i}:${s}`, cat: c.id, reply: "missing", exited: c.proc.exitCode });
    }
  }
}
console.log(JSON.stringify({ platform: process.platform, arch: process.arch, bun: Bun.version, steps, iterations, gapMs, echoes: echoes.length, failures: failures.length, cpHangs, first: failures.slice(0, 5), ms: Date.now() - started }));
for (const e of echoes) { try { e.proc.kill(); } catch { /* gone */ } }
for (const c of cats) { try { c.proc.kill(); } catch { /* gone */ } }
rmSync(scratch, { recursive: true, force: true });
process.exit(0);
