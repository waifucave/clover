// macOS and Linux: the DevTools pipe as two pipe(2) pairs made over bun:ffi and handed to Bun.spawn as plain
// descriptors 3 and 4 — Winter's production road (packages/core/src/computer-use/browser/headless/winter-engine.ts).
// node:child_process's extra "pipe" slots are not used: under Bun the browser's fd 3 can read EOF while the daemon
// still holds the pipe, and the browser then shuts down cleanly ("Connection terminated while reading from pipe", the
// round-one failure here). Every end is close-on-exec, so no other child inherits one; the child's two are dup2'd
// into 3 and 4 (a duplicate does not carry the flag) and closed here once it has them. Bun only (bun:ffi).
import { createReadStream, write as fsWrite } from "node:fs";
import { StringDecoder } from "node:string_decoder";

interface Libc { pipe(fds: Int32Array): number; close(fd: number): number; cloexec(fd: number, on: boolean): number }
let libc: Libc | undefined;

async function lib(): Promise<Libc> {
  if (libc !== undefined) return libc;
  const { dlopen, FFIType, ptr } = await import("bun:ffi");
  const l = dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
    pipe: { args: [FFIType.ptr], returns: FFIType.i32 },
    close: { args: [FFIType.i32], returns: FFIType.i32 },
    ioctl: { args: [FFIType.i32, FFIType.u64], returns: FFIType.i32 },
  });
  // FIOCLEX / FIONCLEX: _IO('f', 1) / _IO('f', 2) on macOS; 0x5451 / 0x5450 on Linux (x86-64 and arm64 alike)
  const [on, off] = process.platform === "darwin" ? [0x20006601, 0x20006602] : [0x5451, 0x5450];
  libc = { pipe: (fds) => l.symbols.pipe(ptr(fds)), close: (fd) => l.symbols.close(fd), cloexec: (fd, set) => l.symbols.ioctl(fd, set ? on : off) };
  return libc;
}

export interface FdPipeProcess {
  readonly proc: ReturnType<typeof Bun.spawn>;
  write(text: string): boolean;
  onData(listener: (text: string) => void): void;
  closeInput(): void;
}

/** Start `command` with fd 3 (our commands) and fd 4 (its answers); stderr piped, stdin/stdout ignored. */
export async function spawnWithFdPipes(command: string, args: string[]): Promise<FdPipeProcess> {
  const c = await lib();
  const make = (): [number, number] => {
    const fds = new Int32Array(2);
    if (c.pipe(fds) !== 0) throw new Error("pipe() failed");
    for (const fd of fds) c.cloexec(fd, true);
    return [fds[0]!, fds[1]!];
  };
  const [childRead, ourWrite] = make();
  const [ourRead, childWrite] = make();
  // a child end that already IS its target number is not duplicated, so it must not be close-on-exec itself
  if (childRead === 3) c.cloexec(childRead, false);
  if (childWrite === 4) c.cloexec(childWrite, false);
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([command, ...args], { stdio: ["ignore", "ignore", "pipe", childRead, childWrite] });
  } catch (e) {
    for (const fd of [childRead, ourWrite, ourRead, childWrite]) c.close(fd);
    throw e;
  }
  c.close(childRead);
  c.close(childWrite);

  let open = true, writing = false;
  const queue: Buffer[] = [];
  const closeWrite = (): void => {
    if (!open) return;
    open = false;
    queue.length = 0;
    if (!writing) c.close(ourWrite);
  };
  const pump = (): void => {
    if (writing) return;
    const next = queue.shift();
    if (next === undefined) return;
    writing = true;
    fsWrite(ourWrite, next, (err, n) => {
      writing = false;
      if (err !== null) { closeWrite(); return; }
      if (n < next.length) queue.unshift(next.subarray(n));
      if (!open) { c.close(ourWrite); return; }
      pump();
    });
  };
  const input = createReadStream("", { fd: ourRead, autoClose: true, highWaterMark: 1024 * 1024 });
  input.on("error", () => { /* the exit says what happened */ });
  const decoder = new StringDecoder("utf8");
  return {
    proc,
    write(text) {
      if (!open) return false;
      queue.push(Buffer.from(text, "utf8"));
      pump();
      return true;
    },
    onData(listener) { input.on("data", (chunk) => listener(decoder.write(typeof chunk === "string" ? Buffer.from(chunk) : chunk))); },
    closeInput() { closeWrite(); },
  };
}
