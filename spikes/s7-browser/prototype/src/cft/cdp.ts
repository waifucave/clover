// A minimal CDP client for a browser the daemon starts itself, over --remote-debugging-pipe (NUL-framed JSON): no
// port, so no other local process — a bot's Bash included — can reach the browser. On macOS and Linux the pipe is
// fds 3 (commands in) and 4 (answers out); on Windows it is two inherited pipe handles named with
// --remote-debugging-io-pipes (winpipe.ts). The port road (--remote-debugging-port=0, read from stderr) is here to
// compare, and as the fallback where no pipe can be made.
import { spawn, type ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { makeWinPipes, type WinPipes } from "./winpipe.ts";

export type CdpEvent = { method: string; params: Record<string, unknown>; sessionId?: string };

interface Pending { resolve(v: unknown): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout>; method: string }

export class CdpError extends Error {
  constructor(message: string, readonly code?: number) { super(message); }
}

/** Split NUL-framed messages out of a growing buffer. Pure. */
export function splitNul(buf: string): { messages: string[]; rest: string } {
  const messages: string[] = [];
  let rest = buf;
  for (;;) {
    const i = rest.indexOf("\0");
    if (i < 0) break;
    messages.push(rest.slice(0, i));
    rest = rest.slice(i + 1);
  }
  return { messages, rest };
}

export type Transport = "pipe" | "winpipe" | "port";

export class Browser {
  readonly proc: ChildProcess;
  readonly transport: Transport;
  readonly stderr: string[] = [];
  private out?: Writable;
  private win?: WinPipes;
  private ws?: WebSocket;
  private nextId = 1;
  private buf = "";
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<(e: CdpEvent) => void>();
  exited = false;
  exitCode: number | null = null;
  exitSignal: string | null = null;
  private readonly exitWaiters: Array<() => void> = [];

  private constructor(proc: ChildProcess, transport: Transport) {
    this.proc = proc;
    this.transport = transport;
    const dec = new StringDecoder("utf8");
    let partial = "";
    proc.stderr?.on("data", (d: Buffer) => {
      const lines = (partial + dec.write(d)).split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim() === "") continue;
        this.stderr.push(line.slice(0, 300));
        if (this.stderr.length > 200) this.stderr.shift(); // keep the newest
      }
    });
    proc.on("exit", (code, signal) => {
      this.exited = true;
      this.exitCode = code;
      this.exitSignal = signal;
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new CdpError(`browser exited (${code ?? signal}) during ${p.method}`)); }
      this.pending.clear();
      this.win?.close();
      for (const w of this.exitWaiters.splice(0)) w();
    });
  }

  /** The last lines the browser printed (for an error report). */
  tail(n = 12): string {
    return this.stderr.slice(-n).join(" | ");
  }

  private async kill(): Promise<void> {
    if (this.exited) return;
    this.proc.kill("SIGKILL");
    await Promise.race([new Promise<void>((r) => this.exitWaiters.push(r)), new Promise((r) => setTimeout(r, 5000))]);
  }

  /**
   * Start a browser and connect to it. `args` are the browser's own switches (no debugging switch). A start that
   * fails kills the browser (so its profile is free again) and says what it printed.
   */
  static async launch(bin: string, args: string[], transport: Transport = "pipe", timeoutMs = 30_000): Promise<Browser> {
    let b: Browser | undefined;
    try {
      if (transport === "pipe") {
        const proc = spawn(bin, ["--remote-debugging-pipe", ...args], { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"], windowsHide: true });
        b = new Browser(proc, "pipe");
        b.out = proc.stdio[3] as Writable;
        const input = proc.stdio[4] as Readable | null;
        if (b.out == null || input == null) throw new CdpError("the runtime did not give the child fds 3 and 4");
        b.out.on("error", () => undefined);
        const dec = new StringDecoder("utf8");
        const self = b;
        input.on("data", (chunk: Buffer) => self.onData(dec.write(chunk)));
      } else if (transport === "winpipe") {
        const pipes = await makeWinPipes();
        const proc = spawn(bin, ["--remote-debugging-pipe", `--remote-debugging-io-pipes=${pipes.childRead},${pipes.childWrite}`, ...args], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
        b = new Browser(proc, "winpipe");
        b.win = pipes;
        pipes.closeChildEnds();
        const self = b;
        pipes.start((text) => self.onData(text), () => undefined);
      } else {
        const proc = spawn(bin, ["--remote-debugging-port=0", ...args], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
        b = new Browser(proc, "port");
        const self = b;
        const url = await new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => reject(new CdpError("no DevTools URL on stderr")), timeoutMs);
          const onData = (d: Buffer): void => {
            const m = /DevTools listening on (ws:\/\/\S+)/.exec(d.toString("utf8"));
            if (m !== null) { clearTimeout(timer); proc.stderr?.off("data", onData); resolve(m[1]!); }
          };
          proc.stderr?.on("data", onData);
          proc.on("exit", () => { clearTimeout(timer); reject(new CdpError(`browser exited before listening`)); });
        });
        const ws = new WebSocket(url);
        b.ws = ws;
        await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new CdpError("websocket")); });
        ws.onmessage = (e) => self.onMessage(String(e.data));
      }
      await b.send("Browser.getVersion", {}, undefined, timeoutMs);
      return b;
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      if (b !== undefined) {
        await b.kill();
        throw new CdpError(`${transport} start failed: ${why}${b.exitCode !== null || b.exitSignal !== null ? ` (exit ${b.exitCode ?? b.exitSignal})` : ""}; stderr: ${b.tail(8)}`);
      }
      throw new CdpError(`${transport} start failed: ${why}`);
    }
  }

  private onData(text: string): void {
    const { messages, rest } = splitNul(this.buf + text);
    this.buf = rest;
    for (const m of messages) this.onMessage(m);
  }

  private onMessage(text: string): void {
    let msg: { id?: number; result?: unknown; error?: { code: number; message: string }; method?: string; params?: Record<string, unknown>; sessionId?: string };
    try { msg = JSON.parse(text); } catch { return; }
    if (typeof msg.id === "number") {
      const p = this.pending.get(msg.id);
      if (p === undefined) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error !== undefined) p.reject(new CdpError(`${p.method}: ${msg.error.message}`, msg.error.code));
      else p.resolve(msg.result ?? {});
    } else if (typeof msg.method === "string") {
      const e: CdpEvent = { method: msg.method, params: msg.params ?? {}, sessionId: msg.sessionId };
      for (const l of [...this.listeners]) l(e);
    }
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 15_000): Promise<T> {
    if (this.exited) return Promise.reject(new CdpError(`browser gone (${method})`));
    const id = this.nextId++;
    const text = JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) });
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new CdpError(`${method} timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer, method });
      try {
        if (this.transport === "pipe") this.out!.write(`${text}\0`);
        else if (this.transport === "winpipe") this.win!.write(text);
        else this.ws!.send(text);
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new CdpError(`${method}: write failed: ${e instanceof Error ? e.message : String(e)}`));
      }
    });
  }

  on(listener: (e: CdpEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Wait for one event matching `pred`. */
  waitEvent(pred: (e: CdpEvent) => boolean, timeoutMs = 15_000): Promise<CdpEvent> {
    return new Promise((resolve, reject) => {
      const off = this.on((e) => { if (pred(e)) { clearTimeout(timer); off(); resolve(e); } });
      const timer = setTimeout(() => { off(); reject(new CdpError("event timed out")); }, timeoutMs);
    });
  }

  async close(): Promise<void> {
    if (!this.exited) {
      try { await this.send("Browser.close", {}, undefined, 3000); } catch { /* exiting */ }
      const deadline = Date.now() + 5000;
      while (!this.exited && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      if (!this.exited) this.proc.kill("SIGKILL");
    }
    try { this.ws?.close(); } catch { /* closed */ }
  }
}

/** A page target attached in flat mode: commands go with its sessionId. */
export class Page {
  constructor(readonly browser: Browser, readonly targetId: string, readonly sessionId: string) {}

  static async open(browser: Browser, url: string, browserContextId?: string): Promise<Page> {
    const { targetId } = await browser.send<{ targetId: string }>("Target.createTarget", { url: "about:blank", ...(browserContextId === undefined ? {} : { browserContextId }) });
    const { sessionId } = await browser.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
    const page = new Page(browser, targetId, sessionId);
    await page.send("Page.enable");
    await page.send("Runtime.enable");
    if (url !== "about:blank") await page.goto(url);
    return page;
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<T> {
    return this.browser.send<T>(method, params, this.sessionId, timeoutMs);
  }

  async goto(url: string, timeoutMs = 20_000): Promise<void> {
    const loaded = this.browser.waitEvent((e) => e.sessionId === this.sessionId && e.method === "Page.loadEventFired", timeoutMs);
    await this.send("Page.navigate", { url });
    await loaded;
  }

  async eval<T>(expression: string, timeoutMs = 10_000): Promise<T> {
    const r = await this.send<{ result: { value?: T }; exceptionDetails?: { text?: string; exception?: { description?: string } } }>("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, timeoutMs);
    if (r.exceptionDetails !== undefined) throw new CdpError(`page: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? "exception"}`);
    return r.result.value as T;
  }

  async close(): Promise<void> {
    await this.browser.send("Target.closeTarget", { targetId: this.targetId }).catch(() => undefined);
  }
}
