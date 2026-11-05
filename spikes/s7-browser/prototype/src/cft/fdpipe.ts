// macOS and Linux: the DevTools pipe as two pipe(2) pairs made over bun:ffi and handed to Bun.spawn as plain
// descriptors 3 and 4 — Winter's production road (packages/core/src/computer-use/browser/headless/winter-engine.ts).
// node:child_process's extra "pipe" slots are not used: under Bun the browser's fd 3 can read EOF while the daemon
// still holds the pipe, and the browser then shuts down cleanly ("Connection terminated while reading from pipe", the
// round-one failure here). Every end is close-on-exec, so no other child inherits one; the child's two are dup2'd
// into 3 and 4 (a duplicate does not carry the flag) and closed here once it has them. Bun only (bun:ffi).
import { createReadStream, write as fsWrite, writeSync } from "node:fs";
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
  /** Our side of the commands pipe: what waits to be written, whether a write is in flight, what went out. */
  stats(): { queued: number; inFlight: boolean; writes: number; bytesOut: number; writeError?: string };
}

/**
 * Start `command` with fd 3 (our commands) and fd 4 (its answers); stderr piped, stdin/stdout ignored. `reader`:
 * "async" reads with node's createReadStream and writes with fs.write (Winter's road); "worker" reads with blocking
 * read(2) calls in a Bun Worker and writes with writeSync, so neither direction waits on the event loop's pool.
 */
export async function spawnWithFdPipes(command: string, args: string[], reader: "async" | "worker" = "async"): Promise<FdPipeProcess> {
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

  let open = true, writing = false, writes = 0, bytesOut = 0;
  let writeError: string | undefined;
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
      if (err !== null && err !== undefined) { writeError = String(err); closeWrite(); return; }
      writes++;
      bytesOut += n;
      if (n < next.length) queue.unshift(next.subarray(n));
      if (!open) { c.close(ourWrite); return; }
      pump();
    });
  };
  const decoder = new StringDecoder("utf8");
  if (reader === "worker") {
    const listeners: Array<(text: string) => void> = [];
    const worker = new Worker(new URL("./fdreader-worker.ts", import.meta.url).href);
    worker.onmessage = (e: MessageEvent<{ chunk?: Uint8Array; eof?: boolean; error?: string }>) => {
      if (e.data.chunk !== undefined) { const text = decoder.write(Buffer.from(e.data.chunk)); for (const l of listeners) l(text); }
      else { worker.terminate(); c.close(ourRead); }
    };
    worker.postMessage({ fd: ourRead });
    void proc.exited.then(() => { setTimeout(() => { try { worker.terminate(); } catch { /* gone */ } }, 2000); });
    return {
      proc,
      write(text) {
        if (!open) return false;
        const b = Buffer.from(text, "utf8");
        try {
          for (let off = 0; off < b.length;) off += writeSync(ourWrite, b, off, b.length - off);
          writes++;
          bytesOut += b.length;
        } catch (err) {
          writeError = String(err);
          closeWrite();
          return false;
        }
        return true;
      },
      onData(listener) { listeners.push(listener); },
      closeInput() { closeWrite(); },
      stats() { return { queued: 0, inFlight: false, writes, bytesOut, ...(writeError === undefined ? {} : { writeError }) }; },
    };
  }
  const input = createReadStream("", { fd: ourRead, autoClose: true, highWaterMark: 1024 * 1024 });
  input.on("error", () => { /* the exit says what happened */ });
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
    stats() { return { queued: queue.length, inFlight: writing, writes, bytesOut, ...(writeError === undefined ? {} : { writeError }) }; },
  };
}
