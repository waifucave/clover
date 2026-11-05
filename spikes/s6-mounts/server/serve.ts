#!/usr/bin/env bun
// The file service: the half of the folder tree that runs on the computer that holds the files.
// In Clover this is the daemon's tree service answering requests that arrive over the device link
// (packages/core/src/tree/, lane J M1); here it listens on TCP so the fake link can sit in front of it.
//
//   bun serve.ts --root <dir> --port <n> [--host 127.0.0.1] [--control-port <n>]
//                [--fence .clover,.clover-dev] [--test-ops] [--no-watch] [--verbose]
//
// The control port answers GET /stats (operation counts) and POST /stats/reset, so the
// benchmarks can say how many round trips each workload took.

import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { Attr, Err, EventType, FileType, FrameSplitter, Kind, Op, Reader, VERSION, Writer, errFromCode } from "./wire";

const args = parseArgs(process.argv.slice(2));
const ROOT = path.resolve(String(args.root ?? "."));
const PORT = Number(args.port ?? 7400);
const HOST = String(args.host ?? "127.0.0.1");
const CONTROL_PORT = args["control-port"] ? Number(args["control-port"]) : 0;
const FENCE = String(args.fence ?? ".clover,.clover-dev").split(",").filter(Boolean);
const TEST_OPS = Boolean(args["test-ops"]);
const WATCH = !args["no-watch"];
const VERBOSE = Boolean(args.verbose);
const INSTANCE = randomUUID();
const IS_WIN = process.platform === "win32";
// The same realpath function for the root and for every parent, so Windows' 8.3 names and drive
// case compare equal; Windows paths compare case-insensitively.
const REAL_ROOT = await fs.promises.realpath(ROOT);
const samePath = (a: string, b: string) => (IS_WIN ? a.toLowerCase() === b.toLowerCase() : a === b);
const inside = (p: string) => samePath(p, REAL_ROOT) || (IS_WIN ? p.toLowerCase().startsWith(REAL_ROOT.toLowerCase() + path.sep) : p.startsWith(REAL_ROOT + path.sep));

class WireError extends Error {
  constructor(public err: number, message?: string) { super(message ?? `wire error ${err}`); }
}
const fail = (err: number, m?: string): never => { throw new WireError(err, m); };

// ---- statistics -----------------------------------------------------------------------------
const OP_NAMES = Object.fromEntries(Object.entries(Op).map(([k, v]) => [v, k])) as Record<number, string>;
let stats: Record<string, number> = {};
const count = (name: string, n = 1) => { stats[name] = (stats[name] ?? 0) + n; };

// ---- paths and the fence --------------------------------------------------------------------
function checkRel(rel: string): string[] {
  if (rel === "") return [];
  if (rel.includes("\0")) fail(Err.EINVAL, "NUL in path");
  if (IS_WIN && /[\\:]/.test(rel)) fail(Err.EINVAL, "backslash or colon in path");
  const parts = rel.split("/");
  for (const p of parts) if (p === "" || p === "." || p === "..") fail(Err.EINVAL, `bad component in ${rel}`);
  return parts;
}
function fenced(rel: string): boolean {
  return FENCE.some((f) => (IS_WIN ? rel.toLowerCase() === f.toLowerCase() || rel.toLowerCase().startsWith(f.toLowerCase() + "/") : rel === f || rel.startsWith(f + "/")));
}
const within = (root: string, p: string) => { const r = path.relative(root, p); return r === "" || (!r.startsWith("..") && !path.isAbsolute(r)); };
/** The export-relative form of a real path, or null when it lies outside the export. */
function relOfReal(real: string): string | null {
  if (!inside(real)) return null;
  return path.relative(REAL_ROOT, real).split(path.sep).join("/");
}
/** A request's path on this disk, without touching the disk (for bookkeeping only). */
function resolve(rel: string): string {
  const parts = checkRel(rel);
  // The fence of the computer that holds the files applies to every request from the link,
  // whoever sent it (spec §9.1). Here: the fenced prefixes are neither readable nor writable.
  if (fenced(rel)) fail(Err.EACCES, `fenced: ${rel}`);
  return parts.length ? path.join(ROOT, ...parts) : ROOT;
}
/**
 * A request's path, checked against the disk: no component before the last may be a link. A
 * kernel that mounts the tree follows links itself (READLINK, then a lookup of the target), so a
 * link in the middle of a request's path means a folder it knew was swapped for a link since,
 * the way a fenced folder (.clover) would be reached under another name (review S2). Answers
 * ELOOP, as openat2's RESOLVE_NO_SYMLINKS does. With noFollow the last component may not be a
 * link either: for the calls that would follow it (open, list, setattr). The walk and the call
 * after it can still race a swap on the holder; M1 opens with openat2(RESOLVE_BENEATH |
 * RESOLVE_NO_SYMLINKS) on Linux, O_NOFOLLOW_ANY on macOS and reparse-point checks on Windows.
 */
async function resolveSafe(rel: string, noFollow = false): Promise<string> {
  const abs = resolve(rel);
  const parts = rel === "" ? [] : rel.split("/");
  let cur = ROOT;
  for (let i = 0; i < parts.length; i++) {
    cur = path.join(cur, parts[i]!);
    if (i === parts.length - 1 && !noFollow) break;
    let st: fs.Stats;
    try { st = await fs.promises.lstat(cur); } catch (e: any) { return fail(errFromCode(e.code)); }
    if (st.isSymbolicLink()) fail(Err.ELOOP, `a link in the path: ${parts.slice(0, i + 1).join("/")}`);
    if (i < parts.length - 1 && !st.isDirectory()) fail(Err.ENOTDIR);
  }
  return abs;
}
/** For anything that writes: no link on the way, and the parent's real path inside the export and outside the fence. */
async function resolveForWrite(rel: string): Promise<string> {
  const abs = await resolveSafe(rel);
  if (rel === "") return abs;
  const parent = await fs.promises.realpath(path.dirname(abs)).catch((e) => fail(errFromCode(e.code)));
  const prel = relOfReal(parent);
  if (prel === null) fail(Err.EACCES, `escapes the export: ${rel}`);
  if (prel !== "" && fenced(prel)) fail(Err.EACCES, `fenced through a link: ${rel}`);
  return abs;
}
/** After an open: what was opened must not be fenced, whatever happened to the path meanwhile. */
async function checkOpened(abs: string, fd: number) {
  const real = await fs.promises.realpath(abs).catch(() => null);
  const rel = real === null ? null : relOfReal(real);
  if (rel === null || (rel !== "" && fenced(rel))) {
    fs.close(fd, () => {});
    fail(Err.EACCES, `opened outside the export or inside the fence: ${abs}`);
  }
}
const join = (dir: string, name: string) => (dir === "" ? name : `${dir}/${name}`);

/**
 * An absolute link target means a path on this computer, which another computer would resolve
 * against its own disk. A target inside the export becomes relative, so it resolves through the
 * tree everywhere (Bun's Windows junctions in node_modules are absolute). Targets outside the
 * export are passed on unchanged and resolve on the reader's own computer — see the report.
 */
function linkTarget(abs: string, target: string): string {
  let t = target.startsWith("\\\\?\\") ? target.slice(4) : target;
  if (!path.isAbsolute(t)) {
    // A relative link that climbs out of the export would resolve against the reading
    // computer's own disk, to a file the holder never meant (review S9): it answers EACCES.
    const lands = path.resolve(path.dirname(abs), t);
    if (!within(ROOT, lands) && !within(REAL_ROOT, lands)) {
      count("READLINK_outside");
      fail(Err.EACCES, `link leaves the export: ${t}`);
    }
    return t.split(path.sep).join("/");
  }
  for (const root of [ROOT, REAL_ROOT]) {
    const rel = path.relative(root, t);
    if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
      const fromDir = path.relative(root, path.dirname(abs));
      const r = path.relative(path.join(root, fromDir), path.join(root, rel)) || ".";
      count("READLINK_rewritten");
      return r.split(path.sep).join("/");
    }
  }
  // An absolute link outside the export names a file on this computer. On another computer the
  // same path is some other file, so the link answers EACCES there (review S9).
  count("READLINK_outside");
  return fail(Err.EACCES, `link leaves the export: ${t}`);
}

// ---- attributes -----------------------------------------------------------------------------
function toAttr(st: fs.BigIntStats): Attr {
  const type = st.isFile() ? FileType.FILE : st.isDirectory() ? FileType.DIR : st.isSymbolicLink() ? FileType.SYMLINK : FileType.OTHER;
  let mode = Number(st.mode & 0o7777n);
  // Windows has no POSIX modes; libuv reports 0666 (0444 when read-only) for everything. A folder
  // without x can't be entered on the computer that mounts it: WinFsp maps x to FILE_TRAVERSE,
  // and Git for Windows' chdir() into it failed with "Permission denied".
  if (process.platform === "win32" && type === FileType.DIR) mode |= 0o111;
  return {
    type, mode, size: st.size, mtimeNs: st.mtimeNs, ctimeNs: st.ctimeNs,
    atimeNs: st.atimeNs, birthNs: st.birthtimeNs, ino: st.ino, nlink: Number(st.nlink),
    uid: Number(st.uid), gid: Number(st.gid),
  };
}
async function lstatAttr(abs: string): Promise<Attr> {
  try { return toAttr(await fs.promises.lstat(abs, { bigint: true })); }
  catch (e: any) { return fail(errFromCode(e.code)); }
}
async function listDir(rel: string): Promise<Array<[string, Attr]>> {
  const abs = await resolveSafe(rel, true);
  let names: string[];
  try { names = await fs.promises.readdir(abs); } catch (e: any) { return fail(errFromCode(e.code)); }
  names = names.filter((n) => !fenced(join(rel, n)));
  const out: Array<[string, Attr]> = [];
  for (let i = 0; i < names.length; i += 128) {
    const batch = names.slice(i, i + 128);
    const attrs = await Promise.all(batch.map((n) => fs.promises.lstat(path.join(abs, n), { bigint: true }).then(toAttr, () => null)));
    batch.forEach((n, j) => { const a = attrs[j]; if (a) out.push([n, a]); }); // vanished meanwhile: skip
  }
  return out;
}

// ---- descriptors ----------------------------------------------------------------------------
function fsCall<T>(f: (cb: (e: NodeJS.ErrnoException | null, v: T) => void) => void): Promise<T> {
  return new Promise((res, rej) => f((e, v) => (e ? rej(new WireError(errFromCode(e.code), e.message)) : res(v))));
}
/** Read-only descriptors for stateless READs (handle 0), dropped when idle or changed. */
const readFds = new Map<string, { fd: number; used: number; users: number }>();
async function readFd(abs: string): Promise<{ fd: number; release: () => void }> {
  let e = readFds.get(abs);
  if (!e) {
    const fd = await fsCall<number>((cb) => fs.open(abs, "r", cb));
    const raced = readFds.get(abs);
    if (raced) fs.close(fd, () => {}); else readFds.set(abs, { fd, used: Date.now(), users: 0 });
    e = readFds.get(abs)!;
  }
  e.used = Date.now();
  e.users++;
  const entry = e;
  return { fd: entry.fd, release: () => { entry.users--; } };
}
function dropReadFd(abs: string) {
  const e = readFds.get(abs);
  if (!e) return;
  readFds.delete(abs);
  const close = () => (e.users > 0 ? setTimeout(close, 50) : fs.close(e.fd, () => {}));
  close();
}
setInterval(() => {
  const now = Date.now();
  for (const [abs, e] of readFds) if (now - e.used > 2000 && e.users === 0) dropReadFd(abs);
  if (readFds.size > 256) for (const abs of [...readFds.keys()].slice(0, readFds.size - 256)) dropReadFd(abs);
}, 1000).unref();

function openFlags(w: number): number {
  const c = fs.constants;
  let f = (w & 3) === 1 ? c.O_WRONLY : (w & 3) === 2 ? c.O_RDWR : c.O_RDONLY;
  if (w & 0x40) f |= c.O_CREAT;
  if (w & 0x80) f |= c.O_EXCL;
  if (w & 0x200) f |= c.O_TRUNC;
  if (w & 0x400) f |= c.O_APPEND;
  return f;
}

// ---- connections ----------------------------------------------------------------------------
interface Conn {
  sock: import("bun").Socket<Conn>;
  split: FrameSplitter;
  out: Uint8Array[];
  handles: Map<bigint, { fd: number; path: string }>;
  watching: boolean;
  welcomed: boolean;
  lastRecv: number;
  closed: boolean;
}
const conns = new Set<Conn>();
let nextHandle = 1n;

function send(c: Conn, frame: Uint8Array) {
  if (c.closed) return;
  if (c.out.length) { c.out.push(frame); return; }
  const n = c.sock.write(frame);
  if (n < frame.length) c.out.push(frame.subarray(Math.max(n, 0)));
}
function flushOut(c: Conn) {
  while (c.out.length) {
    const f = c.out[0]!;
    const n = c.sock.write(f);
    if (n < f.length) { c.out[0] = f.subarray(Math.max(n, 0)); return; }
    c.out.shift();
  }
}
function closeConn(c: Conn) {
  if (c.closed) return;
  c.closed = true;
  conns.delete(c);
  for (const h of c.handles.values()) fs.close(h.fd, () => {});
  c.handles.clear();
  try { c.sock.end(); } catch {}
}

function onFrame(c: Conn, body: Uint8Array) {
  const r = new Reader(body);
  const kind = r.u8();
  const id = r.u32();
  switch (kind) {
    case Kind.HELLO: {
      const version = r.u32();
      const client = r.str();
      if (VERBOSE) console.error(`[serve] hello v${version} from ${client}`);
      send(c, new Writer().u8(Kind.WELCOME).u32(0).u32(VERSION).str(INSTANCE).str(process.platform)
        .u8(process.platform === "linux" ? 1 : 0).frame());
      c.welcomed = true;
      return;
    }
    case Kind.PING:
      send(c, new Writer().u8(Kind.PONG).u32(id).frame());
      return;
    case Kind.PONG:
      return;
    case Kind.REQ: {
      const op = r.u8();
      count(OP_NAMES[op] ?? `op${op}`);
      handle(c, op, r).then(
        (w) => send(c, (w ?? new Writer().u8(Kind.RES).u32(id).u16(0)).frame()),
        (e: unknown) => {
          const err = e instanceof WireError ? e.err : Err.EIO;
          if (VERBOSE || !(e instanceof WireError)) console.error(`[serve] ${OP_NAMES[op]} -> ${err}: ${(e as Error)?.message}`);
          send(c, new Writer().u8(Kind.RES).u32(id).u16(err).frame());
        },
      );
      return;
    }
    default:
      console.error(`[serve] unknown frame kind ${kind}`);
      closeConn(c);
  }

  async function handle(c: Conn, op: number, r: Reader): Promise<Writer | undefined> {
    const ok = () => new Writer().u8(Kind.RES).u32(id).u16(0);
    switch (op) {
      case Op.STAT: {
        const rel = r.str();
        return ok().attr(await lstatAttr(await resolveSafe(rel)));
      }
      case Op.LIST: {
        const rel = r.str();
        const entries = await listDir(rel);
        const w = ok().u32(entries.length);
        for (const [n, a] of entries) w.str(n).attr(a);
        return w;
      }
      case Op.TREE: {
        const rel = r.str();
        const max = r.u32();
        const dirs: Array<[string, Array<[string, Attr]>]> = [];
        const queue = [rel];
        let sent = 0;
        while (queue.length && sent < max) {
          const dir = queue.shift()!;
          let entries: Array<[string, Attr]>;
          try { entries = await listDir(dir); } catch (e) { if (dir === rel) throw e; continue; }
          dirs.push([dir, entries]);
          sent += entries.length;
          for (const [n, a] of entries) if (a.type === FileType.DIR) queue.push(join(dir, n));
        }
        count("TREE_entries", sent);
        const w = ok().u32(dirs.length);
        for (const [d, entries] of dirs) {
          w.str(d).u32(entries.length);
          for (const [n, a] of entries) w.str(n).attr(a);
        }
        return w;
      }
      case Op.READ: {
        const rel = r.str();
        const handle = r.u64();
        const off = r.u64();
        const len = Math.min(r.u32(), 4 * 1024 * 1024);
        let fd: number;
        let release = () => {};
        if (handle !== 0n) {
          const h = c.handles.get(handle) ?? fail(Err.ESTALE);
          fd = h.fd;
        } else {
          const abs = await resolveSafe(rel, true);
          ({ fd, release } = await readFd(abs));
        }
        try {
          const buf = new Uint8Array(len);
          const n = await fsCall<number>((cb) => fs.read(fd, buf, 0, len, Number(off), cb));
          count("READ_bytes", n);
          return ok().bytes(buf.subarray(0, n));
        } finally { release(); }
      }
      case Op.OPEN: {
        const rel = r.str();
        const flags = r.u32();
        const mode = r.u32();
        const abs = (flags & 3) !== 0 || flags & 0x40 ? await resolveForWrite(rel) : await resolveSafe(rel);
        // O_NOFOLLOW: the kernel that mounts the tree follows links itself, so the last component
        // is never meant to be one; a link there now was swapped in.
        const fd = await fsCall<number>((cb) => fs.open(abs, openFlags(flags) | fs.constants.O_NOFOLLOW, mode || 0o644, cb));
        await checkOpened(abs, fd);
        const st = await fsCall<fs.BigIntStats>((cb) => fs.fstat(fd, { bigint: true }, cb as any));
        const h = nextHandle++;
        c.handles.set(h, { fd, path: rel });
        if (flags & 0x200) dropReadFd(abs);
        return ok().u64(h).attr(toAttr(st));
      }
      case Op.WRITE: {
        r.str();
        const handle = r.u64();
        const off = r.u64();
        const data = r.bytes();
        const h = c.handles.get(handle) ?? fail(Err.ESTALE);
        let done = 0;
        while (done < data.length) {
          const n = await fsCall<number>((cb) => fs.write(h.fd, data, done, data.length - done, Number(off) + done, cb));
          if (n <= 0) break;
          done += n;
        }
        count("WRITE_bytes", done);
        dropReadFd(resolve(h.path));
        return ok().u32(done);
      }
      case Op.CLOSE: {
        const handle = r.u64();
        const h = c.handles.get(handle);
        if (h) { c.handles.delete(handle); await fsCall<void>((cb) => fs.close(h.fd, cb as any)); }
        return ok();
      }
      case Op.FSYNC: {
        const rel = r.str();
        const handle = r.u64();
        const h = c.handles.get(handle);
        if (h) await fsCall<void>((cb) => fs.fsync(h.fd, cb as any));
        else await resolveSafe(rel, true);
        return ok();
      }
      case Op.SETATTR: {
        const rel = r.str();
        const handle = r.u64();
        const mask = r.u32();
        const mode = r.u32();
        const size = r.u64();
        const atimeNs = r.i64();
        const mtimeNs = r.i64();
        const abs = await resolveForWrite(rel);
        if (handle === 0n) await resolveSafe(rel, true); // chmod, truncate and utimes follow a last-component link
        const h = handle !== 0n ? c.handles.get(handle) : undefined;
        try {
          if (mask & 1) await fs.promises.chmod(abs, mode & 0o7777);
          if (mask & 2) {
            if (h) await fsCall<void>((cb) => fs.ftruncate(h.fd, Number(size), cb as any));
            else await fs.promises.truncate(abs, Number(size));
            dropReadFd(abs);
          }
          if (mask & 12) {
            const st = await fs.promises.lstat(abs, { bigint: true });
            const at = mask & 4 ? Number(atimeNs) / 1e9 : Number(st.atimeNs) / 1e9;
            const mt = mask & 8 ? Number(mtimeNs) / 1e9 : Number(st.mtimeNs) / 1e9;
            await fs.promises.utimes(abs, at, mt);
          }
        } catch (e: any) { if (e instanceof WireError) throw e; fail(errFromCode(e.code), e.message); }
        return ok().attr(await lstatAttr(abs));
      }
      case Op.MKDIR: {
        const rel = r.str();
        const mode = r.u32();
        const abs = await resolveForWrite(rel);
        await fs.promises.mkdir(abs, { mode: mode || 0o755 }).catch((e) => fail(errFromCode(e.code)));
        return ok().attr(await lstatAttr(abs));
      }
      case Op.UNLINK: {
        const abs = await resolveForWrite(r.str());
        await fs.promises.unlink(abs).catch((e) => fail(errFromCode(e.code)));
        dropReadFd(abs);
        return ok();
      }
      case Op.RMDIR: {
        const abs = await resolveForWrite(r.str());
        await fs.promises.rmdir(abs).catch((e) => fail(errFromCode(e.code)));
        return ok();
      }
      case Op.RENAME: {
        const from = await resolveForWrite(r.str());
        const to = await resolveForWrite(r.str());
        const flags = r.u32();
        if (flags & 2) fail(Err.ENOTSUP, "exchange");
        if (flags & 1 && (await fs.promises.lstat(to).then(() => true, () => false))) fail(Err.EEXIST);
        await fs.promises.rename(from, to).catch((e) => fail(errFromCode(e.code)));
        dropReadFd(from); dropReadFd(to);
        return ok();
      }
      case Op.SYMLINK: {
        const abs = await resolveForWrite(r.str());
        const target = r.str();
        await fs.promises.symlink(target, abs).catch((e) => fail(errFromCode(e.code)));
        return ok().attr(await lstatAttr(abs));
      }
      case Op.READLINK: {
        const abs = await resolveSafe(r.str());
        const t = await fs.promises.readlink(abs).catch((e) => fail(errFromCode(e.code)));
        return ok().str(linkTarget(abs, t));
      }
      case Op.STATFS: {
        const s = await fs.promises.statfs(ROOT, { bigint: true }).catch(() => null);
        if (!s) return ok().u64(4096n).u64(1n << 28n).u64(1n << 27n).u64(1n << 27n).u64(1n << 24n).u64(1n << 23n);
        return ok().u64(s.bsize).u64(s.blocks).u64(s.bfree).u64(s.bavail).u64(s.files).u64(s.ffree);
      }
      case Op.LINK: {
        const fromRel = r.str();
        const from = await resolveForWrite(fromRel);
        await resolveSafe(fromRel, true); // macOS's link() follows a last-component link
        const to = await resolveForWrite(r.str());
        await fs.promises.link(from, to).catch((e) => fail(errFromCode(e.code)));
        return ok().attr(await lstatAttr(to));
      }
      case Op.WATCH: {
        c.watching = r.u8() !== 0;
        if (c.watching) startWatch();
        return ok();
      }
      case Op.SLEEP: {
        if (!TEST_OPS) fail(Err.ENOTSUP);
        await Bun.sleep(r.u32());
        return ok();
      }
      default:
        return fail(Err.ENOTSUP, `op ${op}`);
    }
  }
}

// ---- change events --------------------------------------------------------------------------
let watcher: fs.FSWatcher | null = null;
const pendingEvents = new Set<string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let rewatchMs = 1000;
function startWatch() {
  if (watcher || !WATCH) return;
  try {
    watcher = fs.watch(ROOT, { recursive: true }, (_ev, filename) => {
      if (filename == null) { queueEvent(null); return; }
      const rel = String(filename).split(path.sep).join("/");
      if (rel && !fenced(rel)) queueEvent(rel);
    });
    watcher.on("error", (e) => rewatch(`watch error: ${e}`));
    rewatchMs = 1000;
  } catch (e) { rewatch(`cannot watch ${ROOT}: ${e}`); }
}
/**
 * A watch that failed (an inotify limit, the folder replaced) is armed again with backoff, and
 * every peer gets a RESYNC: changes made while it was down were never reported (review S3).
 */
function rewatch(why: string) {
  console.error(`[serve] ${why}; watching again in ${rewatchMs} ms`);
  try { watcher?.close(); } catch {}
  watcher = null;
  queueEvent(null);
  setTimeout(() => { if ([...conns].some((c) => c.watching)) { startWatch(); if (watcher) queueEvent(null); } }, rewatchMs).unref();
  rewatchMs = Math.min(rewatchMs * 2, 30_000);
}
function queueEvent(rel: string | null) {
  pendingEvents.add(rel ?? "\0resync");
  if (rel) dropReadFd(path.join(ROOT, ...rel.split("/")));
  if (!flushTimer) flushTimer = setTimeout(flushEvents, 5);
}
function flushEvents() {
  flushTimer = null;
  const evs = [...pendingEvents];
  pendingEvents.clear();
  const resync = evs.includes("\0resync") || evs.length > 4096;
  count("EVENTS", resync ? 1 : evs.length);
  for (const c of conns) {
    if (!c.watching) continue;
    if (resync) { send(c, new Writer().u8(Kind.EVENT).u32(0).u8(EventType.RESYNC).str("").frame()); continue; }
    for (const rel of evs) send(c, new Writer().u8(Kind.EVENT).u32(0).u8(EventType.CHANGED).str(rel).frame());
  }
}

// ---- listeners ------------------------------------------------------------------------------
Bun.listen<Conn>({
  hostname: HOST,
  port: PORT,
  socket: {
    open(sock) {
      const c: Conn = { sock, split: new FrameSplitter(), out: [], handles: new Map(), watching: false, welcomed: false, lastRecv: Date.now(), closed: false };
      sock.data = c;
      sock.setNoDelay?.(true);
      conns.add(c);
    },
    data(sock, chunk) {
      const c = sock.data;
      c.lastRecv = Date.now();
      try { c.split.push(chunk, (b) => onFrame(c, b)); }
      catch (e) { console.error(`[serve] bad stream: ${e}`); closeConn(c); }
    },
    drain(sock) { flushOut(sock.data); },
    close(sock) { closeConn(sock.data); },
    error(sock, e) { console.error(`[serve] socket error: ${e}`); closeConn(sock.data); },
  },
});
// A helper that went silent is gone: release its handles (it pings every 250 ms).
setInterval(() => {
  const now = Date.now();
  for (const c of conns) if (now - c.lastRecv > 15_000) { console.error("[serve] idle connection closed"); closeConn(c); }
}, 1000).unref();
// Liveness from this end too (review S1): the helper calls a link dead after 1.5 s with nothing
// inbound. While it uploads, its own pings wait behind the data it sends, so they can't prove the
// link alive; pings from here can, and the helper answers them.
let pingSeq = 0;
setInterval(() => {
  pingSeq = (pingSeq + 1) >>> 0;
  for (const c of conns) if (c.welcomed) send(c, new Writer().u8(Kind.PING).u32(pingSeq).frame());
}, 250).unref();

if (CONTROL_PORT) {
  Bun.serve({
    hostname: "127.0.0.1",
    port: CONTROL_PORT,
    fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/stats" && req.method === "GET") return Response.json(stats);
      if (u.pathname === "/stats/reset" && req.method === "POST") { stats = {}; return Response.json({ ok: true }); }
      return new Response("not found", { status: 404 });
    },
  });
}
console.error(`[serve] ${ROOT} on ${HOST}:${PORT} instance ${INSTANCE.slice(0, 8)} (pid ${process.pid})`);

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) { out[key] = next; i++; } else out[key] = true;
  }
  return out;
}
