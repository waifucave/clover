// A small Chrome DevTools protocol client for the UI steps of the acceptance run: it attaches to every page and every
// frame of the headless, offscreen desktop app (out-of-process frames included), records each frame's console messages
// and uncaught errors, and lets a step evaluate, type and click inside any of them. The dev app takes the debugging
// port only behind CLOVER_DEV_DEBUG=1 (apps/desktop/src/main/debug-guard.ts); a packaged app never does.

export interface ConsoleEntry { session: string; url: string; level: string; text: string }
export interface FrameInfo { session: string; url: string; type: string }

type Pending = { resolve(v: any): void; reject(e: Error): void };

export class Cdp {
  private seq = 0;
  private readonly pending = new Map<number, Pending>();
  readonly console: ConsoleEntry[] = [];
  readonly frames = new Map<string, FrameInfo>();
  private readonly waiters: (() => void)[] = [];

  private constructor(private readonly ws: WebSocket) {
    ws.addEventListener("message", (m) => this.onMessage(JSON.parse(String(m.data))));
  }

  static async connect(port: number): Promise<Cdp> {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`);
    const { webSocketDebuggerUrl } = (await res.json()) as { webSocketDebuggerUrl: string };
    const ws = new WebSocket(webSocketDebuggerUrl);
    await new Promise<void>((ok, bad) => { ws.addEventListener("open", () => ok()); ws.addEventListener("error", () => bad(new Error("devtools socket"))); });
    const cdp = new Cdp(ws);
    await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    await cdp.send("Target.setDiscoverTargets", { discover: true });
    return cdp;
  }

  close(): void { try { this.ws.close(); } catch { /* gone */ } }

  send<T = any>(method: string, params: object = {}, session?: string): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, ...(session !== undefined ? { sessionId: session } : {}) }));
      setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`${method}: no answer`)); }, 20_000);
    });
  }

  private onMessage(m: any): void {
    if (typeof m.id === "number") {
      const p = this.pending.get(m.id);
      this.pending.delete(m.id);
      if (m.error) p?.reject(new Error(`${m.error.message}`)); else p?.resolve(m.result);
      return;
    }
    const s: string = m.sessionId ?? "browser";
    if (m.method === "Target.attachedToTarget") {
      const sid: string = m.params.sessionId;
      const info = m.params.targetInfo as { url: string; type: string };
      this.frames.set(sid, { session: sid, url: info.url, type: info.type });
      void this.arm(sid);
    } else if (m.method === "Target.targetInfoChanged") {
      for (const f of this.frames.values()) void f;
    } else if (m.method === "Runtime.consoleAPICalled") {
      const text = (m.params.args as { value?: unknown; description?: string }[]).map((a) => (a.value !== undefined ? String(a.value) : a.description ?? "")).join(" ");
      this.console.push({ session: s, url: this.frames.get(s)?.url ?? "", level: m.params.type, text });
    } else if (m.method === "Runtime.exceptionThrown") {
      const d = m.params.exceptionDetails as { text: string; exception?: { description?: string }; url?: string; lineNumber?: number; columnNumber?: number };
      this.console.push({ session: s, url: this.frames.get(s)?.url ?? "", level: "exception", text: `${d.exception?.description ?? d.text} @ ${d.url ?? ""}:${d.lineNumber ?? "?"}:${d.columnNumber ?? "?"}` });
    } else if (m.method === "Log.entryAdded") {
      const e = m.params.entry as { level: string; text: string; url?: string };
      this.console.push({ session: s, url: this.frames.get(s)?.url ?? "", level: `log.${e.level}`, text: `${e.text} ${e.url ?? ""}` });
    }
    for (const w of this.waiters.splice(0)) w();
  }

  private async arm(sid: string): Promise<void> {
    const t = (method: string, params: object = {}) => this.send(method, params, sid).catch(() => undefined);
    await t("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    await t("Runtime.enable");
    await t("Log.enable");
    await t("Page.enable");
    await t("Runtime.runIfWaitingForDebugger");
  }

  /** The URL a session's document has now. */
  async urlOf(session: string): Promise<string> {
    const r = await this.send<{ result: { value?: string } }>("Runtime.evaluate", { expression: "location.href", returnByValue: true }, session).catch(() => undefined);
    return r?.result.value ?? this.frames.get(session)?.url ?? "";
  }

  /** Evaluates in a session; the value, or the thrown message. */
  async evaluate(session: string, expression: string): Promise<unknown> {
    const r = await this.send<{ result: { value?: unknown; description?: string }; exceptionDetails?: { exception?: { description?: string }; text: string } }>(
      "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, session);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }

  /** Every attached document: its session, URL now, and title. */
  async documents(): Promise<{ session: string; url: string; text: string }[]> {
    const out: { session: string; url: string; text: string }[] = [];
    for (const f of this.frames.values()) {
      if (f.type !== "page" && f.type !== "iframe" && f.type !== "webview") continue;
      try {
        const v = (await this.evaluate(f.session, "JSON.stringify({u:location.href,t:(document.body&&document.body.innerText||'').slice(0,400)})")) as string;
        const o = JSON.parse(v) as { u: string; t: string };
        out.push({ session: f.session, url: o.u, text: o.t });
      } catch { /* a frame that is gone */ }
    }
    return out;
  }

  /** Waits until `probe` is truthy for some document, polling; the document that satisfied it. */
  async waitFor(what: string, timeoutMs: number, probe: (d: { session: string; url: string; text: string }) => boolean): Promise<{ session: string; url: string; text: string }> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      for (const d of await this.documents()) if (probe(d)) return d;
      if (Date.now() > end) throw new Error(`${what}: not within ${Math.round(timeoutMs / 1000)} s`);
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  /** A trusted click at a point of a session's viewport (CSS pixels). */
  async click(session: string, x: number, y: number): Promise<void> {
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
      await this.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1, buttons: type === "mousePressed" ? 1 : 0 }, session);
    }
  }

  /** The centre of the first element matching `selector` (or whose text contains `text`) in a session, in that session's viewport. */
  async centerOf(session: string, selector: string, text?: string): Promise<{ x: number; y: number } | undefined> {
    const v = await this.evaluate(session, `(() => {
      const els = [...document.querySelectorAll(${JSON.stringify(selector)})];
      const el = ${text === undefined ? "els[0]" : `els.find((e) => (e.innerText || e.getAttribute('aria-label') || '').includes(${JSON.stringify(text)}))`};
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
    })()`);
    return v === null || v === undefined ? undefined : (v as { x: number; y: number });
  }

  /** The main window's pixels (a top-level target only: a frame's session can't capture). */
  async screenshot(): Promise<Buffer> {
    const main = [...this.frames.values()].find((f) => f.type === "page" && f.url === "clover-core://app/");
    if (main === undefined) throw new Error("no main window target");
    const r = await this.send<{ data: string }>("Page.captureScreenshot", { format: "png" }, main.session);
    return Buffer.from(r.data, "base64");
  }
}
