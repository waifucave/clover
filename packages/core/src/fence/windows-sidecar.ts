// The link sidecar on Windows (the controller's ruling on C-M3 item 4): until Bash's sandbox principal lands (#207,
// after C-M2 part 2), when the sidecar runs under it, it runs as the user but reduced:
//   * a restricted token: every privilege but change-notify removed (`DISABLE_MAX_PRIVILEGE`), Administrators a
//     deny-only group, and restricting SIDs (the user, the logon session,
//     Everyone, Users), so a second access check leaves Administrators and every other group out;
//   * low integrity (S-1-16-4096): it can write nothing the user's medium-integrity files and processes hold;
//   * a kill-on-close Job Object holding only it (one active process: it can start nothing; every UI restriction),
//     which the daemon holds
//     open, so the sidecar dies with the daemon however the daemon ends; started suspended and resumed only once in
//     the job;
//   * only its three pipes inherited (`PROC_THREAD_ATTRIBUTE_HANDLE_LIST`), the stripped environment (`sidecarEnv`),
//     no window.
// Its stdin, stdout and stderr are three named pipes with random names that the daemon serves (node:net) and opens
// the child's ends of itself (`CreateFileW`); each end first writes a random nonce the daemon checks, so a connection
// that isn't its own is dropped. Win32 through bun:ffi; only loaded on Windows.
import { randomBytes } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { sidecarEnv, type SidecarProcess } from "../links/sidecar-wire";

const GENERIC_READ = 0x80000000;
const GENERIC_WRITE = 0x40000000;
const OPEN_EXISTING = 3;
const TOKEN_DUPLICATE = 0x0002, TOKEN_ASSIGN_PRIMARY = 0x0001, TOKEN_QUERY = 0x0008, TOKEN_ADJUST_DEFAULT = 0x0080;
const DISABLE_MAX_PRIVILEGE = 0x1;
const SE_GROUP_INTEGRITY = 0x20;
const TOKEN_INTEGRITY_LEVEL = 25;
const TOKEN_USER = 1, TOKEN_GROUPS = 2, TOKEN_DEFAULT_DACL = 6;
const SE_GROUP_LOGON_ID = 0xc0000000;
const HANDLE_FLAG_INHERIT = 1;
const JOB_OBJECT_BASIC_UI_RESTRICTIONS = 4, JOB_OBJECT_UILIMIT_ALL = 0xff;
const CREATE_SUSPENDED = 0x4, CREATE_NO_WINDOW = 0x08000000, EXTENDED_STARTUPINFO_PRESENT = 0x00080000, CREATE_UNICODE_ENVIRONMENT = 0x400;
const STARTF_USESTDHANDLES = 0x100;
const PROC_THREAD_ATTRIBUTE_HANDLE_LIST = 0x20002;
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9;
const JOB_OBJECT_LIMIT_ACTIVE_PROCESS = 0x8, JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION = 0x400, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
const STILL_ACTIVE = 259;
const NONCE_BYTES = 16;

/** The SIDs: Administrators, and the low mandatory level. */
export const ADMINISTRATORS_SID = "S-1-5-32-544";
export const LOW_INTEGRITY_SID = "S-1-16-4096";
export const EVERYONE_SID = "S-1-1-0";
export const USERS_SID = "S-1-5-32-545";

type Win = ReturnType<typeof loadWin32>;
let win: Win | undefined;

function loadWin32() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { dlopen, FFIType: T } = require("bun:ffi") as typeof import("bun:ffi");
  const k = dlopen("kernel32.dll", {
    CreateFileW: { args: [T.ptr, T.u32, T.u32, T.ptr, T.u32, T.u32, T.i64], returns: T.i64 },
    CloseHandle: { args: [T.i64], returns: T.i32 },
    WriteFile: { args: [T.i64, T.ptr, T.u32, T.ptr, T.ptr], returns: T.i32 },
    CreateJobObjectW: { args: [T.ptr, T.ptr], returns: T.i64 },
    SetInformationJobObject: { args: [T.i64, T.i32, T.ptr, T.u32], returns: T.i32 },
    AssignProcessToJobObject: { args: [T.i64, T.i64], returns: T.i32 },
    TerminateJobObject: { args: [T.i64, T.u32], returns: T.i32 },
    ResumeThread: { args: [T.i64], returns: T.u32 },
    TerminateProcess: { args: [T.i64, T.u32], returns: T.i32 },
    GetExitCodeProcess: { args: [T.i64, T.ptr], returns: T.i32 },
    GetCurrentProcess: { args: [], returns: T.i64 },
    InitializeProcThreadAttributeList: { args: [T.ptr, T.u32, T.u32, T.ptr], returns: T.i32 },
    UpdateProcThreadAttribute: { args: [T.ptr, T.u32, T.u64, T.ptr, T.u64, T.ptr, T.ptr], returns: T.i32 },
    DeleteProcThreadAttributeList: { args: [T.ptr], returns: T.void },
    GetLastError: { args: [], returns: T.u32 },
    LocalFree: { args: [T.i64], returns: T.i64 },
    SetHandleInformation: { args: [T.i64, T.u32, T.u32], returns: T.i32 },
  });
  const a = dlopen("advapi32.dll", {
    OpenProcessToken: { args: [T.i64, T.u32, T.ptr], returns: T.i32 },
    CreateRestrictedToken: { args: [T.i64, T.u32, T.u32, T.ptr, T.u32, T.ptr, T.u32, T.ptr, T.ptr], returns: T.i32 },
    ConvertStringSidToSidW: { args: [T.ptr, T.ptr], returns: T.i32 },
    GetLengthSid: { args: [T.i64], returns: T.u32 },
    SetTokenInformation: { args: [T.i64, T.i32, T.ptr, T.u32], returns: T.i32 },
    GetTokenInformation: { args: [T.i64, T.i32, T.ptr, T.u32, T.ptr], returns: T.i32 },
    ConvertSidToStringSidW: { args: [T.i64, T.ptr], returns: T.i32 },
    ConvertStringSecurityDescriptorToSecurityDescriptorW: { args: [T.ptr, T.u32, T.ptr, T.ptr], returns: T.i32 },
    GetSecurityDescriptorDacl: { args: [T.i64, T.ptr, T.ptr, T.ptr], returns: T.i32 },
    CreateProcessAsUserW: { args: [T.i64, T.ptr, T.ptr, T.ptr, T.ptr, T.i32, T.u32, T.ptr, T.ptr, T.ptr, T.ptr], returns: T.i32 },
  });
  const ffi = require("bun:ffi") as typeof import("bun:ffi");
  return { k: k.symbols, a: a.symbols, ptr: ffi.ptr, toArrayBuffer: ffi.toArrayBuffer };
}

const w16 = (s: string) => Buffer.from(`${s}\0`, "utf16le");
const big = (v: number | bigint) => BigInt(v);

function fail(what: string): never {
  throw new Error(`the link sidecar couldn't start reduced: ${what} failed (error ${win!.k.GetLastError()})`);
}

/** A string SID as a pointer the system allocated (`LocalFree` it). */
function sidOf(s: string): bigint {
  const out = new BigUint64Array(1);
  if (!win!.a.ConvertStringSidToSidW(w16(s), out)) fail(`ConvertStringSidToSidW(${s})`);
  return out[0]!;
}

/** A token information class of `token`, as the buffer the system filled (its SID pointers point into it). */
function tokenInfo(token: bigint, cls: number): Buffer {
  const { a } = win!;
  const need = new Uint32Array(1);
  a.GetTokenInformation(token, cls, null, 0, need);
  const buf = Buffer.alloc(need[0]! || 4096);
  if (!a.GetTokenInformation(token, cls, buf, buf.length, need)) fail(`GetTokenInformation(${cls})`);
  return buf;
}

/** The restricting SIDs: the user, the logon session, Everyone and Users. A second access check runs against only
 *  these, so Administrators (and every other group) drops out of it: the sidecar reaches only what one of these may.
 *  The buffers the SIDs point into are returned to be kept alive until the token is made. */
function restrictingSids(own: bigint): { list: Buffer; keep: Buffer[]; free: bigint[] } {
  const user = tokenInfo(own, TOKEN_USER);
  const groups = tokenInfo(own, TOKEN_GROUPS);
  const sids: bigint[] = [user.readBigUInt64LE(0)];
  const count = groups.readUInt32LE(0);
  for (let i = 0; i < count; i++) {
    const at = 8 + i * 16;
    if (((groups.readUInt32LE(at + 8) & SE_GROUP_LOGON_ID) >>> 0) === SE_GROUP_LOGON_ID) sids.push(groups.readBigUInt64LE(at));
  }
  const free = [EVERYONE_SID, USERS_SID].map(sidOf);
  sids.push(...free);
  const list = Buffer.alloc(16 * sids.length);
  sids.forEach((sid, i) => list.writeBigUInt64LE(sid, i * 16));
  return { list, keep: [user, groups], free };
}

/** The token's user as a string SID. */
function userSidString(own: bigint): string {
  const { a, k, toArrayBuffer } = win!;
  const user = tokenInfo(own, TOKEN_USER);
  const out = new BigUint64Array(1);
  if (!a.ConvertSidToStringSidW(user.readBigUInt64LE(0), out)) fail("ConvertSidToStringSidW");
  try {
    const bytes = Buffer.from(toArrayBuffer(Number(out[0]!) as never, 0, 2 * 184));
    return bytes.toString("utf16le").split("\0")[0]!;
  } finally {
    k.LocalFree(out[0]!);
  }
}

/** The default DACL the sidecar's own objects (its process, its threads) are made with: the user and SYSTEM (the user's
 *  SID is in the restricting list, so the sidecar reaches its own objects through it).
 *  An elevated token's default DACL names only Administrators and SYSTEM, which the restricting check doesn't take, so
 *  the child couldn't open its own process and died initialising (measured on the Windows VM). */
function setDefaultDacl(token: bigint, own: bigint): void {
  const { a, k } = win!;
  const sd = new BigUint64Array(1);
  if (!a.ConvertStringSecurityDescriptorToSecurityDescriptorW(w16(`D:(A;;GA;;;${userSidString(own)})(A;;GA;;;SY)`), 1, sd, null)) fail("ConvertStringSecurityDescriptorToSecurityDescriptorW");
  try {
    const present = new Uint32Array(1), dacl = new BigUint64Array(1), defaulted = new Uint32Array(1);
    if (!a.GetSecurityDescriptorDacl(sd[0]!, present, dacl, defaulted) || !present[0]) fail("GetSecurityDescriptorDacl");
    const info = Buffer.alloc(8); // TOKEN_DEFAULT_DACL { PACL }
    info.writeBigUInt64LE(dacl[0]!, 0);
    if (!a.SetTokenInformation(token, TOKEN_DEFAULT_DACL, info, 8)) fail("SetTokenInformation(default DACL)");
  } finally {
    k.LocalFree(sd[0]!);
  }
}

/** The daemon's own token, restricted (no privileges, Administrators deny-only, the restricting SIDs) and at low
 *  integrity, its default DACL the sidecar's own (`setDefaultDacl`). Measured on the Windows VM from an elevated daemon
 *  (over SSH): without that default DACL the child died initialising (STATUS_DLL_INIT_FAILED) under Administrators
 *  deny-only or the restricting SIDs, as it couldn't open its own process; with it, both hold and it links. */
function reducedToken(lowIntegrity = true, restrict = true, restricting = true): bigint {
  const { k, a } = win!;
  const own = new BigUint64Array(1);
  if (!a.OpenProcessToken(k.GetCurrentProcess(), TOKEN_DUPLICATE | TOKEN_ASSIGN_PRIMARY | TOKEN_QUERY | TOKEN_ADJUST_DEFAULT, own)) fail("OpenProcessToken");
  const admins = sidOf(ADMINISTRATORS_SID);
  const low = sidOf(LOW_INTEGRITY_SID);
  try {
    const disable = Buffer.alloc(16); // SID_AND_ATTRIBUTES { PSID, DWORD }
    disable.writeBigUInt64LE(admins, 0);
    const restricted = new BigUint64Array(1);
    const off = restrict;
    const r = restrict && restricting ? restrictingSids(own[0]!) : undefined;
    const made = a.CreateRestrictedToken(own[0]!, restrict ? DISABLE_MAX_PRIVILEGE : 0, off ? 1 : 0, off ? disable : null, 0, null,
      r === undefined ? 0 : r.list.length / 16, r === undefined ? null : r.list, restricted);
    if (r !== undefined) { for (const f of r.free) k.LocalFree(f); void r.keep; }
    if (!made) fail("CreateRestrictedToken");
    if (restrict) setDefaultDacl(restricted[0]!, own[0]!);
    if (!lowIntegrity) return restricted[0]!;
    const label = Buffer.alloc(16); // TOKEN_MANDATORY_LABEL { SID_AND_ATTRIBUTES }
    label.writeBigUInt64LE(low, 0);
    label.writeUInt32LE(SE_GROUP_INTEGRITY, 8);
    if (!a.SetTokenInformation(restricted[0]!, TOKEN_INTEGRITY_LEVEL, label, 16 + a.GetLengthSid(low))) {
      k.CloseHandle(restricted[0]!);
      fail("SetTokenInformation(low integrity)");
    }
    return restricted[0]!;
  } finally {
    k.LocalFree(admins);
    k.LocalFree(low);
    k.CloseHandle(own[0]!);
  }
}

/** A kill-on-close job that holds one process and lets it start none. */
function killOnCloseJob(): bigint {
  const { k } = win!;
  const job = big(k.CreateJobObjectW(null, null));
  if (job === 0n) fail("CreateJobObjectW");
  const info = Buffer.alloc(144); // JOBOBJECT_EXTENDED_LIMIT_INFORMATION
  info.writeUInt32LE(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION | JOB_OBJECT_LIMIT_ACTIVE_PROCESS, 16);
  info.writeUInt32LE(1, 40); // ActiveProcessLimit
  if (!k.SetInformationJobObject(job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, info, info.length)) {
    k.CloseHandle(job);
    fail("SetInformationJobObject");
  }
  // No clipboard, desktop, global atoms, system settings, display settings, exit, or other processes' user handles.
  const ui = new Uint32Array([JOB_OBJECT_UILIMIT_ALL]);
  if (!k.SetInformationJobObject(job, JOB_OBJECT_BASIC_UI_RESTRICTIONS, ui, 4)) {
    k.CloseHandle(job);
    fail("SetInformationJobObject(UI restrictions)");
  }
  return job;
}

/** One pipe the daemon serves and the child's end it opens itself, inheritable, the nonce already sent. */
async function pipeEnd(direction: "to-child" | "from-child"): Promise<{ handle: bigint; socket: Promise<Socket>; server: Server }> {
  const { k } = win!;
  const name = `\\\\.\\pipe\\clover-link-${randomBytes(16).toString("hex")}`;
  const nonce = randomBytes(NONCE_BYTES);
  const server = createServer();
  const socket = new Promise<Socket>((resolve, reject) => {
    server.on("connection", (s) => {
      let got = Buffer.alloc(0);
      const take = (chunk: Buffer) => {
        got = Buffer.concat([got, chunk]);
        if (got.length < NONCE_BYTES) return;
        s.off("data", take);
        if (!got.subarray(0, NONCE_BYTES).equals(nonce)) { s.destroy(); return; }
        server.close();
        s.pause();
        if (got.length > NONCE_BYTES) s.unshift(got.subarray(NONCE_BYTES));
        resolve(s);
      };
      s.on("data", take);
    });
    server.on("error", reject);
  });
  await new Promise<void>((resolve, reject) => server.listen(name, resolve).once("error", reject));
  // Not inheritable: made so only around the child's creation (`startReducedSidecar`), so no other process the daemon
  // starts meanwhile can take it.
  // The nonce goes first from the child's end, whichever way the pipe is used after it.
  const handle = big(k.CreateFileW(w16(name), GENERIC_READ | GENERIC_WRITE, 0, null, OPEN_EXISTING, 0, 0n));
  if (handle === -1n || handle === 0n) { server.close(); fail(`CreateFileW(${direction} pipe)`); }
  const wrote = new Uint32Array(1);
  if (!k.WriteFile(handle, nonce, NONCE_BYTES, wrote, null) || wrote[0] !== NONCE_BYTES) { k.CloseHandle(handle); server.close(); fail("WriteFile(nonce)"); }
  return { handle, socket, server };
}

/** A command line for CreateProcess: each argument quoted as the C runtime parses them. */
export function windowsCommandLine(argv: readonly string[]): string {
  return argv.map((arg) => {
    if (arg !== "" && !/[\s"]/.test(arg)) return arg;
    let out = '"';
    let slashes = 0;
    for (const c of arg) {
      if (c === "\\") { slashes++; continue; }
      if (c === '"') { out += "\\".repeat(slashes * 2 + 1) + '"'; slashes = 0; continue; }
      out += "\\".repeat(slashes) + c;
      slashes = 0;
    }
    return `${out}${"\\".repeat(slashes * 2)}"`;
  }).join(" ");
}

/** An environment block: `K=V\0…\0\0`, sorted as Windows wants it. */
export function windowsEnvBlock(env: Record<string, string>): Buffer {
  const keys = Object.keys(env).sort((x, y) => x.toUpperCase().localeCompare(y.toUpperCase()));
  return Buffer.from(`${keys.map((key) => `${key}=${env[key]}\0`).join("")}\0`, "utf16le");
}

export interface ReducedSidecar extends SidecarProcess {
  /** For tests: the job's handle. */
  readonly job: bigint;
}

/** Starts `argv` reduced, as above. Async because its pipes are served first; `SidecarWireOptions.spawn` takes it
 *  through `reducedSidecarSpawn`. */
export async function startReducedSidecar(argv: readonly string[], onLog?: (line: string) => void, reduce: { lowIntegrity?: boolean; restricted?: boolean; restricting?: boolean } = {}): Promise<ReducedSidecar> {
  if (process.platform !== "win32") throw new Error("startReducedSidecar is Windows-only");
  win ??= loadWin32();
  const { k, a, ptr } = win;
  const stdin = await pipeEnd("to-child");
  const stdout = await pipeEnd("from-child");
  const stderr = await pipeEnd("from-child");
  const ends = [stdin.handle, stdout.handle, stderr.handle];
  const closeEnds = () => { for (const h of ends) k.CloseHandle(h); };
  let token = 0n, job = 0n;
  try {
    token = reducedToken(reduce.lowIntegrity ?? true, reduce.restricted ?? true, reduce.restricting ?? true);
    job = killOnCloseJob();
    // Only the three ends are inherited.
    const size = new BigUint64Array(1);
    k.InitializeProcThreadAttributeList(null, 1, 0, size);
    const attrs = Buffer.alloc(Number(size[0]!));
    if (!k.InitializeProcThreadAttributeList(attrs, 1, 0, size)) fail("InitializeProcThreadAttributeList");
    const list = new BigUint64Array(ends);
    if (!k.UpdateProcThreadAttribute(attrs, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, list, 8 * ends.length, null, null)) fail("UpdateProcThreadAttribute");
    const si = Buffer.alloc(112); // STARTUPINFOEXW
    si.writeUInt32LE(112, 0);
    si.writeUInt32LE(STARTF_USESTDHANDLES, 60);
    si.writeBigUInt64LE(stdin.handle, 80);
    si.writeBigUInt64LE(stdout.handle, 88);
    si.writeBigUInt64LE(stderr.handle, 96);
    si.writeBigUInt64LE(BigInt(ptr(attrs)), 104);
    const pi = Buffer.alloc(24); // PROCESS_INFORMATION
    const app = w16(argv[0]!);
    const cmd = w16(windowsCommandLine(argv));
    const env = windowsEnvBlock(sidecarEnv());
    // Inheritable for exactly the creation, with nothing awaited in between (the handle list limits it to the child).
    for (const h of ends) if (!k.SetHandleInformation(h, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT)) fail("SetHandleInformation(inherit)");
    const ok = a.CreateProcessAsUserW(token, app, cmd, null, null, 1,
      CREATE_SUSPENDED | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT, env, null, si, pi);
    for (const h of ends) {
      // The ends close right after this; a failure here only leaves them inheritable for that moment.
      if (!k.SetHandleInformation(h, HANDLE_FLAG_INHERIT, 0)) onLog?.(`the link sidecar's pipe end stayed inheritable until closed (error ${k.GetLastError()})`);
    }
    k.DeleteProcThreadAttributeList(attrs);
    if (!ok) fail("CreateProcessAsUserW");
    const hProcess = pi.readBigUInt64LE(0), hThread = pi.readBigUInt64LE(8), pid = pi.readUInt32LE(16);
    if (!k.AssignProcessToJobObject(job, hProcess)) {
      k.TerminateProcess(hProcess, 1);
      k.CloseHandle(hThread);
      k.CloseHandle(hProcess);
      fail("AssignProcessToJobObject");
    }
    k.ResumeThread(hThread);
    k.CloseHandle(hThread);
    k.CloseHandle(token);
    token = 0n;
    closeEnds();
    const [inSock, outSock, errSock] = await Promise.all([stdin.socket, stdout.socket, stderr.socket]);
    const jobHandle = job;
    const exited = new Promise<number>((resolve) => {
      const code = new Uint32Array(1);
      const poll = setInterval(() => {
        if (!k.GetExitCodeProcess(hProcess, code) || code[0] !== STILL_ACTIVE) {
          clearInterval(poll);
          k.CloseHandle(hProcess);
          k.CloseHandle(jobHandle);
          inSock.destroy();
          resolve(code[0] ?? 1);
        }
      }, 200);
      (poll as { unref?: () => void }).unref?.();
    });
    if (onLog) {
      let rest = "";
      errSock.setEncoding("utf8");
      errSock.on("data", (chunk: string) => {
        rest += chunk;
        const lines = rest.split("\n");
        rest = lines.pop() ?? "";
        for (const line of lines) if (line.trim()) onLog(line.slice(0, 2000));
      });
      errSock.resume();
    } else errSock.resume();
    const stdoutStream = new ReadableStream<Uint8Array>({
      start(controller) {
        outSock.on("data", (c: Buffer) => controller.enqueue(new Uint8Array(c)));
        outSock.on("end", () => { try { controller.close(); } catch { /* closed */ } });
        outSock.on("error", () => { try { controller.close(); } catch { /* closed */ } });
        outSock.resume();
      },
    });
    let killed = false;
    return {
      pid, job: jobHandle, exited, stdout: stdoutStream,
      write(bytes) { if (!inSock.destroyed) inSock.write(bytes, () => undefined); },
      kill() { if (!killed) { killed = true; k.TerminateJobObject(jobHandle, 1); } },
    };
  } catch (err) {
    closeEnds();
    if (token !== 0n) k.CloseHandle(token);
    if (job !== 0n) k.CloseHandle(job);
    for (const p of [stdin, stdout, stderr]) p.server.close();
    throw err;
  }
}

/** `SidecarWireOptions.spawn` on Windows: `startReducedSidecar` behind the wire's synchronous spawn. Writes wait for the
 *  start; a start that fails logs why and reads as an exit (the wire's restart backoff takes it from there). */
export function reducedSidecarSpawn(onLog?: (line: string) => void): (argv: readonly string[]) => SidecarProcess {
  return (argv) => {
    const started = startReducedSidecar(argv, onLog);
    const pending: Uint8Array[] = [];
    let proc: ReducedSidecar | undefined;
    let killed = false;
    started.then((p) => {
      proc = p;
      if (killed) p.kill();
      for (const b of pending.splice(0)) p.write(b);
    }, (err: unknown) => onLog?.(err instanceof Error ? err.message : String(err)));
    const stdout = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          const p = await started;
          const reader = p.stdout.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(value);
          }
        } catch { /* it never started, or its pipe broke */ }
        try { controller.close(); } catch { /* closed */ }
      },
    });
    return {
      stdout,
      exited: started.then((p) => p.exited, () => 1),
      write(bytes) { if (proc) proc.write(bytes); else pending.push(bytes.slice()); },
      kill() { killed = true; proc?.kill(); },
    };
  };
}
