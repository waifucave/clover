// The daemon's end of `pluginHost.api` and `pluginHost.unwatch` (spec §5.2, §5.4; the protocol's plugin-host channel):
// one connection per plugin-host process, bound by its token to that process (`HostProcess`), never to anything the
// process says.
//
// * The call's `pluginId` is the one the host stamped from its own worker table (review S3); `guardApiRouter` (in front
//   of the router this takes) refuses one that doesn't run in this connection's process.
// * The caller is bound here from the core's own record (`InvocationTable`, R7): `invocation` names the open call it
//   was made inside, or nothing, and the call then acts as the plugin.
// * A listener can't cross the pipe: the host sends `{ "$listener": true }` in its place, the daemon puts a function
//   there that sends each value back as `pluginHost.deliver` on a new subscription, and the call's result is
//   `{ subscription }`. `pluginHost.unwatch` ends it, and so does the connection's close (`closeAll`).
import { PLUGINS_METHODS, type HostProcess } from "@waifucave/clover-protocol";
import { randomUUID } from "node:crypto";
import { ContractError } from "../contracts/common";
import type { ApiRouter } from "../contracts/plugin-host";
import { handler, type MethodHandler } from "../rpc/handler";
import type { InvocationTable } from "./invocations";

/** The placeholder a host sends where a listener goes. */
export const LISTENER_ARG = "$listener";

const isListenerArg = (v: unknown) => typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length === 1 && (v as Record<string, unknown>)[LISTENER_ARG] === true;

export interface ApiChannelOptions {
  /** The process this connection belongs to, from the token it connected with. */
  process: HostProcess;
  router: ApiRouter;
  invocations: InvocationTable;
  /** Sends `pluginHost.deliver` on this connection. */
  deliver(pluginId: string, subscription: string, value: unknown): void;
}

export interface ApiChannel {
  methods: Record<string, MethodHandler>;
  /** The connection closed: every watch it opened ends. */
  closeAll(): void;
  /** Open watches, for tests and status. */
  readonly watches: number;
}

export function apiChannel(o: ApiChannelOptions): ApiChannel {
  const M = PLUGINS_METHODS;
  const subs = new Map<string, { pluginId: string; stop: () => void }>();
  const methods: Record<string, MethodHandler> = {
    [M.pluginHostApi.name]: handler(M.pluginHostApi, async (p) => {
      const caller = o.invocations.callerFor(p.pluginId, p.invocation);
      const raw = Array.isArray(p.args) ? p.args : p.args === undefined ? [] : [p.args];
      let subscription: string | undefined;
      const args = raw.map((a) => {
        if (!isListenerArg(a)) return a;
        if (subscription !== undefined) throw new ContractError("invalid", "a call takes one listener");
        const id = (subscription = `sub_${randomUUID()}`);
        return (value: unknown) => {
          if (subs.has(id)) o.deliver(p.pluginId, id, value);
        };
      });
      const result = await o.router({ pluginId: p.pluginId, process: o.process, path: p.call, args, caller });
      if (subscription === undefined) return { result };
      if (typeof result !== "function") throw new ContractError("failed", `${p.call} took a listener but opened no watch`);
      subs.set(subscription, { pluginId: p.pluginId, stop: result as () => void });
      return { result: { subscription } };
    }),
    [M.pluginHostUnwatch.name]: handler(M.pluginHostUnwatch, (p) => {
      const sub = subs.get(p.subscription);
      if (sub !== undefined && sub.pluginId === p.pluginId) {
        subs.delete(p.subscription);
        sub.stop();
      }
      return { ok: true as const };
    }),
  };
  return {
    methods,
    closeAll() {
      for (const [id, sub] of subs) {
        subs.delete(id);
        sub.stop();
      }
    },
    get watches() {
      return subs.size;
    },
  };
}
