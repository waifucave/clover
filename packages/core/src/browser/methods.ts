// The browser's protocol methods as the daemon's server serves them (plan §4 L; lane B's `handler`, lane C's endpoint):
// `browser.tabs`, `open`, `close`, `navigate`, `show`, `hide`, `hold`, `screenshot`, `cdp`, `stream` and the app's
// `browser.report`. Each handler acts as the caller the server gives it (`browserCallerOf`) and fails with the JSON-RPC
// code a client branches on (a refusal carries the browser's own code in `data.code`). The server applies the role and
// capability lists and `userOnly` before a handler runs (`BROWSER_METHODS`); `hold` (the person) and `report` (the app's own connection) check the caller again.
//
//   const handlers = browserMethodHandlers({ service: browser.service });
//   for (const [name, fn] of Object.entries(handlers)) server.serve(name, fn);   // lane INT
import { BROWSER_METHODS, CLOVER_ERR, ERR, STREAM_FRAME_B64_MAX_LENGTH, isStrictBase64, type Caller } from "@waifucave/clover-protocol";
import { handler, MethodError, type MethodContext, type MethodHandler } from "../rpc/handler";
import type { AppTabEvent } from "./contract";
import { BrowserError, type BrowserErrorCode } from "./policy";
import { browserCallerOf, type BrowserCaller, type BrowserService, type ProtocolCaller } from "./service";

export interface BrowserMethodOptions {
  service: BrowserService;
  /** The session a plugin is serving a tool call for, when the call is one (R7): the core binds it from the tool
   *  call's own context, never from anything the plugin says. */
  servingToolCall?: (ctx: MethodContext) => Extract<ProtocolCaller, { kind: "session" | "peer" }> | undefined;
  /** The device a `browser.stream` call came on, from the authenticated link (never from the params). A peer's, or a user
   *  client's (a phone's, a web page's), own device by default. */
  deviceOf?: (ctx: MethodContext) => string | undefined;
  /** The app connection's id, held by the server wiring (lane INT passes the Clover `conn.connId` through
   *  `MethodContext.connId`): `report` and `streamData` from any other app connection — replaced by a
   *  reconnect, or hung past its heartbeat — are ignored, never adopted. Absent until the wiring lands. */
  appConnId?: () => number | undefined;
}

const NOT_FOUND: ReadonlySet<BrowserErrorCode> = new Set(["no_tab", "tab_closed"]);

/** A browser refusal as the JSON-RPC error a client branches on, its own code kept in `data.code`. */
function failure(e: unknown): never {
  if (e instanceof BrowserError) {
    throw new MethodError(NOT_FOUND.has(e.code) ? ERR.NOT_FOUND : e.code === "needs_ok" ? CLOVER_ERR.CAPABILITY_REFUSED : ERR.INVALID_REQUEST, e.message, { code: e.code });
  }
  throw e;
}

async function run<T>(work: () => Promise<T> | T): Promise<T> {
  try {
    return await work();
  } catch (e) {
    return failure(e);
  }
}

export function browserMethodHandlers(o: BrowserMethodOptions): Record<string, MethodHandler> {
  const { service } = o;
  const caller = (ctx: MethodContext): BrowserCaller => browserCallerOf(ctx.caller as ProtocolCaller, o.servingToolCall?.(ctx));
  /** True when the call comes over an app connection the server has replaced: the app reconnected
   *  (or hung past its heartbeat) on another connection, so this one's `report`/`streamData` are late
   *  and must change nothing. Only a positive mismatch ignores: without a wired id, calls act as before. */
  const staleApp = (ctx: MethodContext): boolean =>
    (ctx.caller as Caller).kind === "user" && o.appConnId !== undefined
    && ctx.connId !== undefined && ctx.connId !== o.appConnId();
  const M = BROWSER_METHODS;
  const handlers: Record<string, MethodHandler> = {};
  const add = (name: string, fn: MethodHandler): void => {
    handlers[name] = fn;
  };
  add(M.browserTabs.name, handler(M.browserTabs, async (p, ctx) => ({ tabs: await run(() => service.list(caller(ctx), { ...(p.owner !== undefined ? { owner: p.owner } : {}), ...(p.computer !== undefined ? { computer: p.computer } : {}) })) })));
  add(M.browserOpen.name, handler(M.browserOpen, async (p, ctx) => ({
    tab: await run(() => service.open(caller(ctx), { owner: p.owner, ...(p.url !== undefined ? { url: p.url } : {}), ...(p.computer !== undefined ? { computer: p.computer } : {}), ...(p.show !== undefined ? { show: p.show } : {}) })),
  })));
  add(M.browserClose.name, handler(M.browserClose, async (p, ctx) => {
    await run(() => service.close(caller(ctx), p.id));
    return { ok: true as const };
  }));
  add(M.browserNavigate.name, handler(M.browserNavigate, async (p, ctx) => ({ tab: await run(() => service.navigate(caller(ctx), p.id, p.url)) })));
  add(M.browserShow.name, handler(M.browserShow, async (p, ctx) => ({ tab: await run(() => service.show(caller(ctx), p.id, p.view, p.viewport)) })));
  add(M.browserHide.name, handler(M.browserHide, async (p, ctx) => ({ tab: await run(() => service.hide(caller(ctx), p.id)) })));
  add(M.browserHold.name, handler(M.browserHold, async (p, ctx) => {
    // The person's gesture in the view, seen by the app's own connection (§5.5's rule for sends).
    if ((ctx.caller as Caller).kind !== "user") throw new MethodError(CLOVER_ERR.NOT_THE_USER, "only the user can take or give back a tab");
    await run(() => service.hold(p.id, p.held));
    return { ok: true as const };
  }));
  add(M.browserScreenshot.name, handler(M.browserScreenshot, async (p, ctx) => run(() => service.screenshot(caller(ctx), p.id, { ...(p.format !== undefined ? { format: p.format } : {}), ...(p.quality !== undefined ? { quality: p.quality } : {}) }))));
  add(M.browserCdp.name, handler(M.browserCdp, async (p, ctx) => ({ result: await run(() => service.cdp(caller(ctx), p.id, p.method, p.params, p.viewport !== undefined ? { viewport: p.viewport } : {})) })));
  add(M.browserStream.name, handler(M.browserStream, async (p, ctx) => {
    const c = ctx.caller as Caller;
    const device = o.deviceOf?.(ctx) ?? (c.kind === "peer" ? c.device : c.kind === "user" ? c.device : undefined);
    if (device === undefined) throw new MethodError(CLOVER_ERR.ROLE_REFUSED, "a stream goes to a device: this call didn't come on a device's link");
    return run(() => service.stream(caller(ctx), p.id, { on: p.on, ...(p.maxKbps !== undefined ? { maxKbps: p.maxKbps } : {}), ...(p.codecs !== undefined ? { codecs: p.codecs } : {}) }, device));
  }));
  add(M.browserReport.name, handler(M.browserReport, async (p, ctx) => {
    // Only the app's own connection tells the core what happened to its tabs.
    const c = ctx.caller as Caller;
    if (c.kind !== "user" || c.client !== "app") throw new MethodError(CLOVER_ERR.ROLE_REFUSED, "only the app reports on its tabs");
    // A late report from a replaced or hung app connection must not close or adopt tabs.
    if (staleApp(ctx)) return { ok: true as const };
    service.report(p.events as AppTabEvent[]);
    return { ok: true as const };
  }));
  add(M.browserStreamData.name, handler(M.browserStreamData, async (p, ctx) => {
    // App-role only, like `browser.hold`'s user check: no layer or peer streams a tab's chunks.
    if ((ctx.caller as Caller).kind !== "user") throw new MethodError(CLOVER_ERR.NOT_THE_USER, "the app alone streams its tabs' chunks");
    // A late chunk from a replaced or hung app connection lands in no stream.
    if (staleApp(ctx)) return { ok: true as const };
    const chunk = p.chunk;
    if (chunk.kind === "frame") {
      // The schema already caps and base64-checks; the decode here is the second gate (B2), so a
      // chunk that reached the service is always bytes the wire could carry.
      if (chunk.data.length > STREAM_FRAME_B64_MAX_LENGTH || !isStrictBase64(chunk.data)) {
        throw new MethodError(ERR.INVALID_PARAMS, "browser.streamData: the frame is over the wire cap or not valid base64");
      }
      const data = new Uint8Array(Buffer.from(chunk.data, "base64"));
      await run(() => service.streamData(p.stream, { kind: "frame", key: chunk.key, timestamp: chunk.timestamp, data }));
    } else {
      await run(() => service.streamData(p.stream, chunk));
    }
    return { ok: true as const };
  }));
  return handlers;
}
