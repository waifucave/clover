// Lane D's methods of the protocol's sessions area (packages/protocol/src/sessions.ts), as handlers lane C's server
// mounts (C-M1: roles, tokens, the caller check). Each handler checks its params with the method's own schema, acts
// as the caller it is given, and returns what the method's result schema describes. Owner: lane D.
//
// The server decides who may call what before a handler runs (the allow lists, the capabilities, `userOnly`); the
// handlers check the caller again where the method changes something, since a bot's or a plugin's call must never
// count as the user's (§3.1, §9.1). Not here yet: `session.answer` (the runtime's questions, A-M3) and the routines'
// methods (M3).
//
// `peerSessionMethods` is the receiving side of `peer.session.send` (devices.ts), for a computer that runs a bot the
// user messaged from another device: the sending device's signature decides whether the turn is the user's (N3).
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { z } from "zod";
import {
  BotId, CLOVER_ERR, ComputerName, DEVICES_METHODS, ERR, IMAGE_REFERENCE_INVALID, SESSIONS_METHODS, SessionId, utf16,
  type BotView, type Caller, type ChangeResult, type MemoryEntry, type MethodSpec, type SessionView, type UserMessageImageRef,
} from "@waifucave/clover-protocol";
import type { DeviceRegistry } from "../contracts/device-registry";
import { verifyUserMessage } from "../contracts/session-host";
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
  /** `session.setModel` for a background agent or a coding session (lane K's `AgentManager.setModel`); without it the
   *  new model is recorded in the session's view and its driver reads it at the next turn. */
  setAgentModel?(id: string, model: string, effort?: string): Promise<void>;
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
      const v = view(id);
      const input = {
        text: message.text,
        device: caller.device ?? deps.localDevice,
        // The client's own stamp on the shared clock orders the user's messages (§6.4); without one, when it arrived.
        sentAt: message.sentAt ?? deps.clock.now(),
        clientMessageId: message.clientMessageId,
        ...(images === undefined ? {} : { images }),
        ...(message.files === undefined ? {} : { files: message.files }),
      };
      // A bot's conversation runs on the computer running the bots, which may be another one (§6.4).
      if (v.kind === "bot" && v.bot !== undefined && bots.mainSession(v.bot) === id) {
        if (images !== undefined && !bots.botsRunHere().includes(v.bot)) {
          throw new MethodError(ERR.INVALID_PARAMS, "images reach only a bot whose conversation runs on this computer", { code: IMAGE_REFERENCE_INVALID });
        }
        const { seq } = await bots.sendUserTo(v.bot, input, message);
        return { seq };
      }
      const { seq } = await host.sendUser(id, input);
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

    [M.botsPause.name]: handler(M.botsPause, async ({ paused }, ctx) => {
      requireUser(ctx, "pause or resume the bots");
      await bots.setPaused(paused, ctx.caller);
      return { ok: true as const };
    }),

    [M.sessionSetModel.name]: handler(M.sessionSetModel, async ({ id, model, effort }, ctx) => {
      requireUser(ctx, "switch a session's model");
      const v = view(id);
      if (v.kind === "bot") throw new ContractError("refused", "a bot's model is its user layer (bot.setUserLayer), which its conversation and side threads follow");
      if (v.kind === "side-thread") throw new ContractError("refused", "a side thread runs on its bot's model");
      if (v.status === "stopped" || v.status === "failed") throw new ContractError("closed", `session ${id} has ended`);
      await deps.setAgentModel?.(id, model, effort);
      host.update(id, { model, effort: effort ?? null });
      return { ok: true as const };
    }),

    [M.sessionCompact.name]: handler(M.sessionCompact, async ({ id }, ctx) => {
      requireUser(ctx, "compact a session");
      const outcome = await host.compact(id, "user");
      if (outcome === "unsupported") throw new ContractError("refused", "this session's agent compacts its own conversation");
      if (outcome === "failed") throw new ContractError("conflict", "the compaction failed; the conversation is as it was");
      if (outcome === "skipped") throw new ContractError("refused", "the session can't compact now: the bots are paused, or another computer runs it");
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

export interface PeerSessionMethodsDeps {
  bots: Pick<BotService, "has" | "botsRunHere" | "mainSession">;
  host: Pick<DurableSessionHost, "get" | "sendUser" | "deliver">;
  clock: Pick<Clock, "now">;
  /** The paired devices (lane H): whose answer key signs a user's message. Without it, no relayed message is signed. */
  devices?: Pick<DeviceRegistry, "get" | "verifyAnswer">;
  /** A device's computer name (lane H's `DeviceRecord.computer`): `peer.session.deliver` must name the computer the
   *  link authenticated. Without it, the name is taken as given. */
  computerOf?: (device: string) => string | undefined;
}

/** `peer.session.deliver`'s params (lane D's, until lane B adds the method to the protocol's peer role): another
 *  computer's session messages a bot's main conversation that runs here, as a bot, an agent, a routine's result or an
 *  agent's task notification; never the user (review S2). */
export const PeerSessionDeliverParams = z.object({
  id: SessionId,
  /** The computer the message comes from; it must be the one the link authenticated. */
  computer: ComputerName,
  input: z.discriminatedUnion("from", [
    z.object({ from: z.literal("bot"), bot: BotId, session: SessionId, text: utf16(100_000, 1) }),
    z.object({ from: z.literal("agent"), agent: SessionId, text: utf16(100_000, 1) }),
    z.object({ from: z.literal("routine"), routine: utf16(128, 1), name: utf16(200, 1), sideThread: SessionId, text: utf16(100_000) }),
    z.object({
      from: z.literal("task-notification"), agent: SessionId, backend: utf16(128, 1),
      stopReason: z.enum(["end_turn", "refusal", "cancelled", "stopped", "stalled", "sign-in", "crashed", "error"]),
      text: utf16(1_000_000), transcript: utf16(1024, 1),
      usage: z.object({ inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative() }).optional(),
    }),
  ]),
});
export const PEER_SESSION_DELIVER = "peer.session.deliver";

/** The receiving side of `peer.session.send` (§6.4): a user's message another computer relays to a session here, a bot's
 *  conversation this computer runs. It counts as the user's turn only with the sending device's good signature (N3);
 *  otherwise it still arrives, as the user's words in a turn that isn't the user's. */
export function peerSessionMethods(deps: PeerSessionMethodsDeps): Record<string, MethodHandler> {
  const P = DEVICES_METHODS.peerSessionDeliver;
  const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
  /** A bot's main conversation this computer runs, or why not. */
  const runningBot = (id: string, method: string) => {
    const v = deps.host.get(id);
    if (!v) throw new ContractError("not_found", `no session ${id}`);
    if (v.kind !== "bot" || v.bot === undefined || !deps.bots.has(v.bot) || deps.bots.mainSession(v.bot) !== id) {
      throw new ContractError("refused", `${method} reaches only a bot's main conversation; ${id} is a ${v.kind} session`);
    }
    if (!deps.bots.botsRunHere().includes(v.bot)) throw new ContractError("not_main", `this computer doesn't run ${v.bot}'s conversation now`);
    return v;
  };
  return {
    [PEER_SESSION_DELIVER]: async (raw, ctx) => {
      if (ctx.caller.kind !== "peer") throw new MethodError(CLOVER_ERR.ROLE_REFUSED, `${PEER_SESSION_DELIVER} comes only from another computer over the link`);
      const parsed = PeerSessionDeliverParams.safeParse(raw);
      if (!parsed.success) throw new MethodError(ERR.INVALID_PARAMS, `${PEER_SESSION_DELIVER}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "params"}: ${i.message}`).join("; ")}`);
      try {
        const { id, computer, input } = parsed.data;
        const linked = deps.computerOf?.(ctx.caller.device);
        if (deps.computerOf !== undefined && linked !== computer) throw new ContractError("refused", `the message names ${computer}, but it came from ${linked ?? "a device that runs no computer"}`);
        runningBot(id, PEER_SESSION_DELIVER);
        const { seq } = await deps.host.deliver(id, input);
        return { seq };
      } catch (err) {
        throw toMethodError(err);
      }
    },
    [P.name]: handler(P, async ({ id, message, device, sentAt }, ctx) => {
      if (ctx.caller.kind !== "peer") throw new MethodError(CLOVER_ERR.ROLE_REFUSED, "peer.session.send comes only from another computer over the link");
      const relayedBy = ctx.caller.device;
      // Only a bot's main conversation this computer runs takes a relayed message: never an agent, a side thread or a
      // coding session (review B2).
      runningBot(id, P.name);
      if (message.text.trim() === "") throw new ContractError("invalid", "a message needs text");
      // Images name files on the computer they were staged on, which isn't this one.
      if (message.images !== undefined && message.images.length > 0) throw new MethodError(ERR.INVALID_PARAMS, "a relayed message can't carry images yet", { code: IMAGE_REFERENCE_INVALID });
      const signed = deps.devices === undefined ? false : await verifyUserMessage({ session: id, device, message }, { now: deps.clock.now(), sha256, devices: deps.devices });
      const { seq } = await deps.host.sendUser(id, {
        text: message.text,
        device,
        sentAt: message.sentAt ?? sentAt,
        clientMessageId: message.clientMessageId,
        ...(message.files === undefined ? {} : { files: message.files }),
        relayed: { by: relayedBy, signed },
      });
      return { seq };
    }),
  };
}
