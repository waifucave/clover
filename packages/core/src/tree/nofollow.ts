// Reads that never follow a link (F-M3's review, through the controller): what the user's own file viewers read in the
// tree, where a runner may have left a link pointing anywhere. The holder walks the path from its area's root down,
// refusing a link (and on Windows any reparse point) at every part, opens the file without following a link at the
// last part, and then reads the opened file's real path back from its handle: it must be the path walked, so a folder
// swapped for a link between the walk and the open is refused too.
//
// `fdRealPath` is the same primitive as lane C's `openChecked` (`fence/open-checked.ts`, #205/#224): the real path of an
// open file from its handle. The two are meant to become one helper once C's is on main.
import { fstatSync, readlinkSync } from "node:fs";
import { ffiLib, ffiPtr as ptr } from "../platform/ffi";

/** The real path of an open file, from its handle; null when the OS won't say (callers refuse then). `path` is the
 *  path just opened: Windows needs it (its handle is taken by opening the path again, and believed only when it is the
 *  same file as the descriptor). */
export function fdRealPath(fd: number, path: string, platform: NodeJS.Platform = process.platform): string | null {
  if (platform === "linux") {
    try {
      return readlinkSync(`/proc/self/fd/${fd}`);
    } catch {
      return null;
    }
  }
  if (platform === "darwin") {
    // `proc_pidfdinfo` with PROC_PIDFDVNODEPATHINFO (not `fcntl(F_GETPATH)`: a variadic call through FFI isn't safe on
    // arm64): struct vnode_fdinfowithpath, 1200 bytes, the path at 176.
    const l = ffiLib("tree-nofollow-darwin", "/usr/lib/libSystem.B.dylib", { proc_pidfdinfo: { args: ["i32", "i32", "i32", "ptr", "i32"], returns: "i32" } });
    if (!l) return null;
    const b = Buffer.alloc(1200);
    if ((l.proc_pidfdinfo!(process.pid, fd, 2, ptr(b), b.length) as number) !== b.length) return null;
    const end = b.indexOf(0, 176);
    return end > 176 ? b.subarray(176, end).toString("utf8") : null;
  }
  if (platform === "win32") {
    const k = kernel32();
    if (!k) return null;
    let st: { dev: bigint; ino: bigint };
    try {
      st = fstatSync(fd, { bigint: true }) as unknown as { dev: bigint; ino: bigint };
    } catch {
      return null;
    }
    const wide = Buffer.from(`${path}\0`, "utf16le");
    // Attributes only, every sharing mode, FILE_FLAG_BACKUP_SEMANTICS so a folder opens too.
    const h = BigInt(k.CreateFileW!(ptr(wide), 0, 7, null, 3, 0x02000000, 0n) as number | bigint);
    if (h === 0n || h === 0xffffffffffffffffn) return null;
    try {
      const info = Buffer.alloc(52); // BY_HANDLE_FILE_INFORMATION
      if ((k.GetFileInformationByHandle!(h, ptr(info)) as number) === 0) return null;
      const serial = BigInt(info.readUInt32LE(28));
      const index = (BigInt(info.readUInt32LE(44)) << 32n) | BigInt(info.readUInt32LE(48));
      if (st.dev !== serial || st.ino !== index) return null;
      const buf = Buffer.alloc(32_768 * 2);
      const n = k.GetFinalPathNameByHandleW!(h, ptr(buf), 32_768, 0) as number;
      if (n === 0 || n >= 32_768) return null;
      const p = buf.subarray(0, n * 2).toString("utf16le");
      return p.startsWith("\\\\?\\UNC\\") ? `\\\\${p.slice(8)}` : p.startsWith("\\\\?\\") ? p.slice(4) : p;
    } finally {
      k.CloseHandle!(h);
    }
  }
  return null;
}

/** Whether a path is a reparse point on Windows (a junction, a symbolic link, a mount point, a cloud placeholder…):
 *  FILE_ATTRIBUTE_REPARSE_POINT on its own attributes, not followed. False elsewhere. A path whose attributes can't be
 *  read counts as one (refused). */
export function isReparsePoint(path: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== "win32") return false;
  const k = kernel32();
  if (!k) return true;
  const attrs = (k.GetFileAttributesW!(ptr(Buffer.from(`${path}\0`, "utf16le"))) as number) >>> 0;
  if (attrs === 0xffffffff) return true;
  return (attrs & 0x400) !== 0;
}

function kernel32() {
  return ffiLib("tree-nofollow-k32", "kernel32.dll", {
    CreateFileW: { args: ["ptr", "u32", "u32", "ptr", "u32", "u32", "u64"], returns: "u64" },
    GetFileInformationByHandle: { args: ["u64", "ptr"], returns: "i32" },
    GetFinalPathNameByHandleW: { args: ["u64", "ptr", "u32", "u32"], returns: "u32" },
    GetFileAttributesW: { args: ["ptr"], returns: "u32" },
    CloseHandle: { args: ["u64"], returns: "i32" },
  });
}
