// Lane D's methods of the protocol's sessions area (packages/protocol/src/sessions.ts), as handlers lane C's server
// mounts (C-M1: roles, tokens, the caller check). Each handler checks its params with the method's own schema, acts
// as the caller it is given, and returns what the method's result schema describes. Owner: lane D.
//
// The server decides who may call what before a handler runs (the allow lists, the capabilities, `userOnly`); the
// handlers check the caller again where the method changes something, since a bot's or a plugin's call must never
// count as the user's (§3.1, §9.1). Not here yet: `session.answer` (the runtime's questions, A-M3), `session.setModel`
// (agents and coding sessions, K), `session.compact` (A-M3), `bots.pause` (M2), and the routines' methods (M3).
import { existsSync } from "node:fs";
import {
  CLOVER_ERR, ERR, IMAGE_REFERENCE_INVALID, SESSIONS_METHODS,
  type BotView, type Caller, type ChangeResult, type MemoryEntry, type MethodSpec, type SessionView, type UserMessageImageRef,
} from "@waifucave/clover-protocol";
import type { z } from "zod";
import { StageImageRefusal, validateImageRefs } from "../agent/stage-image";
import type { Clock } from "../contracts/clock";
import { ContractError, isContractError, RPC_ERROR_OF, type Unsubscribe } from "../contracts/common";
import type { DurableSessionHost } from "../sessions/durable-host";
import { projectRecord, projectRecords, readsSealed, transientFor, type WireEvent } from "../sessions/wire";
import { listMemory, readMemory } from "./memory";
import { botPaths } from "./paths";
import type { BotService } from "./service";

/** A JSON-RPC failure with the code a client branches on. Its message never holds a secret. */
export class MethodError extends Error {
  constructor(readonly code: number, message: string, readonly data?: Record<string, unknown>) {
    super(message);
    this.name = "MethodError";
  }
}

/** The JSON-RPC error for anything a handler throws. */
export function toMethodError(err: unknown): MethodError {
  if (err instanceof MethodError) return err;
  if (isContractError(err)) {
    const rpc = typeof err.detail?.rpc === "number" ? err.detail.rpc : undefined;
    const code = rpc ?? RPC_ERROR_OF[err.code] ?? {
      not_found: ERR.NOT_FOUND, invalid: ERR.INVALID_PARAMS, refused: ERR.INVALID_REQUEST, closed: ERR.INVALID_REQUEST,
      conflict: ERR.INVALID_REQUEST, timeout: ERR.INTERNAL, cancelled: ERR.INTERNAL,
    }[err.code as string] ?? ERR.INTERNAL;
    return new MethodError(code, err.message, { code: err.code });
  }
  return new MethodError(ERR.INTERNAL, err instanceof Error ? err.message : String(err));
}

/** Who calls, and for a connection that follows sessions live, where their events go. */
export interface MethodContext {
  caller: Caller;
  /** `session.attach`'s stream: the connection's sender, and the sessions it follows. */
  stream?: { send(event: WireEvent): void; follows: Map<string, Unsubscribe> };
}

export type MethodHandler = (params: unknown, ctx: MethodContext) => Promise<unknown>;

/** Wraps an implementation in the method's params check and the error mapping. */
export function handler<S extends MethodSpec>(spec: S, impl: (params: z.output<S["params"]>, ctx: MethodContext) => Promise<z.input<S["result"]>> | z.input<S["result"]>): MethodHandler {
  return async (raw, ctx) => {
    const parsed = spec.params.safeParse(raw);
    if (!parsed.success) throw new MethodError(ERR.INVALID_PARAMS, `${spec.name}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "params"}: ${i.message}`).join("; ")}`);
    try {
      return await impl(parsed.data as z.output<S["params"]>, ctx);
    } catch (err) {
      throw toMethodError(err);
    }
  };
}

export function requireUser(ctx: MethodContext, what: string): Extract<Caller, { kind: "user" }> {
  if (ctx.caller.kind !== "user") throw new MethodError(CLOVER_ERR.NOT_THE_USER, `only the user can ${what}`);
  return ctx.caller;
}

export interface SessionsMethodsDeps {
  home: string;
  bots: BotService;
  host: DurableSessionHost;
  clock: Clock;
  /** This device's id, for a message the user sends from this computer's app or terminal (lane H's device key). */
  localDevice: string;
}

const HISTORY_SCAN_STEP = 200;
/** How many records `session.attach` reads at a time while it replays. */
const REPLAY_PAGE = 500;

export function sessionsMethods(deps: SessionsMethodsDeps): Record<string, MethodHandler> {
  const { bots, host } = deps;
  const M = SESSIONS_METHODS;
  /** A caller other than the user's own app and devices gets cards without their sealed parts. */
  const sealed = (ctx: MethodContext) => !readsSealed(ctx.caller);
  /** A message's images (§6.6 "attachments"): only a client on this computer names a file here, and each one is held to
   *  the inherited rules (staged for this session, or the user's own image file, never inside the Clover home). */
  const checkedImages = (caller: Extract<Caller, { kind: "user" }>, id: string, text: string, images: readonly UserMessageImageRef[] | undefined): UserMessageImageRef[] | undefined => {
    if (images === undefined || images.length === 0) return undefined;
    const local = (caller.client === "app" || caller.client === "cli") && (caller.device === undefined || caller.device === deps.localDevice);
    if (!local) throw new MethodError(ERR.INVALID_PARAMS, "images can only be sent by a client on this computer", { code: IMAGE_REFERENCE_INVALID });
    try {
      return validateImageRefs(id, text, images, { cloverHome: deps.home });
    } catch (err) {
      if (err instanceof StageImageRefusal) throw new MethodError(err.internal ? ERR.INTERNAL : ERR.INVALID_PARAMS, err.message, { code: err.code, ...(err.n === undefined ? {} : { n: err.n }) });
      throw new MethodError(ERR.INTERNAL, "the message's images couldn't be checked", { code: IMAGE_REFERENCE_INVALID });
    }
  };
  const view = (id: string): SessionView => {
    const v = host.get(id);
    if (!v) throw new ContractError("not_found", `no session ${id}`);
    return v;
  };
  /** A bot's conversation is only reachable while its bot is installed. */
  const reachable = (id: string): SessionView => {
    const v = view(id);
    if (v.kind === "bot" && (v.bot === undefined || !bots.has(v.bot))) throw new ContractError("not_found", `the bot of ${id} isn't installed`);
    return v;
  };

  return {
    [M.botList.name]: handler(M.botList, async (): Promise<{ bots: BotView[] }> => ({ bots: bots.list() })),

    [M.botGet.name]: handler(M.botGet, async ({ id }) => {
      const bot = bots.get(id);
      if (!bot) throw new ContractError("not_found", `no bot ${id}`);
      return { bot };
    }),

    [M.botSetUserLayer.name]: handler(M.botSetUserLayer, async ({ id, patch }, ctx): Promise<ChangeResult> => bots.setUserLayer(id, patch, ctx.caller)),

    [M.sessionList.name]: handler(M.sessionList, async ({ kinds, bot }) => ({
      sessions: host.list(bot === undefined ? {} : { bot }).filter((s) => kinds === undefined || kinds.includes(s.kind)),
    })),

    [M.sessionGet.name]: handler(M.sessionGet, async ({ id }) => ({ session: view(id) })),

    [M.sessionHistory.name]: handler(M.sessionHistory, async ({ id, before, limit }, ctx) => {
      const v = view(id);
      const opts = { kind: v.kind, sealed: sealed(ctx) };
      const eventsIn = (start: number, end: number) => projectRecords(host.history(id, { afterSeq: start - 1, limit: end - start }), opts);
      // Back from `before` until the page holds `limit` events: records with no event (status changes) don't count.
      let end = Math.min(before ?? host.length(id), host.length(id));
      const page: WireEvent[] = [];
      let hasMore = false;
      while (end > 0) {
        const start = Math.max(0, end - HISTORY_SCAN_STEP);
        const events = eventsIn(start, end);
        const need = limit - page.length;
        if (events.length > need) {
          page.unshift(...events.slice(events.length - need));
          hasMore = true;
          break;
        }
        page.unshift(...events);
        end = start;
        if (page.length === limit) {
          for (let e = end; e > 0 && !hasMore; e = Math.max(0, e - HISTORY_SCAN_STEP)) hasMore = eventsIn(Math.max(0, e - HISTORY_SCAN_STEP), e).length > 0;
          break;
        }
      }
      return { events: page, hasMore };
    }),

    // With `since`, the events after it are replayed a page of records at a time; without it, the stream starts now and
    // the backlog is `session.history`'s, so a bot's lifelong conversation is never read whole.
    [M.sessionAttach.name]: handler(M.sessionAttach, async ({ id, since }, ctx) => {
      const v = view(id);
      const stream = ctx.stream;
      if (!stream) throw new MethodError(ERR.INVALID_REQUEST, "session.attach needs a connection that takes events");
      stream.follows.get(id)?.();
      const opts = { kind: v.kind, sealed: sealed(ctx) };
      if (since !== undefined) {
        for (let after = since; after < host.length(id) - 1; after += REPLAY_PAGE) {
          for (const event of projectRecords(host.history(id, { afterSeq: after, limit: REPLAY_PAGE }), opts)) stream.send(event);
        }
      }
      const offRecords = host.subscribe(id, (record) => {
        const event = projectRecord(record, opts);
        if (event) stream.send(event);
      });
      const offTransient = host.onTransient(id, (event) => {
        if (!transientFor(ctx.caller, event.type)) return;
        stream.send({ ...event, seq: Math.max(0, host.length(id) - 1), sessionId: id, ts: deps.clock.now() });
      });
      stream.follows.set(id, () => {
        offRecords();
        offTransient();
      });
      return { lastSeq: Math.max(0, host.length(id) - 1) };
    }),

    [M.sessionDetach.name]: handler(M.sessionDetach, async ({ id }, ctx) => {
      ctx.stream?.follows.get(id)?.();
      ctx.stream?.follows.delete(id);
      return { ok: true as const };
    }),

    [M.sessionSend.name]: handler(M.sessionSend, async ({ id, message }, ctx) => {
      const caller = requireUser(ctx, "send a message as the user");
      reachable(id);
      if (message.text.trim() === "") throw new ContractError("invalid", "a message needs text");
      const images = checkedImages(caller, id, message.text, message.images);
      const { seq } = await host.sendUser(id, {
        text: message.text,
        device: caller.device ?? deps.localDevice,
        // The client's own stamp on the shared clock orders the user's messages (§6.4); without one, when it arrived.
        sentAt: message.sentAt ?? deps.clock.now(),
        clientMessageId: message.clientMessageId,
        ...(images === undefined ? {} : { images }),
        ...(message.files === undefined ? {} : { files: message.files }),
      });
      return { seq };
    }),

    [M.sessionPost.name]: handler(M.sessionPost, async ({ id, kind, text, label }, ctx) => {
      if (ctx.caller.kind !== "plugin") throw new MethodError(ERR.INVALID_REQUEST, "session.post is a plugin's (conversation.post)");
      const pluginId = ctx.caller.pluginId;
      reachable(id);
      const { seq } = kind === "note"
        ? await host.deliver(id, { from: "note", label: (label ?? pluginId).slice(0, 120), text, by: { kind: "plugin", pluginId } })
        : await host.deliver(id, { from: "plugin", pluginId, text });
      return { seq };
    }),

    [M.sessionInterrupt.name]: handler(M.sessionInterrupt, async ({ id }, ctx) => {
      requireUser(ctx, "interrupt a session");
      view(id);
      await host.interrupt(id);
      return { ok: true as const };
    }),

    [M.sessionStop.name]: handler(M.sessionStop, async ({ id }, ctx) => {
      requireUser(ctx, "stop a session");
      if (view(id).kind === "bot") throw new ContractError("refused", "a bot's conversation never stops; interrupt it instead");
      await host.stop(id, "stopped by the user");
      return { ok: true as const };
    }),

    [M.memoryList.name]: handler(M.memoryList, async ({ bot }): Promise<{ entries: MemoryEntry[] }> => {
      const dir = botPaths(deps.home, bot).memory;
      if (!bots.has(bot) && !existsSync(dir)) throw new ContractError("not_found", `no bot ${bot}`);
      return { entries: listMemory(dir) };
    }),

    [M.memoryRead.name]: handler(M.memoryRead, async ({ bot, path }) => ({ text: readMemory(botPaths(deps.home, bot).memory, path) })),
  };
}
