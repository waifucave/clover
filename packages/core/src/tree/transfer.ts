// The direct path for moves and copies between computers (the owner's item 89; J-M0 edit 8): the files stream from
// the computer that holds them straight to the one that will, over a link stream between those two, never through a
// third computer and never one round trip per file.
//
//   caller ──tree.receive──▶ destination ──stream "tree.send"──▶ source
//                                        ◀── entries, in order ──
//            ◀── ok ──────── (renamed into place) ──tree.sent──▶ (a move removes the source)
//
// * The destination checks its own fence and level for the write before anything moves, then takes the entries into a
//   hidden folder beside the destination and renames it into place only once everything arrived. A failure removes it;
//   the source is untouched.
// * The source checks its fence for the read, and for a move its level for the move (the delete it implies), before it
//   sends; it removes its copy only when the destination says it has the files (`tree.sent`).
// * Each holder judges at the stricter of its own level and the caller's (R1). A holder that needs the user's answer
//   says so with its own card; the caller asks the user and sends `answer` (for the destination) or `sourceAnswer`
//   (for the source) with the call again.
// * Links travel as links when their target stays inside the moved folder; anything else that isn't a file or a
//   folder is refused before anything moves.
import { randomUUID } from "node:crypto";
import { constants as fsConstants, promises as fsp } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from "node:path";
import { z } from "zod";
import { Level, SessionId, SignedCardAnswer, TreePath, type Caller } from "@waifucave/clover-protocol";
import { ContractError, type Unsubscribe } from "../contracts/common";
import type { Link, LinkStream, LinkTransport } from "../contracts/link-transport";
import type { HolderCall, LocalHolder } from "./holder";
import { answerNeeded, type AnswerAsker } from "./judge";
import { offlineAs } from "./remote";

const CHUNK = 256 * 1024;
/** A sent tree that waits for the destination's word this long is dropped (the source stays). */
const SENT_WAIT_MS = 10 * 60 * 1000;

export const ReceiveParams = z.object({
  from: TreePath, to: TreePath, move: z.boolean(),
  session: SessionId.optional(), level: Level, answer: SignedCardAnswer.optional(), sourceAnswer: SignedCardAnswer.optional(),
});
export type ReceiveParams = z.infer<typeof ReceiveParams>;
const SendMeta = z.object({ from: TreePath, to: TreePath, move: z.boolean(), session: SessionId.optional(), level: Level, answer: SignedCardAnswer.optional() });

interface Entry {
  kind: "dir" | "file" | "link";
  /** Inside the moved folder, with `/`; "" is the folder (or file) itself. */
  rel: string;
  mode: number;
  size?: number;
  target?: string;
}

// ---- framing: 1 byte type, 4 bytes length, payload ------------------------------------------------------------------

function frame(type: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + payload.length);
  out[0] = type;
  new DataView(out.buffer).setUint32(1, payload.length);
  out.set(payload, 5);
  return out;
}
const T_START = 0x53; // 'S': { sendId }
const T_ENTRY = 0x48; // 'H': an Entry
const T_DATA = 0x44; // 'D': file bytes
const T_ERROR = 0x58; // 'X': a ContractError, as JSON

class Frames {
  #buf = new Uint8Array(0);
  push(chunk: Uint8Array, fn: (type: number, payload: Uint8Array) => void): void {
    const next = new Uint8Array(this.#buf.length + chunk.length);
    next.set(this.#buf);
    next.set(chunk, this.#buf.length);
    this.#buf = next;
    while (this.#buf.length >= 5) {
      const len = new DataView(this.#buf.buffer, this.#buf.byteOffset).getUint32(1);
      if (this.#buf.length < 5 + len) break;
      fn(this.#buf[0]!, this.#buf.slice(5, 5 + len));
      this.#buf = this.#buf.slice(5 + len);
    }
  }
}

const json = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
const unjson = (b: Uint8Array) => JSON.parse(new TextDecoder().decode(b)) as unknown;

// ---- the source -------------------------------------------------------------------------------------------------

/** Walks what's sent: folders before their contents, files and links, nothing the caller may not see. Anything else
 *  (a socket, a device) refuses the whole send before a byte moves. */
async function walk(holder: LocalHolder, root: string, call: HolderCall): Promise<Entry[]> {
  const out: Entry[] = [];
  const top = await fsp.lstat(root);
  const visit = async (real: string, rel: string, st: Awaited<ReturnType<typeof fsp.lstat>>) => {
    if (!holder.visible(real, call)) return;
    if (st.isDirectory()) {
      out.push({ kind: "dir", rel, mode: Number(st.mode) & 0o777 });
      for (const name of (await fsp.readdir(real)).sort()) {
        const child = join(real, name);
        await visit(child, rel === "" ? name : `${rel}/${name}`, await fsp.lstat(child));
      }
    } else if (st.isFile()) {
      out.push({ kind: "file", rel, mode: Number(st.mode) & 0o777, size: Number(st.size) });
    } else if (st.isSymbolicLink()) {
      const raw = await fsp.readlink(real);
      const lands = isAbsolute(raw) ? raw : resolvePath(dirname(real), raw);
      const inside = relative(root, lands);
      if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside) || isAbsolute(raw)) {
        throw new ContractError("invalid", `${rel || basename(root)} is a link that leads out of what's moving`);
      }
      out.push({ kind: "link", rel, mode: 0o777, target: raw.split(sep).join("/") });
    } else {
      throw new ContractError("invalid", `${rel || basename(root)} isn't a file, folder or link`);
    }
  };
  await visit(root, "", top);
  return out;
}

async function send(stream: LinkStream, root: string, entries: Entry[], sendId: string): Promise<void> {
  await stream.write(frame(T_START, json({ sendId })));
  for (const e of entries) {
    await stream.write(frame(T_ENTRY, json(e)));
    if (e.kind !== "file") continue;
    const fh = await fsp.open(e.rel === "" ? root : join(root, ...e.rel.split("/")), "r");
    try {
      const buf = new Uint8Array(CHUNK);
      let left = e.size ?? 0;
      let at = 0;
      while (left > 0) {
        const { bytesRead } = await fh.read(buf, 0, Math.min(CHUNK, left), at);
        if (bytesRead === 0) throw new ContractError("failed", `${e.rel} got shorter while it was being sent`);
        await stream.write(frame(T_DATA, buf.slice(0, bytesRead)));
        left -= bytesRead;
        at += bytesRead;
      }
    } finally {
      await fh.close();
    }
  }
}

// ---- the destination ----------------------------------------------------------------------------------------------

/** Takes a stream of entries into `staging` (made empty), then the caller renames it into place. */
function receive(stream: LinkStream, staging: string): Promise<{ sendId: string; files: number; bytes: number }> {
  return new Promise((resolveP, rejectP) => {
    const frames = new Frames();
    let sendId = "";
    let files = 0;
    let bytes = 0;
    let current: { fh: FileHandle; left: number; mode: number } | null = null;
    let chain = Promise.resolve();
    let failed: Error | null = null;
    const fail = (e: unknown) => {
      if (failed) return;
      failed = e instanceof Error ? e : new Error(String(e));
      stream.abort("the destination couldn't take it");
      rejectP(failed);
    };
    const place = (rel: string) => {
      const parts = rel === "" ? [] : rel.split("/");
      if (parts.some((p) => p === "" || p === "." || p === ".." || p.includes("\\") || p.includes("\0"))) throw new ContractError("invalid", `${rel} isn't a plain path`);
      return parts.length === 0 ? staging : join(staging, ...parts);
    };
    const onFrame = async (type: number, payload: Uint8Array) => {
      if (type === T_ERROR) throw ContractError.fromJSON(unjson(payload));
      if (type === T_START) {
        sendId = String((unjson(payload) as { sendId?: unknown }).sendId ?? "");
        return;
      }
      if (type === T_ENTRY) {
        if (current) throw new ContractError("failed", "an entry came before the last file was whole");
        const e = unjson(payload) as Entry;
        const at = place(e.rel);
        if (e.kind === "dir") await fsp.mkdir(at, { recursive: e.rel === "", mode: (e.mode & 0o777) | 0o700 }).catch((err: NodeJS.ErrnoException) => { if (err.code !== "EEXIST") throw err; });
        else if (e.kind === "link") {
          const t = String(e.target ?? "");
          const lands = resolvePath(dirname(at), t);
          const inside = relative(staging, lands);
          if (isAbsolute(t) || inside === ".." || inside.startsWith(`..${sep}`)) throw new ContractError("refused", `${e.rel} would lead out of what's moving`);
          await fsp.symlink(t.split("/").join(sep), at);
        } else {
          const fh = await fsp.open(at, "wx", 0o600);
          current = { fh, left: e.size ?? 0, mode: e.mode };
          files++;
          if (current.left === 0) await finishFile();
        }
        return;
      }
      if (type === T_DATA) {
        if (!current) throw new ContractError("failed", "file bytes came with no file");
        if (payload.length > current.left) throw new ContractError("failed", "a file came longer than it said");
        await current.fh.write(payload);
        current.left -= payload.length;
        bytes += payload.length;
        if (current.left === 0) await finishFile();
      }
    };
    const finishFile = async () => {
      const c = current!;
      current = null;
      await c.fh.datasync();
      if (process.platform !== "win32") await c.fh.chmod(c.mode & 0o777);
      await c.fh.close();
    };
    stream.onData((chunk) => {
      frames.push(chunk, (type, payload) => {
        chain = chain.then(() => (failed ? undefined : onFrame(type, payload))).catch(fail);
      });
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

/** Whether `child` is `parent` or inside it. */
function inside(parent: string, child: string): boolean {
  const r = relative(parent, child);
  return r === "" || (!r.startsWith(`..${sep}`) && r !== ".." && !isAbsolute(r));
}

/** Removes what was sent, and only that: files and links, then the folders left empty, deepest first. Anything that
 *  came into the source after it was sent stays (two copies, never none). */
async function removeSent(root: string, entries: readonly Entry[]): Promise<void> {
  const at = (rel: string) => (rel === "" ? root : join(root, ...rel.split("/")));
  for (const e of entries) if (e.kind !== "dir") await fsp.unlink(at(e.rel)).catch(() => {});
  for (const e of [...entries].reverse()) if (e.kind === "dir") await fsp.rmdir(at(e.rel)).catch(() => {});
}

/** A copy within this computer, entry by entry into `staging`. */
async function copyHere(root: string, entries: Entry[], staging: string): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  for (const e of entries) {
    const from = e.rel === "" ? root : join(root, ...e.rel.split("/"));
    const at = e.rel === "" ? staging : join(staging, ...e.rel.split("/"));
    if (e.kind === "dir") await fsp.mkdir(at, { mode: (e.mode & 0o777) | 0o700 });
    else if (e.kind === "link") await fsp.symlink(e.target!.split("/").join(sep), at);
    else {
      await fsp.copyFile(from, at, fsConstants.COPYFILE_EXCL);
      if (process.platform !== "win32") await fsp.chmod(at, e.mode & 0o777);
      files++;
      bytes += e.size ?? 0;
    }
  }
  return { files, bytes };
}

// ---- serving both ends --------------------------------------------------------------------------------------------

export interface TransferOptions {
  transport: LinkTransport;
  holder: LocalHolder;
  /** Where a tree path lives: its computer's device, or null for this computer. */
  deviceFor: (path: string) => { computer: string; device: string | null };
  mayCall?: (device: string) => boolean;
  clock: { now(): number };
}

/** Serves `tree.receive` (this computer is the destination), the `tree.send` stream and `tree.sent` (the source). */
export function serveTransfer(o: TransferOptions): { receiveHere: (p: ReceiveParams, as: Caller) => Promise<{ files: number; bytes: number }>; close: Unsubscribe } {
  const t = o.transport;
  const pending = new Map<string, { device: string; real: string; entries: Entry[]; timer: ReturnType<typeof setTimeout> }>();
  const offs: Unsubscribe[] = [];

  const receiveHere = async (p: ReceiveParams, as: Caller): Promise<{ files: number; bytes: number }> => {
    const call: HolderCall = { as, level: p.level, ...(p.answer ? { answer: p.answer } : {}) };
    const dst = await o.holder.realEntry(p.to, call, "write");
    if (dst.exists) throw new ContractError("conflict", `${p.to} already exists`);
    await o.holder.judge(call, "tree.receive", { from: p.from, to: p.to, move: p.move }, p.move ? "move" : "edit");
    const src = o.deviceFor(p.from);
    await o.holder.makeParents(dst, p.to);
    const staging = join(dirname(dst.real), `.clover-receiving-${randomUUID()}`);
    const into = async () => {
      // Into place only where nothing came meanwhile.
      if (await fsp.lstat(dst.real).then(() => true, () => false)) throw new ContractError("conflict", `${p.to} already exists`);
      await fsp.rename(staging, dst.real);
    };
    if (src.device === null) {
      // Both ends here (a copy, or a peer's move within this computer): the same checks, no link.
      const from = await o.holder.realEntry(p.from, call, p.move ? "delete" : "read");
      if (!from.exists) throw new ContractError("not_found", `${p.from} doesn't exist`);
      if (inside(from.real, dst.real)) throw new ContractError("invalid", `${p.to} is inside ${p.from}`);
      try {
        const entries = await walk(o.holder, from.real, call);
        const got = await copyHere(from.real, entries, staging);
        await into();
        if (p.move) await removeSent(from.real, entries);
        return got;
      } catch (e) {
        await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
        throw e;
      }
    }
    let link: Link;
    try {
      link = await t.connect(src.device);
    } catch (e) {
      throw offlineAs(src.computer, e);
    }
    const stream = link.openStream("tree.send", "files", {
      from: p.from, to: p.to, move: p.move, level: p.level,
      ...(p.session ? { session: p.session } : {}), ...(p.sourceAnswer ? { answer: p.sourceAnswer } : {}),
    } satisfies z.infer<typeof SendMeta>);
    let got: { sendId: string; files: number; bytes: number };
    try {
      got = await receive(stream, staging);
      await into();
    } catch (e) {
      await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
      throw offlineAs(src.computer, e);
    }
    // In place: the source may let go of its copy. A source that doesn't hear this keeps it (two copies, never none).
    await link.request("tree.sent", { sendId: got.sendId, ok: true }, { priority: "files" }).catch(() => {});
    return { files: got.files, bytes: got.bytes };
  };

  offs.push(t.handle("tree.receive", async (raw, from) => {
    if (o.mayCall && !o.mayCall(from)) throw new ContractError("refused", "this computer isn't paired with yours");
    const p = ReceiveParams.safeParse(raw);
    if (!p.success) throw new ContractError("invalid", `tree.receive: ${p.error.issues[0]?.message ?? "bad params"}`);
    const as: Caller = { kind: "peer", device: from, ...(p.data.session ? { sessionId: p.data.session } : {}) };
    return receiveHere(p.data, as);
  }));

  offs.push(t.onStream("tree.send", (stream, meta, from) => {
    void (async () => {
      try {
        if (o.mayCall && !o.mayCall(from)) throw new ContractError("refused", "this computer isn't paired with yours");
        const m = SendMeta.parse(meta);
        const as: Caller = { kind: "peer", device: from, ...(m.session ? { sessionId: m.session } : {}) };
        const call: HolderCall = { as, level: m.level, ...(m.answer ? { answer: m.answer } : {}) };
        const src = await o.holder.realEntry(m.from, call, m.move ? "delete" : "read");
        if (!src.exists) throw new ContractError("not_found", `${m.from} doesn't exist`);
        if (m.move) await o.holder.judge(call, "tree.send", { from: m.from, to: m.to, move: true }, "move");
        const entries = await walk(o.holder, src.real, call);
        const sendId = randomUUID();
        if (m.move) {
          const timer = setTimeout(() => pending.delete(sendId), SENT_WAIT_MS);
          timer.unref?.();
          pending.set(sendId, { device: from, real: src.real, entries, timer });
        }
        await send(stream, src.real, entries, sendId);
        stream.end();
      } catch (e) {
        const err = e instanceof ContractError ? e : new ContractError("failed", (e as Error)?.message ?? "failed");
        try {
          await stream.write(frame(T_ERROR, json(err.toJSON())));
          stream.end();
        } catch {
          stream.abort(err.message);
        }
      }
    })();
  }));

  offs.push(t.handle("tree.sent", async (raw, from) => {
    const p = (raw ?? {}) as { sendId?: string; ok?: boolean };
    const s = pending.get(String(p.sendId));
    if (!s || s.device !== from) return { ok: true };
    pending.delete(String(p.sendId));
    clearTimeout(s.timer);
    if (p.ok === true) await removeSent(s.real, s.entries);
    return { ok: true };
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

/** The caller's side: asks the destination to take `from` straight from its holder. A holder that needs the user's
 *  answer says so with its card; `ask` shows it and the call goes again with that answer, at most once per holder. */
export async function transfer(o: {
  transport: LinkTransport;
  /** The destination's computer and device, or null when it is this computer. */
  destination: { computer: string; device: string | null };
  /** This computer's own `receiveHere`, for a destination here. */
  receiveHere: (p: ReceiveParams, as: Caller) => Promise<{ files: number; bytes: number }>;
  params: ReceiveParams;
  as: Caller;
  ask?: AnswerAsker;
  sourceComputer: string;
}): Promise<{ files: number; bytes: number }> {
  const p: ReceiveParams = { ...o.params };
  for (let attempt = 0; ; attempt++) {
    try {
      if (o.destination.device === null) return await o.receiveHere(p, o.as);
      let link: Link;
      try {
        link = await o.transport.connect(o.destination.device);
      } catch (e) {
        throw offlineAs(o.destination.computer, e);
      }
      try {
        return await link.request<{ files: number; bytes: number }>("tree.receive", p, { priority: "files" });
      } catch (e) {
        throw offlineAs(o.destination.computer, e);
      }
    } catch (e) {
      const need = answerNeeded(e);
      if (!need || !o.ask || attempt >= 2) throw e;
      const answer = await o.ask(need);
      if (!answer) throw e;
      if (need.computer === o.sourceComputer && !p.sourceAnswer) p.sourceAnswer = answer;
      else if (need.computer === o.destination.computer && !p.answer) p.answer = answer;
      else throw e;
    }
  }
}
