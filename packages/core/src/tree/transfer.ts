// The direct path for moves and copies between computers (the owner's item 89; J-M0 edit 8; J-M1 review S1): the files
// stream from the computer that holds them straight to the one that will, over a link stream between those two, never
// through a third computer and never one round trip per file.
//
//   caller ──tree.receive──▶ destination ──stream "tree.send"──▶ source
//                                        ◀── entries, in order ──
//            ◀── ok ──────── (renamed into place) ──tree.sent──▶ (a move removes what it sent)
//
// * Each holder judges the whole operation once, before anything lands: the destination before it asks for the files,
//   the source before it sends any. Each judges at the stricter of its own level and the call's (review N2). One card
//   covers both (the controller's ruling): it binds `tree.transfer` with the operation, both paths and both computers,
//   and each holder checks the one signed answer against the card it rebuilds itself.
// * The destination takes the entries into a hidden folder beside the destination, made exclusively (`O_EXCL`), and
//   moves it into place only once everything arrived, never over something that's there. A failure removes only that
//   hidden copy.
// * The source sends what its fence lets the caller read. For a move it first checks it may remove every entry, and it
//   removes only what it sent, each only if it is unchanged since (size, time and inode): anything that changed or
//   came meanwhile stays, and the move says so (two copies, never none).
// * Links travel as links when their target stays inside what moves; anything that isn't a file, a folder or a link
//   refuses the whole operation before anything moves.
// * No cap per file (item 89), and frames stay at 256 KiB, so memory is bounded. Another computer's transfers here
//   (its `tree.receive`, and its `tree.send` stream) count in the same per-computer bulk slots as its writes
//   (`BULK_PER_DEVICE`, check 2's N3), so one computer can't run unbounded transfers at once at a holder.
// * R1, the caller's side (`transferAsking`): before it sends the call, it asks each holder that will judge it as a
//   peer whether its level needs the user's answer (`tree.judge`, which takes no answer and so spends none). If any
//   does, the user sees one card naming both computers and the whole operation, and its answer goes with the call.
import { randomUUID } from "node:crypto";
import { constants as FS, promises as fsp } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from "node:path";
import { z } from "zod";
import { Level, SessionId, SignedCardAnswer, TreePath, type Caller } from "@waifucave/clover-protocol";
import { ContractError, type Unsubscribe } from "../contracts/common";
import type { Link, LinkStream, LinkTransport } from "../contracts/link-transport";
import type { TreeChange } from "../contracts/tree";
import type { HolderCall, LocalHolder } from "./holder";
import { atOps } from "./at";
import { answerNeeded, type AnswerAsker, type NeedsAnswer } from "./judge";
import type { BulkSlots } from "./service";
import { offlineAs } from "./remote";

/** Bytes per frame of file data. */
const CHUNK = 256 * 1024;
/** A sent move whose destination never says it has the files is forgotten after this (the source stays). */
const SENT_WAIT_MS = 10 * 60 * 1000;

export const ReceiveParams = z.object({
  from: TreePath, to: TreePath, move: z.boolean(),
  session: SessionId.optional(), level: Level,
  /** The one signed answer for the whole operation (ruling R15), which both holders check; the destination passes it
   *  to the source with the stream. */
  answer: SignedCardAnswer.optional(),
});
export type ReceiveParams = z.infer<typeof ReceiveParams>;
const SendMeta = z.object({ from: TreePath, to: TreePath, move: z.boolean(), session: SessionId.optional(), level: Level, answer: SignedCardAnswer.optional() });

export interface TransferResult {
  files: number;
  bytes: number;
  /** A move's entries that changed at the source while they moved, and stay there too. */
  kept: number;
}

/** What both holders judge for the whole operation, and what one card binds (the controller's one-card ruling): the
 *  operation, both paths and both computers, each holder naming them from its own tree. The card binds the
 *  destination; each holder rebuilds the same card and checks the one answer against it. */
export function transferChange(move: boolean, from: string, to: string, source: string, destination: string): TreeChange {
  return { method: "tree.transfer", params: { op: move ? "move" : "copy", from, to, source, destination } } as unknown as TreeChange;
}

/** One holder's part: the destination judges the whole operation, the source a move (a copy only reads there). A
 *  holder whose own rule is stricter (read-only) refuses whatever the answer. */
async function judgeEnd(holder: LocalHolder, call: HolderCall, role: "source" | "destination", move: boolean, from: string, to: string, source: string, destination: string): Promise<void> {
  if (role === "source" && !move) return;
  await holder.judge(call, transferChange(move, from, to, source, destination), role === "source" || move ? "move" : "edit", destination);
}

interface Entry {
  kind: "dir" | "file" | "link";
  /** Inside what moves, with `/`; "" is the folder (or file) itself. */
  rel: string;
  mode: number;
  size?: number;
  target?: string;
}
/** The source's own record of an entry: what it was when sent. */
interface Sent extends Entry {
  mtimeMs: number;
  ino: bigint;
}

// ---- framing: 1 byte type, 4 bytes length, payload ------------------------------------------------------------------

const T_START = 0x53; // 'S': { sendId }
const T_ENTRY = 0x48; // 'H': an Entry
const T_DATA = 0x44; // 'D': file bytes
const T_ERROR = 0x58; // 'X': a ContractError, as JSON

function frame(type: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + payload.length);
  out[0] = type;
  new DataView(out.buffer).setUint32(1, payload.length);
  out.set(payload, 5);
  return out;
}

class Frames {
  #buf = new Uint8Array(0);
  push(chunk: Uint8Array, fn: (type: number, payload: Uint8Array) => void): void {
    const next = new Uint8Array(this.#buf.length + chunk.length);
    next.set(this.#buf);
    next.set(chunk, this.#buf.length);
    this.#buf = next;
    while (this.#buf.length >= 5) {
      const len = new DataView(this.#buf.buffer, this.#buf.byteOffset).getUint32(1);
      if (len > CHUNK * 2) throw new ContractError("invalid", "a frame larger than the direct path sends");
      if (this.#buf.length < 5 + len) break;
      fn(this.#buf[0]!, this.#buf.slice(5, 5 + len));
      this.#buf = this.#buf.slice(5 + len);
    }
  }
}

const json = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
const unjson = (b: Uint8Array) => JSON.parse(new TextDecoder().decode(b)) as unknown;
const at = (root: string, rel: string) => (rel === "" ? root : join(root, ...rel.split("/")));

/** Whether `child` is `parent` or inside it. */
function inside(parent: string, child: string): boolean {
  const r = relative(parent, child);
  return r === "" || (r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r));
}

// ---- the source -------------------------------------------------------------------------------------------------

/** Walks what's sent: folders before their contents, files and links, nothing the caller may not see. For a move,
 *  every entry must be one the caller may remove. Anything else (a socket, a device, a link out) refuses the whole
 *  operation before a byte moves. */
async function walk(holder: LocalHolder, root: string, call: HolderCall, move: boolean): Promise<Sent[]> {
  const out: Sent[] = [];
  const visit = async (real: string, rel: string) => {
    const st = await fsp.lstat(real, { bigint: true });
    const name = rel || basename(root);
    if (!holder.visible(real, call)) {
      if (move) throw new ContractError("fenced", `${name} is fenced; it can't move`);
      return;
    }
    if (move && !holder.changeable(real, call)) throw new ContractError("fenced", `${name} is fenced; it can't move`);
    const base = { rel, mode: Number(st.mode) & 0o777, mtimeMs: Number(st.mtimeMs), ino: st.ino };
    if (st.isDirectory()) {
      out.push({ kind: "dir", ...base });
      for (const child of (await fsp.readdir(real)).sort()) await visit(join(real, child), rel === "" ? child : `${rel}/${child}`);
    } else if (st.isFile()) {
      if (st.nlink > 1n && call.as.kind !== "user" && call.as.kind !== "core") throw new ContractError("refused", `${name} has other names (hard links)`);
      out.push({ kind: "file", ...base, size: Number(st.size) });
    } else if (st.isSymbolicLink()) {
      const raw = await fsp.readlink(real);
      if (isAbsolute(raw) || !inside(root, resolvePath(dirname(real), raw))) {
        throw new ContractError("invalid", `${name} is a link that leads out of what's moving`);
      }
      out.push({ kind: "link", ...base, target: raw.split(sep).join("/") });
    } else {
      throw new ContractError("invalid", `${name} isn't a file, folder or link`);
    }
  };
  await visit(root, "");
  return out;
}

const wire = ({ kind, rel, mode, size, target }: Sent): Entry => ({ kind, rel, mode, ...(size === undefined ? {} : { size }), ...(target === undefined ? {} : { target }) });

async function send(stream: LinkStream, root: string, entries: readonly Sent[], sendId: string): Promise<void> {
  await stream.write(frame(T_START, json({ sendId })));
  for (const e of entries) {
    await stream.write(frame(T_ENTRY, json(wire(e))));
    if (e.kind !== "file") continue;
    const fh = await fsp.open(at(root, e.rel), FS.O_RDONLY | (process.platform === "win32" ? 0 : FS.O_NOFOLLOW ?? 0));
    try {
      if ((await fh.stat({ bigint: true })).ino !== e.ino) throw new ContractError("conflict", `${e.rel || basename(root)} changed while it was being sent`);
      const buf = new Uint8Array(CHUNK);
      let left = e.size ?? 0;
      let pos = 0;
      while (left > 0) {
        const { bytesRead } = await fh.read(buf, 0, Math.min(CHUNK, left), pos);
        if (bytesRead === 0) throw new ContractError("conflict", `${e.rel || basename(root)} got shorter while it was being sent`);
        await stream.write(frame(T_DATA, buf.slice(0, bytesRead)));
        left -= bytesRead;
        pos += bytesRead;
      }
    } finally {
      await fh.close();
    }
  }
}

/** Removes what was sent, and only what is unchanged since: files and links, then the folders left empty, deepest
 *  first. Returns how many entries stay. An entry replaced in the instant between its check and its removal is
 *  removed too (no `unlinkat` takes an inode); the folders below are the source's own, and only a writer on the
 *  source computer could make that swap. */
async function removeSent(root: string, entries: readonly Sent[]): Promise<number> {
  let kept = 0;
  for (const e of entries) {
    if (e.kind === "dir") continue;
    const p = at(root, e.rel);
    const st = await fsp.lstat(p, { bigint: true }).catch(() => null);
    if (!st) continue;
    const same = st.ino === e.ino && Number(st.mtimeMs) === e.mtimeMs && (e.kind !== "file" || Number(st.size) === e.size);
    if (!same) {
      kept++;
      continue;
    }
    await fsp.unlink(p).catch(() => { kept++; });
  }
  for (const e of [...entries].reverse()) {
    if (e.kind !== "dir") continue;
    await fsp.rmdir(at(root, e.rel)).catch((err: NodeJS.ErrnoException) => { if (err.code !== "ENOENT") kept++; });
  }
  return kept;
}

// ---- the destination ----------------------------------------------------------------------------------------------

/** Where an entry lands in `staging`, refusing anything that isn't a plain relative path. */
function landing(staging: string, rel: string): string {
  const parts = rel === "" ? [] : rel.split("/");
  if (parts.some((p) => p === "" || p === "." || p === ".." || p.includes("\\") || p.includes("\0") || (process.platform === "win32" && p.includes(":")))) {
    throw new ContractError("invalid", `${rel} isn't a plain path`);
  }
  return at(staging, rel);
}

/** One entry into `staging`, made exclusively. */
async function make(staging: string, e: Entry): Promise<FileHandle | null> {
  const p = landing(staging, e.rel);
  if (e.kind === "dir") {
    await fsp.mkdir(p, { mode: (e.mode & 0o777) | 0o700 });
    return null;
  }
  if (e.kind === "link") {
    const t = String(e.target ?? "");
    if (t === "" || isAbsolute(t) || t.includes("\\") || !inside(staging, resolvePath(dirname(p), t))) throw new ContractError("refused", `${e.rel} would lead out of what's moving`);
    await fsp.symlink(t.split("/").join(sep), p);
    return null;
  }
  return fsp.open(p, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL, 0o600);
}

async function finishFile(fh: FileHandle, mode: number): Promise<void> {
  try {
    await fh.datasync();
    if (process.platform !== "win32") await fh.chmod(mode & 0o777);
  } finally {
    await fh.close();
  }
}

/** Takes a stream of entries into `staging` (which must not exist). */
function receive(stream: LinkStream, staging: string): Promise<{ sendId: string; files: number; bytes: number }> {
  return new Promise((resolveP, rejectP) => {
    const frames = new Frames();
    let sendId = "";
    let files = 0;
    let bytes = 0;
    let current: { fh: FileHandle; left: number; mode: number } | null = null;
    let chain = Promise.resolve();
    let failed = false;
    const fail = (e: unknown) => {
      if (failed) return;
      failed = true;
      stream.abort("the destination couldn't take it");
      const c = current;
      current = null;
      void c?.fh.close().catch(() => {});
      rejectP(e);
    };
    const onFrame = async (type: number, payload: Uint8Array) => {
      if (type === T_ERROR) throw ContractError.fromJSON(unjson(payload));
      if (type === T_START) {
        sendId = String((unjson(payload) as { sendId?: unknown }).sendId ?? "");
        return;
      }
      if (!sendId) throw new ContractError("invalid", "entries came before the start");
      if (type === T_ENTRY) {
        if (current) throw new ContractError("failed", "an entry came before the last file was whole");
        const e = unjson(payload) as Entry;
        const fh = await make(staging, e);
        if (fh) {
          files++;
          if ((e.size ?? 0) === 0) await finishFile(fh, e.mode);
          else current = { fh, left: e.size ?? 0, mode: e.mode };
        }
        return;
      }
      if (type === T_DATA) {
        const c = current;
        if (!c) throw new ContractError("failed", "file bytes came with no file");
        if (payload.length > c.left) throw new ContractError("failed", "a file came longer than it said");
        let off = 0;
        while (off < payload.length) off += (await c.fh.write(payload, off, payload.length - off)).bytesWritten;
        c.left -= payload.length;
        bytes += payload.length;
        if (c.left === 0) {
          current = null;
          await finishFile(c.fh, c.mode);
        }
        return;
      }
      throw new ContractError("invalid", "a frame the direct path doesn't send");
    };
    stream.onData((chunk) => {
      try {
        frames.push(chunk, (type, payload) => {
          chain = chain.then(() => (failed ? undefined : onFrame(type, payload))).catch(fail);
        });
      } catch (e) {
        fail(e);
      }
    });
    stream.onEnd((err) => {
      chain = chain.then(() => {
        if (failed) return;
        if (err) throw err;
        if (current) throw new ContractError("failed", "the stream ended in the middle of a file");
        if (!sendId) throw new ContractError("failed", "nothing was sent");
        resolveP({ sendId, files, bytes });
      }).catch(fail);
    });
  });
}

/** A file's bytes from the source into `fh`, in parts, from the very file that was walked (opened without following
 *  a link, its inode compared). */
async function copyInto(root: string, e: Sent, fh: FileHandle): Promise<void> {
  const src = await fsp.open(at(root, e.rel), FS.O_RDONLY | (process.platform === "win32" ? 0 : FS.O_NOFOLLOW ?? 0));
  try {
    if ((await src.stat({ bigint: true })).ino !== e.ino) throw new ContractError("conflict", `${e.rel || basename(root)} changed while it was being copied`);
    const buf = new Uint8Array(CHUNK);
    let left = e.size ?? 0;
    let pos = 0;
    while (left > 0) {
      const { bytesRead } = await src.read(buf, 0, Math.min(CHUNK, left), pos);
      if (bytesRead === 0) throw new ContractError("conflict", `${e.rel || basename(root)} got shorter while it was being copied`);
      let off = 0;
      while (off < bytesRead) off += (await fh.write(buf, off, bytesRead - off)).bytesWritten;
      left -= bytesRead;
      pos += bytesRead;
    }
  } finally {
    await src.close();
  }
}

/** Moves the finished copy into place, never over something that's there: a file by a new link (which refuses an
 *  existing name); a folder by a rename that refuses one too (`renameat2`'s `RENAME_NOREPLACE`, `renameatx_np`'s
 *  `RENAME_EXCL`), anchored at the destination's folder (check 2's N2). Where the C library has neither (Windows,
 *  whose rename doesn't replace a folder anyway), a checked rename. */
async function placeInto(staging: string, real: string, label: string, root?: string): Promise<void> {
  const st = await fsp.lstat(staging);
  if (st.isFile()) {
    try {
      await fsp.link(staging, real);
      await fsp.unlink(staging);
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new ContractError("conflict", `${label} already exists`);
      // A disk without hard links: the rename below, after the same check.
    }
  }
  const at = process.platform === "win32" || root === undefined ? null : atOps();
  if (at && root !== undefined) {
    const rel = relative(root, dirname(real));
    if (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`)) {
      if (at.renameNew(root, rel === "" ? [] : rel.split(sep), basename(staging), basename(real), label)) return;
    }
  }
  if (await fsp.lstat(real).then(() => true, () => false)) throw new ContractError("conflict", `${label} already exists`);
  await fsp.rename(staging, real);
}

/** The deepest folder above `real` that exists already: what a failure leaves in place. */
async function existingAbove(real: string): Promise<string> {
  let d = dirname(real);
  while (!(await fsp.lstat(d).then(() => true, () => false))) {
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  return d;
}

/** After a failure: the hidden copy, and the folders made above it for it while they are still empty. */
async function cleanUp(staging: string, made: string): Promise<void> {
  await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
  for (let d = dirname(staging); d !== made && inside(made, d); d = dirname(d)) {
    if (!(await fsp.rmdir(d).then(() => true, () => false))) break;
  }
}

/** A move or copy whose two ends are on this disk: two holders here (the conformance harness), or one. */
export async function localTransfer(src: LocalHolder, dst: LocalHolder, p: ReceiveParams, as: Caller): Promise<TransferResult> {
  const dcall: HolderCall = { as, level: p.level, ...(p.answer ? { answer: p.answer } : {}) };
  const scall: HolderCall = { as, level: p.level, ...(p.answer ? { answer: p.answer } : {}) };
  const to = await dst.realEntry(p.to, dcall, "write");
  if (to.exists) throw new ContractError("conflict", `${p.to} already exists`);
  const from = await src.realEntry(p.from, scall, p.move ? "delete" : "read");
  if (!from.exists) throw new ContractError("not_found", `${p.from} doesn't exist`);
  if (inside(from.real, to.real)) throw new ContractError("invalid", `${p.to} is inside ${p.from}`);
  // The whole operation, judged once at each end before anything lands.
  await judgeEnd(dst, dcall, "destination", p.move, p.from, p.to, src.name, dst.name);
  if (src !== dst) await judgeEnd(src, scall, "source", p.move, p.from, p.to, src.name, dst.name);
  const entries = await walk(src, from.real, scall, p.move);
  const kept = await existingAbove(to.real);
  await dst.makeParents(to, p.to);
  const staging = join(dirname(to.real), `.clover-receiving-${randomUUID()}`);
  let files = 0;
  let bytes = 0;
  try {
    for (const e of entries) {
      const fh = await make(staging, e);
      if (!fh) continue;
      try {
        await copyInto(from.real, e, fh);
      } catch (err) {
        await fh.close().catch(() => {});
        throw err;
      }
      await finishFile(fh, e.mode);
      files++;
      bytes += e.size ?? 0;
    }
    await placeInto(staging, to.real, p.to, to.root);
  } catch (e) {
    await cleanUp(staging, kept);
    throw e;
  }
  return { files, bytes, kept: p.move ? await removeSent(from.real, entries) : 0 };
}

// ---- serving both ends --------------------------------------------------------------------------------------------

export interface TransferOptions {
  transport: LinkTransport;
  holder: LocalHolder;
  /** Where a tree path lives: its computer and device, or a null device for this computer. */
  deviceFor: (path: string) => { computer: string; device: string | null };
  /** Whether `device` may call at all: a paired computer, not revoked. */
  mayCall: (device: string) => boolean;
  /** The per-computer bulk slots this computer's tree service uses: another computer's transfers here count in them,
   *  as its writes do (the controller's call on check 2's N3). */
  bulk: BulkSlots;
}

const JudgeParams = z.object({ from: TreePath, to: TreePath, move: z.boolean(), role: z.enum(["source", "destination"]), session: SessionId.optional(), level: Level });

/** Ends a `tree.send` stream with the error, so the destination answers with its code. */
async function refuseStream(stream: LinkStream, e: unknown): Promise<void> {
  const err = e instanceof ContractError ? e : new ContractError("failed", (e as Error)?.message ?? "failed");
  try {
    await stream.write(frame(T_ERROR, json(err.toJSON())));
    stream.end();
  } catch {
    stream.abort(err.message);
  }
}

/** Serves `tree.receive` (this computer is the destination), the `tree.send` stream and `tree.sent` (the source), and
 *  `tree.judge`: whether this computer's level needs the user's answer for its part, with its card if so. */
export function serveTransfer(o: TransferOptions): { receiveHere: (p: ReceiveParams, as: Caller) => Promise<TransferResult>; close: Unsubscribe } {
  const t = o.transport;
  const pending = new Map<string, { device: string; real: string; entries: Sent[]; timer: ReturnType<typeof setTimeout> }>();
  const offs: Unsubscribe[] = [];

  const receiveHere = async (p: ReceiveParams, as: Caller): Promise<TransferResult> => {
    const src = o.deviceFor(p.from);
    if (src.device === null) return localTransfer(o.holder, o.holder, p, as);
    const call: HolderCall = { as, level: p.level, ...(p.answer ? { answer: p.answer } : {}) };
    const dst = await o.holder.realEntry(p.to, call, "write");
    if (dst.exists) throw new ContractError("conflict", `${p.to} already exists`);
    await judgeEnd(o.holder, call, "destination", p.move, p.from, p.to, src.computer, o.holder.name);
    const above = await existingAbove(dst.real);
    await o.holder.makeParents(dst, p.to);
    const staging = join(dirname(dst.real), `.clover-receiving-${randomUUID()}`);
    let link: Link;
    try {
      link = await t.connect(src.device);
    } catch (e) {
      await cleanUp(staging, above);
      throw offlineAs(src.computer, e);
    }
    const stream = link.openStream("tree.send", "files", {
      from: p.from, to: p.to, move: p.move, level: p.level,
      ...(p.session ? { session: p.session } : {}), ...(p.answer ? { answer: p.answer } : {}),
    } satisfies z.infer<typeof SendMeta>);
    let got: { sendId: string; files: number; bytes: number };
    try {
      got = await receive(stream, staging);
      await placeInto(staging, dst.real, p.to, dst.root);
    } catch (e) {
      await cleanUp(staging, above);
      throw offlineAs(src.computer, e);
    }
    // In place: the source may let go of what it sent. A source that doesn't hear this keeps it (two copies, never none).
    let kept = 0;
    if (p.move) {
      const r = await link.request<{ kept?: number }>("tree.sent", { sendId: got.sendId }, { priority: "files" }).catch(() => ({ kept: -1 }));
      kept = r.kept === -1 ? got.files : Math.max(0, Number(r.kept ?? 0));
    }
    return { files: got.files, bytes: got.bytes, kept };
  };

  offs.push(t.handle("tree.receive", async (raw, from) => {
    if (!o.mayCall(from)) throw new ContractError("refused", "this computer isn't paired with yours");
    const p = ReceiveParams.safeParse(raw);
    if (!p.success) throw new ContractError("invalid", `tree.receive: ${p.error.issues[0]?.message ?? "bad params"}`);
    // The receiver stamps who the call is for (review N2): a peer, for the session it names.
    const as: Caller = { kind: "peer", device: from, ...(p.data.session ? { sessionId: p.data.session } : {}) };
    return o.bulk.run(from, () => receiveHere(p.data, as));
  }));

  offs.push(t.onStream("tree.send", (stream, meta, from) => {
    void o.bulk.run(from, async () => {
      try {
        if (!o.mayCall(from)) throw new ContractError("refused", "this computer isn't paired with yours");
        const parsed = SendMeta.safeParse(meta);
        if (!parsed.success) throw new ContractError("invalid", "tree.send: bad params");
        const m = parsed.data;
        if (o.deviceFor(m.from).device !== null) throw new ContractError("invalid", `${m.from} isn't on this computer`);
        const as: Caller = { kind: "peer", device: from, ...(m.session ? { sessionId: m.session } : {}) };
        const call: HolderCall = { as, level: m.level, ...(m.answer ? { answer: m.answer } : {}) };
        const src = await o.holder.realEntry(m.from, call, m.move ? "delete" : "read");
        if (!src.exists) throw new ContractError("not_found", `${m.from} doesn't exist`);
        await judgeEnd(o.holder, call, "source", m.move, m.from, m.to, o.holder.name, o.deviceFor(m.to).computer);
        const entries = await walk(o.holder, src.real, call, m.move);
        const sendId = randomUUID();
        if (m.move) {
          const timer = setTimeout(() => pending.delete(sendId), SENT_WAIT_MS);
          (timer as { unref?: () => void }).unref?.();
          pending.set(sendId, { device: from, real: src.real, entries, timer });
        }
        await send(stream, src.real, entries, sendId);
        stream.end();
      } catch (e) {
        await refuseStream(stream, e);
      }
    }).catch((e: unknown) => refuseStream(stream, e));
  }));

  offs.push(t.handle("tree.judge", async (raw, from) => {
    if (!o.mayCall(from)) throw new ContractError("refused", "this computer isn't paired with yours");
    const p = JudgeParams.safeParse(raw);
    if (!p.success) throw new ContractError("invalid", `tree.judge: ${p.error.issues[0]?.message ?? "bad params"}`);
    const as: Caller = { kind: "peer", device: from, ...(p.data.session ? { sessionId: p.data.session } : {}) };
    // No answer goes with it, so none is spent: allowed, refused, or a refusal that names this computer's card.
    const d = p.data;
    await judgeEnd(o.holder, { as, level: d.level }, d.role, d.move, d.from, d.to, o.deviceFor(d.from).computer, o.deviceFor(d.to).computer);
    return { ok: true };
  }));

  offs.push(t.handle("tree.sent", async (raw, from) => {
    if (!o.mayCall(from)) throw new ContractError("refused", "this computer isn't paired with yours");
    const id = String((raw as { sendId?: unknown } | null)?.sendId ?? "");
    const s = pending.get(id);
    if (!s || s.device !== from) return { kept: 0 };
    pending.delete(id);
    clearTimeout(s.timer);
    return { kept: await removeSent(s.real, s.entries) };
  }));

  return {
    receiveHere,
    close: () => {
      for (const off of offs) off();
      for (const s of pending.values()) clearTimeout(s.timer);
      pending.clear();
    },
  };
}

/** The caller's side: asks the destination to take `from` straight from its holder. */
export async function transfer(o: {
  transport: LinkTransport;
  /** The destination's computer and device, or a null device when it is this computer. */
  destination: { computer: string; device: string | null };
  /** This computer's own `receiveHere`, for a destination here. */
  receiveHere: (p: ReceiveParams, as: Caller) => Promise<TransferResult>;
  params: ReceiveParams;
  as: Caller;
}): Promise<TransferResult> {
  if (o.destination.device === null) return o.receiveHere(o.params, o.as);
  let link: Link;
  try {
    link = await o.transport.connect(o.destination.device);
  } catch (e) {
    throw offlineAs(o.destination.computer, e);
  }
  try {
    return await link.request<TransferResult>("tree.receive", o.params, { priority: "files" });
  } catch (e) {
    throw offlineAs(o.destination.computer, e);
  }
}

type End = { computer: string; device: string | null };

/** R1 for the direct path: asks every holder that will judge the operation as a peer whether it needs the user's
 *  answer, asks the user with each holder's card, then sends the call once with every answer. A holder that still
 *  asks (its reviewer changed its mind) is asked about once more. */
export async function transferAsking(o: {
  transport: LinkTransport;
  /** This computer's holder, for its own part when it is the source. */
  holder: LocalHolder;
  receiveHere: (p: ReceiveParams, as: Caller) => Promise<TransferResult>;
  source: End;
  destination: End;
  params: ReceiveParams;
  as: Caller;
  ask?: AnswerAsker;
}): Promise<TransferResult> {
  const p: ReceiveParams = { ...o.params };
  // One card for the whole operation, whichever holders ask: the same signed answer goes to both.
  const put = (answer: SignedCardAnswer) => {
    p.answer = answer;
  };
  if (o.ask && !p.answer) {
    const parts: { role: "source" | "destination"; end: End }[] = [];
    // The destination judges the call as a peer's unless it is this computer; the source judges the destination's
    // stream as a peer's whenever the two differ.
    if (o.destination.device !== null) parts.push({ role: "destination", end: o.destination });
    if (o.source.computer !== o.destination.computer) parts.push({ role: "source", end: o.source });
    let need: NeedsAnswer | null = null;
    for (const { role, end } of parts) {
      const n = await judgeAt(o, role, end, p).then(() => null, (e: unknown) => {
        const got = answerNeeded(e);
        if (!got) throw e; // a holder that refuses outright (read-only) refuses the whole operation
        return got;
      });
      need ??= n;
    }
    if (need) {
      const answer = await o.ask(need);
      if (!answer) throw new ContractError("refused", "the user didn't approve this");
      put(answer);
    }
  }
  for (let attempt = 0; ; attempt++) {
    try {
      return await transfer({ transport: o.transport, destination: o.destination, receiveHere: o.receiveHere, params: p, as: o.as });
    } catch (e) {
      const need = answerNeeded(e);
      if (!need || !o.ask || attempt >= 1) throw e;
      const answer = await o.ask(need);
      if (!answer) throw e;
      put(answer);
    }
  }
}

/** One holder's answer to `tree.judge`, here or over the link. */
async function judgeAt(o: { transport: LinkTransport; holder: LocalHolder; source: End; destination: End }, role: "source" | "destination", end: End, p: ReceiveParams): Promise<void> {
  if (end.device === null) {
    // This computer as the source: it will judge the destination's stream as that computer's peer call.
    const as: Caller = { kind: "peer", device: o.destination.device ?? "", ...(p.session ? { sessionId: p.session } : {}) };
    await judgeEnd(o.holder, { as, level: p.level }, role, p.move, p.from, p.to, o.source.computer, o.destination.computer);
    return;
  }
  let link: Link;
  try {
    link = await o.transport.connect(end.device);
  } catch (e) {
    throw offlineAs(end.computer, e);
  }
  try {
    await link.request("tree.judge", { from: p.from, to: p.to, move: p.move, role, level: p.level, ...(p.session ? { session: p.session } : {}) });
  } catch (e) {
    throw offlineAs(end.computer, e);
  }
}
