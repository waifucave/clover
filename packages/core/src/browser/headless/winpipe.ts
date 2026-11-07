// Windows: the DevTools pipe as two anonymous pipes whose child ends the browser inherits, named to it with
// `--remote-debugging-io-pipes=<read handle>,<write handle>` (Chromium reads fds 3 and 4 only on POSIX; on Windows it
// wants handle values). Ported from spike S7's `winpipe.ts`, with its two open items from "What M2's port needs":
// * The browser is started with `CreateProcessW` over bun:ffi, with an explicit handle list (`STARTUPINFOEX` and
//   `PROC_THREAD_ATTRIBUTE_HANDLE_LIST`), so it inherits those two handles and nothing else. The child's ends are made
//   non-inheritable and are marked inheritable only for the synchronous stretch around that one call, then closed, so
//   a process the daemon starts another way (`Bun.spawn` inherits every inheritable handle) can't take one either,
//   unless another thread spawns within those microseconds (the daemon's own workers could; lane C's fence denies a
//   fenced process access to other processes' handles in any case).
// * Answers are read with a blocking `ReadFile` on a worker thread of its own, never by polling (the prototype's 4 ms
//   `PeekNamedPipe` loop woke the daemon 250 times a second, over its budget of 50). The same thread then waits for
//   the process to exit (`WaitForSingleObject`), so a browser costs no wake-ups at all while it is quiet.
// The browser gets no standard handles: on Windows its error output isn't kept (a failed start says its exit code).
// Bun only (bun:ffi).
import type { BrowserProcess, PipeTransport } from "./cdp";

const HANDLE_FLAG_INHERIT = 0x1;
const STARTF_USESTDHANDLES = 0x100;
const EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
const CREATE_NO_WINDOW = 0x08000000;
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

export async function spawnWithWinPipes(bin: string, args: string[]): Promise<{ process: BrowserProcess; pipe: PipeTransport }> {
  const { dlopen, FFIType, ptr } = await import("bun:ffi");
  const k32 = dlopen("kernel32.dll", {
    CreatePipe: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    SetHandleInformation: { args: [FFIType.u64, FFIType.u32, FFIType.u32], returns: FFIType.i32 },
    InitializeProcThreadAttributeList: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
    UpdateProcThreadAttribute: { args: [FFIType.ptr, FFIType.u32, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    DeleteProcThreadAttributeList: { args: [FFIType.ptr], returns: FFIType.void },
    CreateProcessW: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.i32, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    TerminateProcess: { args: [FFIType.u64, FFIType.u32], returns: FFIType.i32 },
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
  const closeAll = (): void => {
    for (const h of [childRead, ourWrite, ourRead, childWrite]) f.CloseHandle(h);
  };

  const command = [bin, "--remote-debugging-pipe", `--remote-debugging-io-pipes=${childRead},${childWrite}`, ...args].map(quoteWindowsArg).join(" ");
  const cmdline = Buffer.from(`${command}\0`, "utf16le");
  // The attribute list naming the two handles the browser may inherit.
  const sizeBuf = Buffer.alloc(8);
  f.InitializeProcThreadAttributeList(null, 1, 0, ptr(sizeBuf));
  const attrList = Buffer.alloc(Number(sizeBuf.readBigUInt64LE(0)));
  if (f.InitializeProcThreadAttributeList(ptr(attrList), 1, 0, ptr(sizeBuf)) === 0) {
    closeAll();
    throw new Error(`InitializeProcThreadAttributeList failed: ${f.GetLastError()}`);
  }
  const handles = Buffer.alloc(16);
  handles.writeBigUInt64LE(childRead, 0);
  handles.writeBigUInt64LE(childWrite, 8);
  try {
    if (f.UpdateProcThreadAttribute(ptr(attrList), 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, ptr(handles), 16n, null, null) === 0) {
      throw new Error(`UpdateProcThreadAttribute failed: ${f.GetLastError()}`);
    }
    // STARTUPINFOEXW on x64: STARTUPINFOW (104 bytes) and lpAttributeList at 104.
    const si = Buffer.alloc(112);
    si.writeUInt32LE(112, 0); // cb
    si.writeUInt32LE(STARTF_USESTDHANDLES, 60); // dwFlags; hStdInput, hStdOutput, hStdError (80, 88, 96) stay null
    si.writeBigUInt64LE(BigInt(ptr(attrList)), 104);
    const pi = Buffer.alloc(24); // hProcess, hThread, dwProcessId, dwThreadId
    // Inheritable only for this call: the handle list keeps every other handle out of the browser, and nothing else
    // runs on this thread meanwhile.
    f.SetHandleInformation(childRead, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
    f.SetHandleInformation(childWrite, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
    const ok = f.CreateProcessW(null, ptr(cmdline), null, null, 1, EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW, null, null, ptr(si), ptr(pi));
    const err = f.GetLastError();
    f.SetHandleInformation(childRead, HANDLE_FLAG_INHERIT, 0);
    f.SetHandleInformation(childWrite, HANDLE_FLAG_INHERIT, 0);
    if (ok === 0) throw new Error(`the browser didn't start (CreateProcessW: ${err})`);
    f.CloseHandle(childRead);
    f.CloseHandle(childWrite);
    f.CloseHandle(pi.readBigUInt64LE(8)); // the thread
    return started(pi.readBigUInt64LE(0), pi.readUInt32LE(16));
  } catch (e) {
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
          if (exitCode === undefined) f.TerminateProcess(hProcess, 1);
        },
        stderrTail: () => "",
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
