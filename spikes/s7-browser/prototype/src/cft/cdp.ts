// A minimal CDP client for a browser the daemon starts itself, over --remote-debugging-pipe (fd 3 commands in,
// fd 4 answers out, NUL-framed JSON): no port, so no other local process — a bot's Bash included — can reach the
// browser. The port road (--remote-debugging-port=0, read from stderr) is here only to compare, and as a fallback
// where the pipe can't be made.
import { spawn, type ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";

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

export class Browser {
  readonly proc: ChildProcess;
  readonly transport: "pipe" | "port";
  readonly stderr: string[] = [];
  private out?: Writable;
  private ws?: WebSocket;
  private nextId = 1;
  private buf = "";
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<(e: CdpEvent) => void>();
  exited = false;
  exitCode: number | null = null;
  exitSignal: string | null = null;

  private constructor(proc: ChildProcess, transport: "pipe" | "port") {
    this.proc = proc;
    this.transport = transport;
    proc.stderr?.on("data", (d: Buffer) => {
      for (const line of d.toString("utf8").split("\n")) if (line.trim() !== "" && this.stderr.length < 400) this.stderr.push(line.slice(0, 300));
    });
    proc.on("exit", (code, signal) => {
      this.exited = true;
      this.exitCode = code;
      this.exitSignal = signal;
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new CdpError(`browser exited (${code ?? signal}) during ${p.method}`)); }
      this.pending.clear();
    });
  }

  /** Start a browser and connect to it. `args` are the browser's own switches (no debugging switch). */
  static async launch(bin: string, args: string[], transport: "pipe" | "port" = "pipe", timeoutMs = 30_000): Promise<Browser> {
    if (transport === "pipe") {
      const proc = spawn(bin, ["--remote-debugging-pipe", ...args], { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"], windowsHide: true });
      const b = new Browser(proc, "pipe");
      b.out = proc.stdio[3] as Writable;
      const input = proc.stdio[4] as Readable | null;
      if (b.out == null || input == null) { proc.kill("SIGKILL"); throw new CdpError("the runtime did not give the child fds 3 and 4"); }
      b.out.on("error", () => undefined);
      input.on("data", (chunk: Buffer) => b.onData(chunk.toString("utf8")));
      await b.send("Browser.getVersion", {}, undefined, timeoutMs);
      return b;
    }
    const proc = spawn(bin, ["--remote-debugging-port=0", ...args], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    const b = new Browser(proc, "port");
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new CdpError("no DevTools URL on stderr")), timeoutMs);
      const onData = (d: Buffer): void => {
        const m = /DevTools listening on (ws:\/\/\S+)/.exec(d.toString("utf8"));
        if (m !== null) { clearTimeout(timer); proc.stderr?.off("data", onData); resolve(m[1]!); }
      };
      proc.stderr?.on("data", onData);
      proc.on("exit", () => { clearTimeout(timer); reject(new CdpError(`browser exited before listening: ${b.stderr.slice(-5).join(" | ")}`)); });
    });
    const ws = new WebSocket(url);
    b.ws = ws;
    await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new CdpError("websocket")); });
    ws.onmessage = (e) => b.onMessage(String(e.data));
    await b.send("Browser.getVersion", {}, undefined, timeoutMs);
    return b;
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
      if (this.transport === "pipe") this.out!.write(`${text}\0`);
      else this.ws!.send(text);
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
