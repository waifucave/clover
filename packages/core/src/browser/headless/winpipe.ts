// Windows: the DevTools pipe as two anonymous pipes whose child ends the browser inherits, named to it with
// `--remote-debugging-io-pipes=<read handle>,<write handle>` (Chromium reads fds 3 and 4 only on POSIX; on Windows it
// wants handle values). Ported from spike S7's `winpipe.ts`, with its open items from "What M2's port needs", and L-M3's
// hardening:
// * The browser is started with `CreateProcessW` over bun:ffi, with an explicit handle list (`STARTUPINFOEX` and
//   `PROC_THREAD_ATTRIBUTE_HANDLE_LIST`), so it inherits the pipes' two ends and its error pipe's, and nothing else.
//   Those ends are created non-inheritable and are marked inheritable only across the one `CreateProcessW` call, then
//   made non-inheritable again and closed. A handle on the list must be inheritable when the call is made (Windows
//   refuses the list otherwise), so that stretch can't be removed, only shortened to two system calls on one thread
//   with nothing between them; the one thing it can't exclude is another thread of the daemon starting a process with
//   `bInheritHandles` in those microseconds (a duplicate would give it a pipe to the browser, which the daemon's own
//   allow list stands in front of). `Bun.spawn` takes no lock this file could share, so there is no cross-thread lock.
// * The browser is made in a SUSPENDED state, put in a job object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` and only then
//   resumed: it, and anything it starts, dies when the daemon does (the daemon's handle to the job closes with it), never
//   outliving it, and `kill()` ends the whole job.
// * The browser gets the minimal environment `windowsBrowserEnv` makes (never the daemon's own), as a Unicode block.
// * Its standard error is a pipe of its own, read on a worker thread, so a failed start says what the browser printed
//   (`stderrTail`), as on macOS and Linux.
// * Answers are read with a blocking `ReadFile` on a worker thread of its own, never by polling (the prototype's 4 ms
//   `PeekNamedPipe` loop woke the daemon 250 times a second, over its budget of 50). The same thread then waits for
//   the process to exit (`WaitForSingleObject`), so a browser costs no wake-ups at all while it is quiet.
// Bun only (bun:ffi).
import type { BrowserProcess, PipeTransport } from "./cdp";

const HANDLE_FLAG_INHERIT = 0x1;
const STARTF_USESTDHANDLES = 0x100;
const EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
const CREATE_NO_WINDOW = 0x08000000;
const CREATE_SUSPENDED = 0x4;
const CREATE_UNICODE_ENVIRONMENT = 0x400;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9;
const PROC_THREAD_ATTRIBUTE_HANDLE_LIST = 0x20002n;

/** One argument as `CommandLineToArgvW` (and the CRT) read it back. Pure. */
export function quoteWindowsArg(arg: string): string {
  if (arg !== "" && !/[ \t\n\v"]/.test(arg)) return arg;
  let out = '"';
  let slashes = 0;
  for (const ch of arg) {
    if (ch === "\\") {
      slashes++;
      continue;
    }
    if (ch === '"') {
      out += `${"\\".repeat(slashes * 2 + 1)}"`;
    } else {
      out += `${"\\".repeat(slashes)}${ch}`;
    }
    slashes = 0;
  }
  return `${out}${"\\".repeat(slashes * 2)}"`;
}

/** An environment as `CreateProcessW` wants it with `CREATE_UNICODE_ENVIRONMENT`: `NAME=value` entries sorted by name
 *  (case-insensitively, as Windows sorts them), each ended by a NUL, and one more NUL at the end. Pure. */
export function windowsEnvBlock(env: Record<string, string>): Buffer {
  const names = Object.keys(env).sort((a, b) => {
    const x = a.toUpperCase();
    const y = b.toUpperCase();
    return x < y ? -1 : x > y ? 1 : 0;
  });
  for (const name of names) {
    if (name === "" || name.includes("=") || name.includes("\0") || env[name]!.includes("\0")) throw new Error(`the browser's environment has a bad entry: ${JSON.stringify(name)}`);
  }
  return Buffer.from(`${names.map((n) => `${n}=${env[n]}\0`).join("")}\0`, "utf16le");
}

/** The error pipe's reader thread: blocking `ReadFile` until the pipe breaks. */
const STDERR_SOURCE = `
self.onmessage = async (e) => {
  const { dlopen, FFIType, ptr } = await import("bun:ffi");
  const k = dlopen("kernel32.dll", {
    ReadFile: { args: [FFIType.u64, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  }).symbols;
  const read = BigInt(e.data.read);
  const buf = new Uint8Array(1 << 16), got = new Uint32Array(1);
  while (k.ReadFile(read, ptr(buf), buf.length, ptr(got), null) !== 0) {
    if (got[0] > 0) self.postMessage({ chunk: buf.slice(0, got[0]) });
  }
  self.postMessage({ eof: true });
};`;

/** The reader thread: blocking `ReadFile` until the pipe breaks, then the process's exit code. Inline, so the compiled
 *  daemon needs no extra entry point for it. */
const READER_SOURCE = `
self.onmessage = async (e) => {
  const { dlopen, FFIType, ptr } = await import("bun:ffi");
  const k = dlopen("kernel32.dll", {
    ReadFile: { args: [FFIType.u64, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    GetLastError: { args: [], returns: FFIType.u32 },
    WaitForSingleObject: { args: [FFIType.u64, FFIType.u32], returns: FFIType.u32 },
    GetExitCodeProcess: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
  }).symbols;
  const read = BigInt(e.data.read), proc = BigInt(e.data.process);
  const buf = new Uint8Array(1 << 20), got = new Uint32Array(1);
  for (;;) {
    if (k.ReadFile(read, ptr(buf), buf.length, ptr(got), null) === 0) { self.postMessage({ eof: true, error: k.GetLastError() }); break; }
    if (got[0] > 0) self.postMessage({ chunk: buf.slice(0, got[0]) });
  }
  k.WaitForSingleObject(proc, 0xffffffff);
  const code = new Uint32Array(1);
  k.GetExitCodeProcess(proc, ptr(code));
  self.postMessage({ exit: code[0] });
};`;

let readerUrl: string | undefined;
let stderrUrl: string | undefined;

export async function spawnWithWinPipes(bin: string, args: string[], env?: Record<string, string>): Promise<{ process: BrowserProcess; pipe: PipeTransport }> {
  const { dlopen, FFIType, ptr } = await import("bun:ffi");
  const k32 = dlopen("kernel32.dll", {
    CreatePipe: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    SetHandleInformation: { args: [FFIType.u64, FFIType.u32, FFIType.u32], returns: FFIType.i32 },
    InitializeProcThreadAttributeList: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
    UpdateProcThreadAttribute: { args: [FFIType.ptr, FFIType.u32, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    DeleteProcThreadAttributeList: { args: [FFIType.ptr], returns: FFIType.void },
    CreateProcessW: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.i32, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    TerminateProcess: { args: [FFIType.u64, FFIType.u32], returns: FFIType.i32 },
    CreateJobObjectW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.u64 },
    SetInformationJobObject: { args: [FFIType.u64, FFIType.u32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    AssignProcessToJobObject: { args: [FFIType.u64, FFIType.u64], returns: FFIType.i32 },
    TerminateJobObject: { args: [FFIType.u64, FFIType.u32], returns: FFIType.i32 },
    ResumeThread: { args: [FFIType.u64], returns: FFIType.u32 },
    WriteFile: { args: [FFIType.u64, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
    GetLastError: { args: [], returns: FFIType.u32 },
  });
  const f = k32.symbols;
  // SECURITY_ATTRIBUTES on x64 (nLength, pad, lpSecurityDescriptor, bInheritHandle, pad): not inheritable.
  const sa = Buffer.alloc(24);
  sa.writeUInt32LE(24, 0);
  const pipe = (): [bigint, bigint] => {
    const r = Buffer.alloc(8);
    const w = Buffer.alloc(8);
    if (f.CreatePipe(ptr(r), ptr(w), ptr(sa), 1 << 20) === 0) throw new Error(`CreatePipe failed: ${f.GetLastError()}`);
    return [r.readBigUInt64LE(0), w.readBigUInt64LE(0)];
  };
  const [childRead, ourWrite] = pipe(); // commands: we write, the browser reads
  const [ourRead, childWrite] = pipe(); // answers: the browser writes, we read
  const [ourErr, childErr] = pipe(); // its standard error: the browser writes, we read
  const closeAll = (): void => {
    for (const h of [childRead, ourWrite, ourRead, childWrite, ourErr, childErr]) f.CloseHandle(h);
  };
  // The job the browser runs in: everything in it is killed when the last handle to it closes (ours, or the daemon's
  // death).
  const job = f.CreateJobObjectW(null, null);
  if (job === 0n) {
    closeAll();
    throw new Error(`CreateJobObjectW failed: ${f.GetLastError()}`);
  }
  const limits = Buffer.alloc(144); // JOBOBJECT_EXTENDED_LIMIT_INFORMATION on x64; BasicLimitInformation.LimitFlags at 16
  limits.writeUInt32LE(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, 16);
  if (f.SetInformationJobObject(job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, ptr(limits), limits.length) === 0) {
    const err = f.GetLastError();
    f.CloseHandle(job);
    closeAll();
    throw new Error(`SetInformationJobObject failed: ${err}`);
  }

  const command = [bin, "--remote-debugging-pipe", `--remote-debugging-io-pipes=${childRead},${childWrite}`, ...args].map(quoteWindowsArg).join(" ");
  const cmdline = Buffer.from(`${command}\0`, "utf16le");
  const envBlock = env !== undefined ? windowsEnvBlock(env) : undefined;
  // The attribute list naming the two handles the browser may inherit.
  const sizeBuf = Buffer.alloc(8);
  f.InitializeProcThreadAttributeList(null, 1, 0, ptr(sizeBuf));
  const attrList = Buffer.alloc(Number(sizeBuf.readBigUInt64LE(0)));
  if (f.InitializeProcThreadAttributeList(ptr(attrList), 1, 0, ptr(sizeBuf)) === 0) {
    f.CloseHandle(job);
    closeAll();
    throw new Error(`InitializeProcThreadAttributeList failed: ${f.GetLastError()}`);
  }
  const handles = Buffer.alloc(24);
  handles.writeBigUInt64LE(childRead, 0);
  handles.writeBigUInt64LE(childWrite, 8);
  handles.writeBigUInt64LE(childErr, 16);
  try {
    if (f.UpdateProcThreadAttribute(ptr(attrList), 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, ptr(handles), 24n, null, null) === 0) {
      throw new Error(`UpdateProcThreadAttribute failed: ${f.GetLastError()}`);
    }
    // STARTUPINFOEXW on x64: STARTUPINFOW (104 bytes) and lpAttributeList at 104.
    const si = Buffer.alloc(112);
    si.writeUInt32LE(112, 0); // cb
    si.writeUInt32LE(STARTF_USESTDHANDLES, 60); // dwFlags; hStdInput and hStdOutput (80, 88) stay null
    si.writeBigUInt64LE(childErr, 96); // hStdError
    si.writeBigUInt64LE(BigInt(ptr(attrList)), 104);
    const pi = Buffer.alloc(24); // hProcess, hThread, dwProcessId, dwThreadId
    // Inheritable only for this call: the handle list keeps every other handle out of the browser, and nothing else
    // runs on this thread meanwhile.
    f.SetHandleInformation(childRead, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
    f.SetHandleInformation(childWrite, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
    f.SetHandleInformation(childErr, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
    const ok = f.CreateProcessW(
      null, ptr(cmdline), null, null, 1,
      EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW | CREATE_SUSPENDED | (envBlock !== undefined ? CREATE_UNICODE_ENVIRONMENT : 0),
      envBlock !== undefined ? ptr(envBlock) : null, null, ptr(si), ptr(pi),
    );
    const err = f.GetLastError();
    f.SetHandleInformation(childRead, HANDLE_FLAG_INHERIT, 0);
    f.SetHandleInformation(childWrite, HANDLE_FLAG_INHERIT, 0);
    f.SetHandleInformation(childErr, HANDLE_FLAG_INHERIT, 0);
    if (ok === 0) throw new Error(`the browser didn't start (CreateProcessW: ${err})`);
    const hProcess = pi.readBigUInt64LE(0);
    const hThread = pi.readBigUInt64LE(8);
    // In the job before it runs a single instruction, so it never exists outside it.
    if (f.AssignProcessToJobObject(job, hProcess) === 0 || f.ResumeThread(hThread) === 0xffffffff) {
      const why = f.GetLastError();
      f.TerminateProcess(hProcess, 1);
      f.CloseHandle(hThread);
      f.CloseHandle(hProcess);
      throw new Error(`the browser couldn't be put in its job (error ${why})`);
    }
    f.CloseHandle(childRead);
    f.CloseHandle(childWrite);
    f.CloseHandle(childErr);
    f.CloseHandle(hThread);
    return started(hProcess, pi.readUInt32LE(16));
  } catch (e) {
    f.CloseHandle(job);
    closeAll();
    throw e;
  } finally {
    f.DeleteProcThreadAttributeList(ptr(attrList));
  }

  function started(hProcess: bigint, pid: number): { process: BrowserProcess; pipe: PipeTransport } {
    let writeOpen = true;
    let exitCode: number | undefined;
    const listeners: Array<(chunk: Uint8Array) => void> = [];
    const closeListeners: Array<(why: string) => void> = [];
    let readDone = false;
    let resolveExit!: (v: { code: number | null; signal: string | null }) => void;
    const exited = new Promise<{ code: number | null; signal: string | null }>((r) => (resolveExit = r));
    const closeWrite = (): void => {
      if (!writeOpen) return;
      writeOpen = false;
      f.CloseHandle(ourWrite);
    };
    // Its error output: lines kept for a failed start's message.
    const stderr: string[] = [];
    let partial = "";
    const dec = new TextDecoder();
    stderrUrl ??= URL.createObjectURL(new Blob([STDERR_SOURCE], { type: "application/javascript" }));
    const errWorker = new Worker(stderrUrl);
    errWorker.onmessage = (e: MessageEvent<{ chunk?: Uint8Array; eof?: boolean }>) => {
      if (e.data.chunk !== undefined) {
        const lines = (partial + dec.decode(e.data.chunk, { stream: true })).split("\n");
        partial = lines.pop() ?? "";
        for (const line of lines) if (line.trim() !== "") stderr.push(line.trim().slice(0, 300));
        if (stderr.length > 50) stderr.splice(0, stderr.length - 50);
      } else {
        // The pipe is broken (the browser and all it started are gone): the thread is done with the handle.
        if (partial.trim() !== "") stderr.push(partial.trim().slice(0, 300));
        partial = "";
        errWorker.terminate();
        f.CloseHandle(ourErr);
      }
    };
    errWorker.postMessage({ read: String(ourErr) });
    (errWorker as unknown as { unref(): void }).unref();
    readerUrl ??= URL.createObjectURL(new Blob([READER_SOURCE], { type: "application/javascript" }));
    const worker = new Worker(readerUrl);
    const endRead = (why: string): void => {
      if (readDone) return;
      readDone = true;
      for (const l of closeListeners) l(why);
    };
    worker.onmessage = (e: MessageEvent<{ chunk?: Uint8Array; eof?: boolean; error?: number; exit?: number }>) => {
      if (e.data.chunk !== undefined) {
        if (!readDone) for (const l of listeners) l(e.data.chunk);
      } else if (e.data.eof === true) {
        endRead("the browser closed its end of the pipe");
      } else if (e.data.exit !== undefined) {
        // The thread is done with both handles.
        exitCode = e.data.exit;
        f.CloseHandle(ourRead);
        f.CloseHandle(hProcess);
        // The last handle to the job: whatever the browser started and left behind dies with it, which also breaks
        // the error pipe, so its reader finishes.
        f.CloseHandle(job);
        closeWrite();
        worker.terminate();
        resolveExit({ code: exitCode, signal: null });
      }
    };
    worker.onerror = () => endRead("the pipe's reader failed");
    worker.postMessage({ read: String(ourRead), process: String(hProcess) });
    (worker as unknown as { unref(): void }).unref();
    return {
      process: {
        pid,
        exited,
        kill: () => {
          if (exitCode === undefined) f.TerminateJobObject(job, 1);
        },
        stderrTail: (n = 8) => stderr.slice(-n).join(" | "),
      },
      pipe: {
        write(bytes) {
          if (!writeOpen) return false;
          const done = Buffer.alloc(4);
          const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
          let off = 0;
          while (off < b.length) {
            if (f.WriteFile(ourWrite, ptr(b, off), b.length - off, ptr(done), null) === 0) {
              closeWrite();
              return false;
            }
            off += done.readUInt32LE(0);
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
}
