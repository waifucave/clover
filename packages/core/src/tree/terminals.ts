// The terminal panel's backend (B's `terminal.*`; controller ruling R4): the user's shell on any of their computers,
// in a folder of the tree, behind the fence of the computer that holds it. This computer's own terminals are PTYs here
// (`Bun.Terminal`; on Windows, where Bun has no PTY yet, a shell on pipes). Another computer's are opened over the link
// (`terminal.open` and its siblings as peer calls), and their output streams back as `terminal_output`.
//
// * What reaches a terminal is the user's: the UI runtime passes a write only from a real key press or paste in the
//   terminal's own component (lane E). A paste goes whole, wrapped in bracketed-paste markers when the program asked
//   for them (`ESC[?2004h`), and a paste of more than one line waits for the user's OK first; a deny drops it.
// * Another computer can't prove a write is the user's (review N2), so opening a terminal for a peer is judged like a
//   command, at the stricter of the holder's level and the call's: below `automatic` it takes the user's signed answer
//   bound to that open (`terminal.open` with its folder). A dropped link closes the peer's terminals, as ssh does.
import { z } from "zod";
import { Level, SessionId, SignedCardAnswer, TerminalId, TreePath, type Caller } from "@waifucave/clover-protocol";
import { ContractError, type Unsubscribe } from "../contracts/common";
import type { LinkTransport } from "../contracts/link-transport";
import type { LocalHolder } from "./holder";
import { hostOs } from "./names";
import { offlineAs } from "./remote";
import { judgePeer, withAnswer, type AnswerAsker, type Answers } from "./judge";

export interface TerminalOutput {
  terminalId: string;
  data: string;
  exited?: { code: number | null };
}

/** The most one write carries (B's `TERMINAL_WRITE_MAX`). */
export const TERMINAL_WRITE_MAX = 1_000_000;
const BRACKET_ON = "\u001b[?2004h";
const BRACKET_OFF = "\u001b[?2004l";

/** How a shell starts in a folder: the user's own login shell by default. */
export type ShellLauncher = (cwd: string) => { cmd: string[]; env: Record<string, string> };

export function userShell(cwd: string): { cmd: string[]; env: Record<string, string> } {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  env.PWD = cwd;
  env.TERM = "xterm-256color";
  if (hostOs() === "windows") return { cmd: [env.ComSpec ?? "cmd.exe"], env };
  return { cmd: [env.SHELL ?? "/bin/sh", "-l"], env };
}

interface Open {
  id: string;
  /** The device that opened it over the link, or null for this computer's own app. */
  device: string | null;
  /** The session it belongs to; only that session on that device writes to it (R4). */
  session: string | undefined;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
  bracketed: boolean;
}

/** Who a terminal is for: the device that opened it (null for this computer's own app) and its session. */
export interface Owner {
  device: string | null;
  session?: string | undefined;
}
const HERE: Owner = { device: null };
/** This computer's own app reaches every terminal opened here; a peer only those it opened, for the same session. */
const owns = (t: Open, o: Owner) => (o.device === null && t.device === null) || (t.device === o.device && t.session === o.session);

/** This computer's terminals. */
export class LocalTerminals {
  readonly #open = new Map<string, Open>();
  readonly #launch: ShellLauncher;
  readonly #confirmPaste: ((text: string, terminalId: string) => Promise<boolean>) | undefined;
  #seq = 0;

  /** `confirmPaste` shows the user a card for a paste of more than one line (lanes B and C); without it, such a
   *  paste is dropped. */
  constructor(opts: { launch?: ShellLauncher; confirmPaste?: (text: string, terminalId: string) => Promise<boolean> } = {}) {
    this.#launch = opts.launch ?? userShell;
    this.#confirmPaste = opts.confirmPaste;
  }

  get count(): number {
    return this.#open.size;
  }

  /** A shell in `cwd` (a real folder, resolved and fenced by the caller); its output goes to `output`. */
  open(cwd: string, size: { cols: number; rows: number }, owner: Owner, output: (o: TerminalOutput) => void): string {
    const { device, session } = owner;
    const id = `term_${++this.#seq}_${Date.now().toString(36)}`;
    const { cmd, env } = this.#launch(cwd);
    const dec = new TextDecoder();
    let entry!: Open;
    const emit = (data: string) => {
      if (data.includes(BRACKET_ON)) entry.bracketed = true;
      if (data.includes(BRACKET_OFF)) entry.bracketed = false;
      output({ terminalId: id, data });
    };
    const done = (code: number | null) => {
      if (!this.#open.delete(id)) return;
      output({ terminalId: id, data: "", exited: { code } });
    };
    if (hostOs() !== "windows" && typeof Bun.Terminal === "function") {
      const proc = Bun.spawn(cmd, {
        cwd, env,
        terminal: { cols: size.cols, rows: size.rows, data: (_t, bytes) => emit(dec.decode(bytes, { stream: true })) },
      });
      void proc.exited.then((code) => { proc.terminal?.close(); done(code); });
      entry = {
        id, device, session, bracketed: false,
        write: (d) => { proc.terminal?.write(d); },
        resize: (c, r) => proc.terminal?.resize(c, r),
        close: () => { proc.kill(); proc.terminal?.close(); },
      };
    } else {
      // Windows: no PTY in Bun yet (ConPTY waits for a native add-on), so the shell runs on pipes.
      const proc = Bun.spawn(cmd, { cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      const pump = async (s: ReadableStream<Uint8Array>) => { for await (const c of s) emit(dec.decode(c, { stream: true })); };
      void pump(proc.stdout);
      void pump(proc.stderr);
      void proc.exited.then((code) => done(code));
      entry = {
        id, device, session, bracketed: false,
        write: (d) => { proc.stdin.write(d); void proc.stdin.flush(); },
        resize: () => {},
        close: () => proc.kill(),
      };
    }
    this.#open.set(id, entry);
    return id;
  }

  async write(id: string, data: string, opts: { paste?: boolean; owner?: Owner } = {}): Promise<void> {
    const t = this.#mine(id, opts.owner ?? HERE);
    if (data.length > TERMINAL_WRITE_MAX) throw new ContractError("invalid", `a write carries at most ${TERMINAL_WRITE_MAX} characters`);
    if (!opts.paste) {
      t.write(data);
      return;
    }
    if (/[\r\n]/.test(data.replace(/[\r\n]+$/, ""))) {
      const ok = this.#confirmPaste ? await this.#confirmPaste(data, id) : false;
      if (!ok) return; // a deny drops the paste
    }
    t.write(t.bracketed ? `\u001b[200~${data}\u001b[201~` : data);
  }

  resize(id: string, cols: number, rows: number, owner: Owner = HERE): void {
    this.#mine(id, owner).resize(cols, rows);
  }

  close(id: string, owner: Owner = HERE): void {
    const t = this.#open.get(id);
    if (!t || !owns(t, owner)) return;
    t.close();
  }

  /** Closes every terminal a device opened (its link went down). */
  closeDevice(device: string): void {
    for (const t of [...this.#open.values()]) if (t.device === device) t.close();
  }

  closeAll(): void {
    for (const t of [...this.#open.values()]) t.close();
  }

  #mine(id: string, owner: Owner): Open {
    const t = this.#open.get(id);
    if (!t || !owns(t, owner)) throw new ContractError("not_found", `no terminal ${id}`);
    return t;
  }
}

/** The holder's side over the link: `terminal.open`, `terminal.write`, `terminal.resize`, `terminal.close` from a peer,
 *  and `terminal_output` back to it. */
/** What another computer's terminal calls carry here (lane J's peer side of B's `terminal.*`): B's params, with the
 *  folder required, plus the session, the calling computer's level and the user's answer. */
const PeerOpen = z.object({ cwd: TreePath, cols: z.number().int().min(2).max(1000), rows: z.number().int().min(1).max(1000), session: SessionId.optional(), level: Level, answer: SignedCardAnswer.optional() });
const PeerWrite = z.object({ terminalId: TerminalId, data: z.string().max(TERMINAL_WRITE_MAX), paste: z.boolean().optional(), session: SessionId.optional() });
const PeerResize = z.object({ terminalId: TerminalId, cols: z.number().int().min(2).max(1000), rows: z.number().int().min(1).max(1000), session: SessionId.optional() });
const PeerClose = z.object({ terminalId: TerminalId, session: SessionId.optional() });

function parse<T>(schema: z.ZodType<T>, raw: unknown, method: string): T {
  const r = schema.safeParse(raw);
  if (!r.success) throw new ContractError("invalid", `${method}: ${r.error.issues[0]?.message ?? "bad params"}`);
  return r.data;
}

export function serveTerminals(o: {
  transport: LinkTransport;
  holder: LocalHolder;
  terminals: LocalTerminals;
  level: () => Level;
  /** Whether `device` may call at all: a paired computer, not revoked. */
  mayCall: (device: string) => boolean;
  /** What checks the user's signed answer bound to `terminal.open` with its folder (the holder's own card). */
  answers?: Answers;
  clock: { now(): number };
}): Unsubscribe {
  const t = o.transport;
  const offs: Unsubscribe[] = [];
  const guard = (from: string) => {
    if (!o.mayCall(from)) throw new ContractError("refused", "this computer isn't paired with yours");
  };
  offs.push(t.handle("terminal.open", async (raw, from) => {
    guard(from);
    const p = parse(PeerOpen, raw, "terminal.open");
    // Stamped as tool.run is (review N2): a peer, for the session it names, fenced at the folder.
    const as: Caller = { kind: "peer", device: from, ...(p.session ? { sessionId: p.session } : {}) };
    const real = await o.holder.realFolder(p.cwd, { as });
    // An interactive shell has nothing for a reviewer to read: below `automatic` it takes the user's answer.
    await judgePeer({
      computer: o.holder.name, ownLevel: o.level(), callLevel: p.level, effect: "execute",
      method: "terminal.open", params: { cwd: p.cwd }, as, now: o.clock.now(),
      ...(p.answer ? { answer: p.answer } : {}), ...(o.answers ? { answers: o.answers } : {}),
    });
    const id = o.terminals.open(real, { cols: p.cols, rows: p.rows }, { device: from, session: p.session }, (out) => {
      void t.connect(from).then((l) => l.notify("terminal_output", out, { priority: "tokens" }), () => {});
    });
    return { terminalId: id };
  }));
  offs.push(t.handle("terminal.write", async (raw, from) => {
    guard(from);
    const p = parse(PeerWrite, raw, "terminal.write");
    await o.terminals.write(p.terminalId, p.data, { paste: p.paste === true, owner: { device: from, session: p.session } });
    return { ok: true };
  }));
  offs.push(t.handle("terminal.resize", (raw, from) => {
    guard(from);
    const p = parse(PeerResize, raw, "terminal.resize");
    o.terminals.resize(p.terminalId, p.cols, p.rows, { device: from, session: p.session });
    return { ok: true };
  }));
  offs.push(t.handle("terminal.close", (raw, from) => {
    guard(from);
    const p = parse(PeerClose, raw, "terminal.close");
    o.terminals.close(p.terminalId, { device: from, session: p.session });
    return { ok: true };
  }));
  offs.push(t.watch((view) => { if (!view.up) o.terminals.closeDevice(view.peer); }));
  return () => { for (const off of offs) off(); };
}

export interface TerminalRouterOptions {
  transport: LinkTransport;
  self: () => string;
  local: { holder: LocalHolder; terminals: LocalTerminals; level: () => Level };
  /** A computer by name: its device, whether it is online, and the calling computer's level for it. */
  computer: (name: string) => { computer: string; device: string; online: boolean; level: Level } | undefined;
  /** Shows the user the holder's card for opening a terminal there (R1). */
  ask?: AnswerAsker;
}

/** The terminals the app and the panel open (B's `terminal.*`, behind the router's `terminal` capability), on any
 *  computer, in a folder of the tree: this computer's here, another's over the link. */
export class TerminalRouter {
  readonly #o: TerminalRouterOptions;
  /** Remote terminals, by id: which device holds each, and its session. */
  readonly #remote = new Map<string, { device: string; computer: string; session?: string }>();
  readonly #listeners = new Set<(o: TerminalOutput) => void>();
  readonly #off: Unsubscribe;

  constructor(o: TerminalRouterOptions) {
    this.#o = o;
    this.#off = o.transport.onNotify("terminal_output", (params, from) => {
      const out = params as TerminalOutput;
      const r = this.#remote.get(out.terminalId);
      if (!r || r.device !== from) return;
      if (out.exited) this.#remote.delete(out.terminalId);
      this.#emit(out);
    });
  }

  /** Every terminal's output, as `terminal_output` events for the app. */
  onOutput(fn: (o: TerminalOutput) => void): Unsubscribe {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  /** B's `terminal.open`: the user's shell on `computer`, in `cwd` (a tree folder there; its home when left out). `as`
   *  is who asked: the user's app, or a layer with the `terminal` capability, which a computer at read-only refuses. */
  async open(p: { computer: string; cwd?: string; cols: number; rows: number; session?: string; answer?: SignedCardAnswer }, as: Caller = { kind: "user", client: "app" }): Promise<{ terminalId: string }> {
    const where = this.#o.computer(p.computer);
    if (!where) throw new ContractError("not_found", `no computer ${p.computer}`);
    if (!where.online) throw new ContractError("computer_offline", `${where.computer} is offline`, { computer: where.computer });
    const cwd = p.cwd ?? `home/${where.computer}`;
    if (where.computer === this.#o.self()) {
      if (as.kind !== "user" && as.kind !== "core" && this.#o.local.level() === "read-only") {
        throw new ContractError("refused", `${where.computer} is read-only; it opens no terminal for a plugin`);
      }
      const real = await this.#o.local.holder.realFolder(cwd, { as });
      const terminalId = this.#o.local.terminals.open(real, p, { device: null, session: p.session }, (o) => this.#emit(o));
      return { terminalId };
    }
    try {
      const link = await this.#o.transport.connect(where.device);
      const r = await withAnswer(p.answer ? undefined : this.#o.ask, (answer) => link.request<{ terminalId: string }>("terminal.open", {
        cwd, cols: p.cols, rows: p.rows, level: where.level,
        ...(p.session ? { session: p.session } : {}), ...((answer ?? p.answer) ? { answer: answer ?? p.answer } : {}),
      }));
      this.#remote.set(r.terminalId, { device: where.device, computer: where.computer, ...(p.session ? { session: p.session } : {}) });
      return r;
    } catch (e) {
      throw offlineAs(where.computer, e);
    }
  }

  async write(terminalId: string, data: string, opts: { paste?: boolean } = {}): Promise<void> {
    const r = this.#remote.get(terminalId);
    if (!r) return this.#o.local.terminals.write(terminalId, data, opts);
    await this.#request(r, "terminal.write", { terminalId, data, ...(opts.paste ? { paste: true } : {}), ...(r.session ? { session: r.session } : {}) });
  }

  async resize(terminalId: string, cols: number, rows: number): Promise<void> {
    const r = this.#remote.get(terminalId);
    if (!r) return this.#o.local.terminals.resize(terminalId, cols, rows);
    await this.#request(r, "terminal.resize", { terminalId, cols, rows, ...(r.session ? { session: r.session } : {}) });
  }

  async close(terminalId: string): Promise<void> {
    const r = this.#remote.get(terminalId);
    if (!r) return this.#o.local.terminals.close(terminalId);
    this.#remote.delete(terminalId);
    await this.#request(r, "terminal.close", { terminalId, ...(r.session ? { session: r.session } : {}) }).catch(() => {});
  }

  dispose(): void {
    this.#off();
    this.#listeners.clear();
  }

  async #request(r: { device: string; computer: string }, method: string, params: unknown): Promise<void> {
    try {
      const link = await this.#o.transport.connect(r.device);
      await link.request(method, params);
    } catch (e) {
      throw offlineAs(r.computer, e);
    }
  }

  #emit(o: TerminalOutput): void {
    for (const fn of [...this.#listeners]) {
      try {
        fn(o);
      } catch {
        // a listener's failure is its own
      }
    }
  }
}
