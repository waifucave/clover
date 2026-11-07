// Test fakes: a browser API that behaves like the core's (owner filter, held tabs, the DevTools allow list, stale
// points), with a page whose script answers are scripted per op, and an in-process MCP transport.

import { serveBrowser } from "../src/serve";
import type { McpServerHandle } from "../src/server";
import type { PageCall, PageOp } from "../src/page";
import type { BrowserToolOptions } from "../src/tool";
import type { CallerOf } from "../src/caller";
import {
  isCdpMethodAllowed, type BrowserApi, type Caller, type McpServerTransport, type PluginApi, type Screenshot, type TabOwner,
  type TabView, type Unsubscribe, type Viewport,
} from "../src/types";

export interface CdpCall {
  tab: string;
  method: string;
  params?: Record<string, unknown>;
  viewport?: Viewport;
}

export type PageHandler = (args: Record<string, unknown>, call: PageCall) => unknown;

/** An error the way the core's browser service throws one: a message and a string `code`. */
export function apiError(code: string, message = code): Error {
  return Object.assign(new Error(message), { code });
}

export function tabView(id: string, owner: TabOwner, extra: Partial<TabView> = {}): TabView {
  return {
    id,
    computer: "Studio",
    owner,
    partition: owner.kind === "bot" ? `persist:bot-${owner.bot}` : "persist:user",
    url: "https://example.com/",
    title: "Example Domain",
    place: "headless",
    viewport: { width: 1280, height: 800 },
    loading: false,
    heldByUser: false,
    ...extra,
  };
}

export const ALPHA: TabOwner = { kind: "bot", bot: "alpha" };
export const LUNA: TabOwner = { kind: "bot", bot: "luna" };
export const USER: TabOwner = { kind: "user" };

export const alphaCaller: Caller = { kind: "session", sessionId: "s-alpha", sessionKind: "bot", bot: "alpha" };
export const codingCaller: Caller = { kind: "session", sessionId: "s-code", sessionKind: "coding" };

export class FakeBrowser implements BrowserApi {
  tabsList: TabView[] = [];
  /** Every API call, by name, in order (`cdp` calls are in `cdpCalls` too). */
  readonly calls: { name: string; args: unknown[] }[] = [];
  readonly cdpCalls: CdpCall[] = [];
  readonly pageCalls: PageCall[] = [];
  /** DevTools methods asked for outside the allow list: always empty when the tool behaves. */
  readonly refusedMethods: string[] = [];
  /** Page ops' answers; `probe` and `active` have defaults. */
  readonly page: Partial<Record<PageOp, PageHandler>> = {};
  /** Thrown by the next call of an API method ("navigate") or a DevTools one ("cdp:Input.dispatchMouseEvent"). */
  readonly failures = new Map<string, unknown>();
  loaderId = "loader-0";
  contexts = 100;
  worldsMade = 0;
  /** The page world's ref counter, as the script reports it back. */
  nextRef = 1;
  history = { currentIndex: 1, entries: [{ id: 1, url: "https://example.com/a", title: "A" }, { id: 2, url: "https://example.com/", title: "Example Domain" }] };
  shot: Omit<Screenshot, "takenAt"> = { format: "png", data: "iVBORw0KGgo=", width: 1280, height: 800 };
  private seq = 0;

  constructor(tabs: TabView[] = []) {
    this.tabsList = tabs;
  }

  private record(name: string, args: unknown[]): void {
    this.calls.push({ name, args });
    const f = this.failures.get(name);
    if (f !== undefined) {
      this.failures.delete(name);
      throw f;
    }
  }

  private find(id: string): TabView {
    const t = this.tabsList.find((v) => v.id === id);
    if (t === undefined) throw apiError("no_tab", `there's no tab ${id} that this caller can use`);
    return t;
  }

  private notHeld(t: TabView): void {
    if (t.heldByUser) throw apiError("held", "the person is using this tab in the browser view; try again once they let go of it");
  }

  async tabs(filter: { owner?: TabOwner; computer?: string } = {}): Promise<TabView[]> {
    this.record("tabs", [filter]);
    return this.tabsList
      .filter((t) => filter.owner === undefined || JSON.stringify(t.owner) === JSON.stringify(filter.owner))
      .filter((t) => filter.computer === undefined || t.computer === filter.computer)
      .map((t) => ({ ...t }));
  }

  async open(opts: { owner: TabOwner; url?: string; show?: { view: string; viewport: Viewport }; computer?: string }): Promise<TabView> {
    this.record("open", [opts]);
    const t = tabView(`tab_${++this.seq}`, opts.owner, { url: opts.url ?? "about:blank", title: opts.url === undefined ? "" : "Opened" });
    this.tabsList.push(t);
    return { ...t };
  }

  async close(tab: string): Promise<void> {
    this.record("close", [tab]);
    this.notHeld(this.find(tab));
    this.tabsList = this.tabsList.filter((t) => t.id !== tab);
  }

  async navigate(tab: string, url: string): Promise<TabView> {
    this.record("navigate", [tab, url]);
    const t = this.find(tab);
    this.notHeld(t);
    t.url = url;
    t.title = url === "about:blank" ? "" : "Navigated";
    this.loaderId = `loader-${++this.seq}`;
    return { ...t };
  }

  async show(tab: string, view: string, viewport: Viewport): Promise<TabView> {
    this.record("show", [tab, view, viewport]);
    return { ...this.find(tab) };
  }

  async hide(tab: string): Promise<TabView> {
    this.record("hide", [tab]);
    return { ...this.find(tab) };
  }

  async screenshot(tab: string, opts?: { format?: "png" | "jpeg" | "webp"; quality?: number }): Promise<Screenshot> {
    this.record("screenshot", [tab, opts]);
    this.find(tab);
    return { ...this.shot, takenAt: 1_781_270_000_000 };
  }

  /** The tool follows no DevTools events and no tab changes; these exist to satisfy the API's shape. */
  onCdpEvent(tab: string): Unsubscribe {
    this.calls.push({ name: "onCdpEvent", args: [tab] });
    return () => undefined;
  }

  watch(): Unsubscribe {
    this.calls.push({ name: "watch", args: [] });
    return () => undefined;
  }

  async cdp<R = unknown>(tab: string, method: string, params?: Record<string, unknown>, opts?: { viewport?: Viewport }): Promise<R> {
    this.cdpCalls.push({ tab, method, ...(params === undefined ? {} : { params }), ...(opts?.viewport === undefined ? {} : { viewport: opts.viewport }) });
    this.record(`cdp:${method}`, [tab, method, params, opts]);
    if (!isCdpMethodAllowed(method)) {
      this.refusedMethods.push(method);
      throw apiError("method_refused", `${method} isn't allowed`);
    }
    const t = this.find(tab);
    this.notHeld(t);
    if (opts?.viewport !== undefined && method === "Input.dispatchMouseEvent"
      && (opts.viewport.width !== t.viewport.width || opts.viewport.height !== t.viewport.height)) {
      throw apiError("point_stale", "the point came from a picture of another size");
    }
    return (await this.answer(t, method, params ?? {})) as R;
  }

  private async answer(t: TabView, method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "Page.getFrameTree":
        return { frameTree: { frame: { id: "frame-top", loaderId: this.loaderId, url: t.url } } };
      case "Page.createIsolatedWorld":
        this.worldsMade++;
        return { executionContextId: ++this.contexts };
      case "Runtime.evaluate": {
        // `pageExpression`'s shape: ((__name) => (<script>)(<call as JSON>))((f) => f)
        const m = /\)\((\{[\s\S]*\})\)\)\(\(f\) => f\)$/.exec(String(params.expression));
        if (m === null) throw new Error("not a page call");
        const call = JSON.parse(m[1]!) as PageCall;
        this.pageCalls.push(call);
        const handler = this.page[call.op] ?? DEFAULT_PAGE[call.op];
        if (handler === undefined) return { result: { type: "object", value: { next: this.nextRef, error: `no fake for ${call.op}` } } };
        const value = handler(call.args, call);
        return { result: { type: "object", value: { next: this.nextRef, value } } };
      }
      case "Page.getNavigationHistory":
        return structuredClone(this.history);
      case "Page.navigateToHistoryEntry": {
        const i = this.history.entries.findIndex((e) => e.id === params.entryId);
        this.history.currentIndex = i;
        t.url = this.history.entries[i]!.url;
        this.loaderId = `loader-${++this.seq}`;
        return {};
      }
      case "Page.reload":
        this.loaderId = `loader-${++this.seq}`;
        return {};
      default:
        return {};
    }
  }

  /** The DevTools calls of one method, in order. */
  sent(method: string): CdpCall[] {
    return this.cdpCalls.filter((c) => c.method === method);
  }

  /** The page ops run, in order. */
  ops(): PageOp[] {
    return this.pageCalls.map((c) => c.op);
  }
}

const DEFAULT_PAGE: Partial<Record<PageOp, PageHandler>> = {
  probe: () => ({ readyState: "complete", url: "https://example.com/", title: "Example Domain" }),
  active: () => ({ kind: "none" }),
};

export class FakeTransport implements McpServerTransport {
  onmessage?: (message: Record<string, unknown>) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  readonly sent: Record<string, unknown>[] = [];
  started = false;
  closed = false;
  private waiters: { id: unknown; resolve: (m: Record<string, unknown>) => void }[] = [];
  private seq = 0;

  async start(): Promise<void> {
    this.started = true;
  }

  async send(message: Record<string, unknown>): Promise<void> {
    this.sent.push(message);
    const i = this.waiters.findIndex((w) => w.id === message.id);
    if (i >= 0) this.waiters.splice(i, 1)[0]!.resolve(message);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }

  deliver(message: unknown): void {
    this.onmessage?.(message as Record<string, unknown>);
  }

  /** Sends a request and resolves with the server's answer to it. */
  request(method: string, params?: Record<string, unknown>, id: string | number = ++this.seq): Promise<Record<string, unknown>> {
    const answer = new Promise<Record<string, unknown>>((resolve) => this.waiters.push({ id, resolve }));
    this.deliver({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    return answer;
  }
}

export interface CallResult {
  content: { type: string; text?: string; data?: string; mimeType?: string }[];
  isError?: boolean;
}

export interface Harness {
  browser: FakeBrowser;
  transport: FakeTransport;
  server: McpServerHandle;
  api: PluginApi;
  /** `tools/call` for `Browser`, with the caller as the plugin host's context for it (null: none). */
  call(args: Record<string, unknown>, caller?: Caller | null): Promise<CallResult>;
  /** Says, as the plugin host would, which caller the request with this id is for. */
  as(id: string | number, caller: Caller): void;
  /** The text of a call's result. */
  text(args: Record<string, unknown>, caller?: Caller | null): Promise<string>;
}

export async function harness(tabs: TabView[] = [], opts: BrowserToolOptions & { callerOf?: CallerOf } = {}, api?: Partial<PluginApi>): Promise<Harness> {
  const browser = new FakeBrowser(tabs);
  const transport = new FakeTransport();
  const fullApi: PluginApi = {
    plugin: { id: "clover/browser", namespace: "clover", version: "0.0.0", computer: "Studio" },
    browser,
    ...api,
  };
  // The plugin host's context for each tool call (B-M2), as a test plays it.
  const contexts = new Map<string, Caller>();
  const key = (id: string | number) => `${typeof id}:${String(id)}`;
  const as = (id: string | number, caller: Caller) => void contexts.set(key(id), caller);
  const server = await serveBrowser(transport, fullApi, { mac: false, pollMs: 1, settleMs: 50, callerOf: ({ id }) => contexts.get(key(id)), ...opts });
  let n = 0;
  const call = async (args: Record<string, unknown>, caller: Caller | null = alphaCaller): Promise<CallResult> => {
    const id = `call-${++n}`;
    if (caller !== null) as(id, caller);
    const res = await transport.request("tools/call", { name: "Browser", arguments: args }, id);
    if (res.error !== undefined) throw new Error(`JSON-RPC error: ${JSON.stringify(res.error)}`);
    return res.result as CallResult;
  };
  const text = async (args: Record<string, unknown>, caller?: Caller | null): Promise<string> => {
    const r = await call(args, caller);
    return r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  };
  return { browser, transport, server, api: fullApi, call, text, as };
}
