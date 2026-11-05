// The daemon's named pipe on Windows, made safe to dial (from E-M1's review). Anyone could otherwise
// create `\\.\pipe\clover-core-<id>` first and collect what the app sends it.
//   - The first instance is created with FILE_FLAG_FIRST_PIPE_INSTANCE: libuv, under Bun.listen, does
//     that already (measured: the bit shows in the first instance's handle), so a daemon whose name is
//     taken fails to listen and exits, rather than sharing the name with a squatter.
//   - `lockPipeDacl` then replaces the pipe's DACL with the user and SYSTEM alone (protected), from the
//     daemon's own server-end handle, so no other account, and no token without the user's SID among
//     its restricting SIDs, can open or add an instance of it.
//   - A client checks who serves the pipe before it says hello: `pipeServerIdentity` (its server's
//     pid, that process's user SID and image path) and `isOurDaemon`. The app can do the same with
//     GetNamedPipeServerProcessId on its own handle, or prove the server through the app token
//     (`proveDaemon` in pair/run-files.ts), which needs no native code.
// Bun's pipe sockets carry no handle (fd -1), so both sides find their pipe handles among the
// process's own handles (`ownHandles`), by name.
import { ffiLib, ffiPtr as ptr, ffiWide, type FfiLib } from "./ffi";
import { ownHandles } from "./caller-probe";

function k32(): FfiLib | null {
  return ffiLib("win-pipe-k32", "kernel32.dll", {
    GetFileType: { args: ["u64"], returns: "u32" },
    GetNamedPipeInfo: { args: ["u64", "ptr", "ptr", "ptr", "ptr"], returns: "i32" },
    GetNamedPipeServerProcessId: { args: ["u64", "ptr"], returns: "i32" },
    GetFileInformationByHandleEx: { args: ["u64", "i32", "ptr", "u32"], returns: "i32" },
    OpenProcess: { args: ["u32", "i32", "u32"], returns: "u64" },
    QueryFullProcessImageNameW: { args: ["u64", "u32", "ptr", "ptr"], returns: "i32" },
    CloseHandle: { args: ["u64"], returns: "i32" },
    LocalFree: { args: ["u64"], returns: "u64" },
    lstrlenW: { args: ["u64"], returns: "i32" },
  });
}

function adv(): FfiLib | null {
  return ffiLib("win-pipe-adv", "advapi32.dll", {
    ConvertStringSecurityDescriptorToSecurityDescriptorW: { args: ["ptr", "u32", "ptr", "ptr"], returns: "i32" },
    SetKernelObjectSecurity: { args: ["u64", "u32", "u64"], returns: "i32" },
    GetKernelObjectSecurity: { args: ["u64", "u32", "ptr", "u32", "ptr"], returns: "i32" },
    ConvertSecurityDescriptorToStringSecurityDescriptorW: { args: ["ptr", "u32", "u32", "ptr", "ptr"], returns: "i32" },
    OpenProcessToken: { args: ["u64", "u32", "ptr"], returns: "i32" },
    GetTokenInformation: { args: ["u64", "i32", "ptr", "u32", "ptr"], returns: "i32" },
    ConvertSidToStringSidW: { args: ["u64", "ptr"], returns: "i32" },
  });
}

const DACL_SECURITY_INFORMATION = 0x4, PROTECTED_DACL_SECURITY_INFORMATION = 0x80000000;
const PIPE_SERVER_END = 1, FILE_TYPE_PIPE = 3, FILE_NAME_INFO = 2;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000, TOKEN_QUERY = 0x8, TOKEN_USER = 1;

/** `\\.\pipe\name` → `\name`, the form GetFileInformationByHandleEx gives a pipe handle. */
function pipeFileName(pipePath: string): string {
  return `\\${pipePath.replace(/^\\\\\.\\pipe\\/i, "")}`.toLowerCase();
}

function handleName(h: bigint): string | null {
  const k = k32()!;
  const buf = Buffer.alloc(4 + 1024);
  if ((k.GetFileInformationByHandleEx!(h, FILE_NAME_INFO, ptr(buf), buf.length) as number) === 0) return null;
  const len = buf.readUInt32LE(0);
  return buf.subarray(4, 4 + len).toString("utf16le").toLowerCase();
}

/** This process's handles to the pipe `pipePath`: its server ends, or its client ends. */
function pipeHandles(pipePath: string, end: "server" | "client"): bigint[] {
  const k = k32();
  const handles = ownHandles();
  if (!k || !handles) return [];
  const name = pipeFileName(pipePath);
  const out: bigint[] = [];
  for (const { handle, access } of handles) {
    // Only pipe handles opened for writing their DACL (server ends) or for reading and writing
    // (client ends) are asked their type, so no other handle in the process is touched.
    if (end === "server" ? (access & 0x40000) === 0 : (access & 0x3) !== 0x3) continue;
    if ((k.GetFileType!(handle) as number) !== FILE_TYPE_PIPE) continue;
    const flags = new Uint32Array(1);
    if ((k.GetNamedPipeInfo!(handle, ptr(flags), null, null, null) as number) === 0) continue;
    if (((flags[0]! & PIPE_SERVER_END) !== 0) !== (end === "server")) continue;
    if (handleName(handle) === name) out.push(handle);
  }
  return out;
}

/** The DACL the daemon's pipe gets: full access for the user and SYSTEM, nothing inherited. */
export function ownerOnlyPipeSddl(userSid: string): string {
  if (!/^S-1-[\d-]+$/.test(userSid)) throw new Error("not a SID");
  return `D:P(A;;GA;;;${userSid})(A;;GA;;;SY)`;
}

/** Replace the pipe's DACL with the user's and SYSTEM's alone, through the daemon's own server end.
 *  Call once Bun.listen is up. Returns how many server ends took it (0: it did not hold). */
export function lockPipeDacl(pipePath: string, userSid: string): number {
  const a = adv(), k = k32();
  if (!a || !k) return 0;
  const sddl = Buffer.from(`${ownerOnlyPipeSddl(userSid)}\0`, "utf16le");
  const out = new BigUint64Array(1);
  if ((a.ConvertStringSecurityDescriptorToSecurityDescriptorW!(ptr(sddl), 1, ptr(out), null) as number) === 0) return 0;
  let done = 0;
  try {
    for (const h of pipeHandles(pipePath, "server")) {
      if ((a.SetKernelObjectSecurity!(h, DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION, out[0]!) as number) !== 0) done++;
    }
  } finally { k.LocalFree!(out[0]!); }
  return done;
}

/** The DACL on the pipe as SDDL, read through one of this process's handles to it (tests, doctor). */
export function pipeDaclSddl(pipePath: string, end: "server" | "client" = "server"): string | null {
  const a = adv(), k = k32();
  const h = pipeHandles(pipePath, end)[0];
  if (!a || !k || h === undefined) return null;
  const sd = Buffer.alloc(4096), need = new Uint32Array(1);
  if ((a.GetKernelObjectSecurity!(h, DACL_SECURITY_INFORMATION, ptr(sd), sd.length, ptr(need)) as number) === 0) return null;
  const str = new BigUint64Array(1), len = new Uint32Array(1);
  if ((a.ConvertSecurityDescriptorToStringSecurityDescriptorW!(ptr(sd), 1, DACL_SECURITY_INFORMATION, ptr(str), ptr(len)) as number) === 0) return null;
  try { return ffiWide(str[0]!, k.lstrlenW!(str[0]!) as number); } finally { k.LocalFree!(str[0]!); }
}

export interface PipeServerIdentity {
  readonly pid: number;
  /** The server process's user, as a SID string. */
  readonly userSid: string;
  /** Its executable's full path. */
  readonly image: string;
}

function processIdentity(pid: number): Omit<PipeServerIdentity, "pid"> | null {
  const k = k32(), a = adv();
  if (!k || !a) return null;
  const h = BigInt(k.OpenProcess!(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) as number | bigint);
  if (h === 0n) return null;
  try {
    const path = Buffer.alloc(2 * 32768), size = new Uint32Array([32768]);
    if ((k.QueryFullProcessImageNameW!(h, 0, ptr(path), ptr(size)) as number) === 0) return null;
    const image = path.subarray(0, size[0]! * 2).toString("utf16le");
    const tok = new BigUint64Array(1);
    if ((a.OpenProcessToken!(h, TOKEN_QUERY, ptr(tok)) as number) === 0) return null;
    try {
      const info = Buffer.alloc(256), ret = new Uint32Array(1);
      if ((a.GetTokenInformation!(tok[0]!, TOKEN_USER, ptr(info), info.length, ptr(ret)) as number) === 0) return null;
      const sidPtr = info.readBigUInt64LE(0); // TOKEN_USER.User.Sid
      const str = new BigUint64Array(1);
      if ((a.ConvertSidToStringSidW!(sidPtr, ptr(str)) as number) === 0) return null;
      try { return { userSid: ffiWide(str[0]!, k.lstrlenW!(str[0]!) as number), image }; } finally { k.LocalFree!(str[0]!); }
    } finally { k.CloseHandle!(tok[0]!); }
  } finally { k.CloseHandle!(h); }
}

/** This process's own user, as a SID string (no child process: the daemon calls it as it listens). */
export function currentUserSid(): string | null {
  return processIdentity(process.pid)?.userSid ?? null;
}

/** Who serves the pipe this process is connected to: its pid, user and image. Call after
 *  connecting and before sending anything. Null when it can't be told (then don't say hello). */
export function pipeServerIdentity(pipePath: string): PipeServerIdentity | null {
  const k = k32();
  if (!k) return null;
  const pids = new Set<number>();
  for (const h of pipeHandles(pipePath, "client")) {
    const pid = new Uint32Array(1);
    if ((k.GetNamedPipeServerProcessId!(h, ptr(pid)) as number) !== 0 && pid[0]! > 0) pids.add(pid[0]!);
  }
  if (pids.size !== 1) return null; // none, or this process holds connections to two servers
  const pid = [...pids][0]!;
  const who = processIdentity(pid);
  return who === null ? null : { pid, ...who };
}

/** Whether a pipe's server is this user's daemon: the same user, and (when given) the expected
 *  binary. Fails closed. */
export function isOurDaemon(server: PipeServerIdentity | null, expect: { userSid: string; image?: string }): boolean {
  if (server === null) return false;
  if (server.userSid.toUpperCase() !== expect.userSid.toUpperCase()) return false;
  return expect.image === undefined || server.image.toLowerCase() === expect.image.toLowerCase();
}
