// macOS and Linux: the DevTools pipe as two pipe(2) pairs made over bun:ffi and handed to `Bun.spawn` as plain
// descriptors 3 and 4 (spike S7's `fdpipe.ts`). On Linux the daemon spawns only through `Bun.spawn`,
// never `node:child_process` (S7's Linux stall). Every end is close-on-exec, so no other child inherits one; the child's
// two are dup2'd into 3 and 4 by the spawn (a duplicate doesn't carry the flag) and closed here once it has them.
// Answers are read with blocking read(2) calls on a worker thread of their own, so the read never waits on (or
// wakes) the daemon's event loop and holds none of its thread pool; commands are written with writeSync. Bun only.
import { writeSync } from "node:fs";
import type { BrowserProcess, PipeTransport } from "./cdp";

interface Libc {
  pipe(fds: Int32Array): number;
  close(fd: number): number;
  cloexec(fd: number, on: boolean): number;
}
let libc: Libc | undefined;

async function lib(): Promise<Libc> {
  if (libc !== undefined) return libc;
  const { dlopen, FFIType, ptr } = await import("bun:ffi");
  const l = dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
    pipe: { args: [FFIType.ptr], returns: FFIType.i32 },
    close: { args: [FFIType.i32], returns: FFIType.i32 },
    ioctl: { args: [FFIType.i32, FFIType.u64], returns: FFIType.i32 },
  });
  // FIOCLEX / FIONCLEX: _IO('f', 1) / _IO('f', 2) on macOS; 0x5451 / 0x5450 on Linux (x86-64 and arm64 alike).
  const [on, off] = process.platform === "darwin" ? [0x20006601, 0x20006602] : [0x5451, 0x5450];
  libc = { pipe: (fds) => l.symbols.pipe(ptr(fds)), close: (fd) => l.symbols.close(fd), cloexec: (fd, set) => l.symbols.ioctl(fd, set ? on : off) };
  return libc;
}

/** The reader thread: blocking read(2) on one descriptor, each chunk posted back, then end-of-file. Inline, so the
 *  compiled daemon needs no extra entry point for it. */
const READER_SOURCE = `
const { readSync } = require("node:fs");
self.onmessage = (e) => {
  const fd = e.data.fd;
  const buf = Buffer.alloc(1 << 20);
  for (;;) {
    let n;
    try { n = readSync(fd, buf, 0, buf.length, null); }
    catch (err) { if (err && err.code === "EAGAIN") continue; self.postMessage({ error: String(err) }); return; }
    if (n === 0) { self.postMessage({ eof: true }); return; }
    self.postMessage({ chunk: new Uint8Array(buf.subarray(0, n)) });
  }
};`;

let readerUrl: string | undefined;
function readerWorker(): Worker {
  readerUrl ??= URL.createObjectURL(new Blob([READER_SOURCE], { type: "application/javascript" }));
  return new Worker(readerUrl);
}

/** Starts `bin` with fd 3 (our commands) and fd 4 (its answers); stdin and stdout ignored, stderr kept for errors. */
export async function spawnWithFdPipes(bin: string, args: string[], env?: Record<string, string>): Promise<{ process: BrowserProcess; pipe: PipeTransport }> {
  const c = await lib();
  const make = (): [number, number] => {
    const fds = new Int32Array(2);
    if (c.pipe(fds) !== 0) throw new Error("pipe() failed");
    for (const fd of fds) c.cloexec(fd, true);
    return [fds[0]!, fds[1]!];
  };
  const [childRead, ourWrite] = make();
  const [ourRead, childWrite] = make();
  // A child end that already IS its target number isn't duplicated, so it mustn't be close-on-exec itself.
  if (childRead === 3) c.cloexec(childRead, false);
  if (childWrite === 4) c.cloexec(childWrite, false);
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([bin, ...args], { stdio: ["ignore", "ignore", "pipe", childRead, childWrite], ...(env !== undefined ? { env } : {}) });
  } catch (e) {
    for (const fd of [childRead, ourWrite, ourRead, childWrite]) c.close(fd);
    throw e;
  }
  c.close(childRead);
  c.close(childWrite);

  let writeOpen = true;
  const closeWrite = (): void => {
    if (!writeOpen) return;
    writeOpen = false;
    c.close(ourWrite);
  };
  const listeners: Array<(chunk: Uint8Array) => void> = [];
  const closeListeners: Array<(why: string) => void> = [];
  let readDone = false;
  let readFdClosed = false;
  const worker = readerWorker();
  // The read end is closed only once the reader thread has returned from its last read(2): closing it under a blocked
  // read would free its number for the next pipe while the old read still runs.
  const closeReadFd = (): void => {
    if (readFdClosed) return;
    readFdClosed = true;
    try {
      worker.terminate();
    } catch {
      // Gone.
    }
    c.close(ourRead);
  };
  const endRead = (why: string): void => {
    if (readDone) return;
    readDone = true;
    for (const l of closeListeners) l(why);
  };
  worker.onmessage = (e: MessageEvent<{ chunk?: Uint8Array; eof?: boolean; error?: string }>) => {
    if (e.data.chunk !== undefined) {
      if (!readDone) for (const l of listeners) l(e.data.chunk);
      return;
    }
    closeReadFd();
    endRead(e.data.error ?? "the browser closed its end of the pipe");
  };
  worker.onerror = () => endRead("the pipe's reader failed");
  worker.postMessage({ fd: ourRead });
  // The worker's own message port keeps nothing alive: the browser's process does, and its exit ends the read.
  (worker as unknown as { unref(): void }).unref();

  const stderr: string[] = [];
  void (async () => {
    const dec = new TextDecoder();
    let partial = "";
    try {
      for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) {
        const lines = (partial + dec.decode(chunk, { stream: true })).split("\n");
        partial = lines.pop() ?? "";
        for (const line of lines) if (line.trim() !== "") stderr.push(line.slice(0, 300));
        if (stderr.length > 50) stderr.splice(0, stderr.length - 50);
      }
    } catch {
      // Gone.
    }
  })();

  const exited = proc.exited.then((code) => {
    // Its end of the answers pipe closed with it; the reader sees end-of-file (or is ended here, at the latest).
    setTimeout(() => endRead("the browser exited"), 2000).unref();
    closeWrite();
    return { code: proc.signalCode === null ? code : null, signal: proc.signalCode === null ? null : String(proc.signalCode) };
  });

  return {
    process: {
      pid: proc.pid,
      exited,
      kill: () => {
        try {
          proc.kill("SIGKILL");
        } catch {
          // Gone.
        }
      },
      stderrTail: (n = 8) => stderr.slice(-n).join(" | "),
    },
    pipe: {
      write(bytes) {
        if (!writeOpen) return false;
        try {
          for (let off = 0; off < bytes.length;) off += writeSync(ourWrite, bytes, off, bytes.length - off);
        } catch {
          closeWrite();
          return false;
        }
        return true;
      },
      onData(listener) {
        listeners.push(listener);
      },
      onClose(listener) {
        closeListeners.push(listener);
      },
      close() {
        closeWrite();
      },
    },
  };
}
