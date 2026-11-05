// Windows: the DevTools pipe as two anonymous pipes whose child ends the browser inherits, named to it with
// --remote-debugging-io-pipes=<read handle>,<write handle> (Chromium reads fds 3 and 4 only on POSIX; on Windows it
// wants raw handle values). Bun's spawn does not map extra stdio entries to the CRT descriptors Chromium would read,
// so the pipes are made here over kernel32 and the parent's ends are polled (PeekNamedPipe, then ReadFile of what is
// there, once per tick), which never blocks the event loop. Bun only (bun:ffi).
import { StringDecoder } from "node:string_decoder";

export interface WinPipes {
  /** Handle values for --remote-debugging-io-pipes. */
  readonly childRead: string;
  readonly childWrite: string;
  write(text: string): void;
  start(onData: (text: string) => void, onClose: () => void): void;
  /** Close the parent's copies of the child's ends (after the child has started). */
  closeChildEnds(): void;
  close(): void;
}

const HANDLE_FLAG_INHERIT = 1;
const ERROR_BROKEN_PIPE = 109;
const READ_MAX = 4 << 20;

export async function makeWinPipes(): Promise<WinPipes> {
  const { dlopen, FFIType, ptr } = await import("bun:ffi");
  const k32 = dlopen("kernel32.dll", {
    CreatePipe: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    SetHandleInformation: { args: [FFIType.u64, FFIType.u32, FFIType.u32], returns: FFIType.i32 },
    PeekNamedPipe: { args: [FFIType.u64, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    ReadFile: { args: [FFIType.u64, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    WriteFile: { args: [FFIType.u64, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
    GetLastError: { args: [], returns: FFIType.u32 },
  });
  const f = k32.symbols;
  // SECURITY_ATTRIBUTES on x64: nLength (u32), pad, lpSecurityDescriptor (ptr), bInheritHandle (u32), pad = 24 bytes
  const sa = Buffer.alloc(24);
  sa.writeUInt32LE(24, 0);
  sa.writeUInt32LE(1, 16);
  const pipe = (): [bigint, bigint] => {
    const r = Buffer.alloc(8), w = Buffer.alloc(8);
    if (f.CreatePipe(ptr(r), ptr(w), ptr(sa), 1 << 20) === 0) throw new Error(`CreatePipe failed: ${f.GetLastError()}`);
    return [r.readBigUInt64LE(0), w.readBigUInt64LE(0)];
  };
  const [childRead, parentWrite] = pipe(); // commands: we write, the browser reads
  const [parentRead, childWrite] = pipe(); // answers: the browser writes, we read
  f.SetHandleInformation(parentWrite, HANDLE_FLAG_INHERIT, 0);
  f.SetHandleInformation(parentRead, HANDLE_FLAG_INHERIT, 0);
  let timer: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  let childEndsOpen = true;
  let parentClosed = false;
  const avail = Buffer.alloc(4), done = Buffer.alloc(4);
  const decoder = new StringDecoder("utf8");
  const closeChildEnds = (): void => {
    if (!childEndsOpen) return;
    childEndsOpen = false;
    f.CloseHandle(childRead);
    f.CloseHandle(childWrite);
  };
  return {
    childRead: String(childRead),
    childWrite: String(childWrite),
    write(text) {
      const b = Buffer.from(`${text}\0`, "utf8");
      let off = 0;
      while (off < b.length) {
        if (f.WriteFile(parentWrite, ptr(b, off), b.length - off, ptr(done), null) === 0) throw new Error(`WriteFile failed: ${f.GetLastError()}`);
        off += done.readUInt32LE(0);
      }
    },
    start(onData, onClose) {
      // One read per tick, of at most READ_MAX: round two read in a loop while bytes were there, and a screencast
      // (a frame arriving while the last was decoded) kept that loop going for good, so no timer ever ran again.
      timer = setInterval(() => {
        if (closed) return;
        if (f.PeekNamedPipe(parentRead, null, 0, null, ptr(avail), null) === 0) {
          closed = true;
          if (timer !== undefined) clearInterval(timer);
          onClose();
          return;
        }
        const n = Math.min(avail.readUInt32LE(0), READ_MAX);
        if (n === 0) return;
        const buf = Buffer.alloc(n);
        if (f.ReadFile(parentRead, ptr(buf), n, ptr(done), null) === 0) {
          if (f.GetLastError() === ERROR_BROKEN_PIPE) { closed = true; if (timer !== undefined) clearInterval(timer); onClose(); }
          return;
        }
        onData(decoder.write(buf.subarray(0, done.readUInt32LE(0))));
      }, 4);
    },
    closeChildEnds,
    close() {
      if (timer !== undefined) clearInterval(timer);
      if (closed && !childEndsOpen && parentClosed) return;
      closed = true;
      closeChildEnds();
      if (parentClosed) return;
      parentClosed = true;
      f.CloseHandle(parentWrite);
      f.CloseHandle(parentRead);
    },
  };
}
