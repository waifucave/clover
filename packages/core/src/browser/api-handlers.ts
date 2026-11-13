// The plugin API's `browser.*` for the bundled `clover` tree's Browser tool (spec §12.1, ruling R7): the session whose
// tool call the tool is serving drives the Clover Browser, under the browser's own rules. The router has already checked
// that the call came from the `clover` host process and that the plugin holds `browser` (API_CALLS); this door adds:
//
// * a caller. Only the session the core bound to the tool call (`caller.kind === "session"`) gets anything: a plugin
//   acting as itself, the core, a peer or the user get a refusal here, never a guess.
// * that caller's own tabs. A bot's session drives its bot's tab, a session with no bot its own; the owner is the
//   caller's, never a parameter's. The person's own browser is never reached from here, at any level, and no card is
//   raised for it.
// * one tab per bot: `open` with a tab already open is refused with the tab's id, so the tool navigates it.
// * DevTools only through the tool's own short list (`TOOL_CDP_METHODS`): the nine methods the tool calls, nothing
//   wider, whatever the core's wider allow list passes for the browser view.
// * nothing of a network filter's is loosened: a bot's tab still reaches no loopback or private address (network.ts).
import type { Caller } from "@waifucave/clover-protocol";
import type { ApiCallContext, ApiHandlers } from "../plugin-host/api/router";
import { ContractError } from "../contracts/common";
import type { TabOwner, TabView, Screenshot } from "./contract";
import { BrowserError } from "./policy";
import { browserCallerOf, type BrowserService, type ProtocolCaller } from "./service";

/** The DevTools methods the Browser tool calls, and so the only ones a session's call may pass. */
export const TOOL_CDP_METHODS: readonly string[] = [
  "Input.dispatchKeyEvent",
  "Input.dispatchMouseEvent",
  "Input.insertText",
  "Page.createIsolatedWorld",
  "Page.getFrameTree",
  "Page.getNavigationHistory",
  "Page.navigateToHistoryEntry",
  "Page.reload",
  "Runtime.evaluate",
];

/** What the tool is told of its caller: the session, its kind and its bot, nothing the core keeps to itself. */
export interface ToolCaller {
  kind: "session";
  sessionId: string;
  sessionKind: string;
  bot?: string;
}

type SessionCaller = Extract<Caller, { kind: "session" }>;

/** The session a call acts for, or the refusal the tool reads: no call without one. */
function sessionOf(ctx: ApiCallContext): SessionCaller {
  const c = ctx.caller;
  if (c.kind !== "session") {
    throw new ContractError("refused", `${ctx.path} works for the session whose tool call the plugin is serving; a call made as ${c.kind === "plugin" ? "the plugin itself" : c.kind === "core" ? "the core" : `a ${c.kind}`} has no tabs here`);
  }
  return c;
}

/** The tab owner a session's own tabs are kept under: its bot's, or its own for a session with no bot. */
export function ownerOfSession(c: SessionCaller): TabOwner {
  return c.bot !== undefined ? { kind: "bot", bot: c.bot } : { kind: "session", session: c.sessionId };
}

function failNotRunning(): never {
  throw new ContractError("refused", "the Clover Browser isn't running on this computer");
}

function failure(e: unknown): never {
  if (e instanceof BrowserError) throw new ContractError("refused", e.message, { code: e.code });
  throw e;
}

async function run<T>(work: () => Promise<T> | T): Promise<T> {
  try {
    return await work();
  } catch (e) {
    return failure(e);
  }
}

const str = (v: unknown, what: string, max = 8192): string => {
  if (typeof v !== "string" || v.length === 0 || v.length > max) throw new ContractError("invalid", `${what} is a string of 1 to ${max} characters`);
  return v;
};

const obj = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** The handlers for the six calls the Browser tool uses, and `browser.toolCaller`, the one that tells the tool whose tool
 *  call it is serving (the tool refuses every call it can't tell). */
export function browserApiHandlers(getService: () => BrowserService | undefined): ApiHandlers {
  const caller = (ctx: ApiCallContext) => browserCallerOf(sessionOf(ctx) as ProtocolCaller);
  // Read at each call: the browser comes up with the daemon's parts, after the plugin host.
  const svc = (): BrowserService => getService() ?? failNotRunning();
  return {
    "browser.toolCaller": (ctx) => {
      const c = sessionOf(ctx);
      const out: ToolCaller = { kind: "session", sessionId: c.sessionId, sessionKind: c.sessionKind, ...(c.bot !== undefined ? { bot: c.bot } : {}) };
      return out;
    },
    "browser.tabs": async (ctx, args) => {
      const c = sessionOf(ctx);
      const filter = obj(args[0]);
      if (filter.owner !== undefined) assertOwn(c, filter.owner);
      if (typeof filter.computer === "string" && filter.computer !== svc().computerName) throw new ContractError("refused", "the Browser tool works on this computer's tabs only", { code: "not_yours" });
      return run(() => svc().list(caller(ctx), { owner: ownerOfSession(c) }));
    },
    "browser.open": async (ctx, args) => {
      const c = sessionOf(ctx);
      const o = obj(args[0]);
      if (o.owner !== undefined) assertOwn(c, o.owner);
      // A tab on another computer (no peers are served), or shown at once in a view, is not the tool's to ask for; this
      // computer, named as the tool names it, is the one place it opens.
      if ((o.computer !== undefined && o.computer !== svc().computerName) || o.show !== undefined) throw new ContractError("refused", "the Browser tool opens a tab on this computer, drawn out of sight");
      const url = o.url === undefined ? undefined : str(o.url, "url");
      const mine = await run(() => svc().list(caller(ctx), { owner: ownerOfSession(c) }));
      if (mine.length > 0) throw new ContractError("refused", `${c.bot !== undefined ? `${c.bot} has` : "this session has"} a tab open already (${mine[0]!.id}): navigate it instead of opening another`, { code: "one_tab" });
      const tab: TabView = await run(() => svc().open(caller(ctx), { owner: ownerOfSession(c), ...(url !== undefined ? { url } : {}) }));
      return tab;
    },
    "browser.close": async (ctx, args) => {
      sessionOf(ctx);
      await run(() => svc().close(caller(ctx), str(args[0], "the tab id", 128)));
    },
    "browser.navigate": async (ctx, args) => {
      sessionOf(ctx);
      return run(() => svc().navigate(caller(ctx), str(args[0], "the tab id", 128), str(args[1], "url")));
    },
    "browser.screenshot": async (ctx, args) => {
      sessionOf(ctx);
      const o = obj(args[1]);
      const format = o.format === "png" || o.format === "jpeg" || o.format === "webp" ? o.format : undefined;
      const quality = typeof o.quality === "number" ? o.quality : undefined;
      const shot: Screenshot = await run(() => svc().screenshot(caller(ctx), str(args[0], "the tab id", 128), { ...(format !== undefined ? { format } : {}), ...(quality !== undefined ? { quality } : {}) }));
      return shot;
    },
    "browser.cdp": async (ctx, args) => {
      sessionOf(ctx);
      const method = str(args[1], "the DevTools method", 128);
      if (!TOOL_CDP_METHODS.includes(method)) throw new ContractError("refused", `${method} isn't one the Browser tool uses; the tool passes only: ${TOOL_CDP_METHODS.join(", ")}`, { code: "method_refused" });
      const params = args[2] === undefined ? undefined : obj(args[2]);
      const opts = obj(args[3]);
      const viewport = opts.viewport as { width: number; height: number } | undefined;
      return run(() => svc().cdp(caller(ctx), str(args[0], "the tab id", 128), method, params, viewport !== undefined ? { viewport } : {}));
    },
  };
}

/** A tab owner a call names must be the caller's own (the tool says it; the core doesn't take its word for another). */
function assertOwn(c: SessionCaller, named: unknown): void {
  const own = ownerOfSession(c);
  const n = obj(named);
  const same = n.kind === own.kind && (own.kind === "bot" ? n.bot === own.bot : own.kind === "session" ? n.session === own.session : false);
  if (!same) throw new ContractError("refused", "the Browser tool drives the calling session's own tabs only; the person's own browser and anyone else's are not reachable from it", { code: "not_yours" });
}
