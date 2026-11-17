// Who a plugin's API call acts for (ruling R7; the PluginHost contract): the core keeps its own record of every call it
// makes into a plugin (a handler's `pluginHost.invoke`, an MCP request with `_meta["moss/invocation"]`), and binds
// each API call made inside one to that call's caller, looked up by the call's id. A call made outside any acts as the
// plugin. An id that isn't an open call to that plugin is refused: it was never one, it belongs to another plugin, or
// its call has ended (a `ctx.api` kept past its call, #179's review S1). The plugin never names its caller.
import type { Caller } from "@waifucave/moss-protocol";
import { ContractError } from "../contracts/common";

export interface OpenInvocation {
  pluginId: string;
  caller: Caller;
  session?: string;
  /** A tool call into a `host` MCP server: that server and the tool's name (the request's own `tools/call`). */
  server?: string;
  tool?: string;
}

export class InvocationTable {
  readonly #open = new Map<string, OpenInvocation>();
  readonly #ended = new Set<(id: string, invocation: OpenInvocation) => void>();

  /** `fn` hears each call that ends (a live picture tied to its call ends with it). */
  onEnded(fn: (id: string, invocation: OpenInvocation) => void): () => void {
    this.#ended.add(fn);
    return () => void this.#ended.delete(fn);
  }

  /** The core is making call `id` into `pluginId` for `caller`; the returned function ends it. */
  open(id: string, invocation: OpenInvocation): () => void {
    if (this.#open.has(id)) throw new ContractError("conflict", `call ${id} is already open`);
    this.#open.set(id, { ...invocation, caller: structuredClone(invocation.caller) });
    return () => {
      const was = this.#open.get(id);
      if (!this.#open.delete(id) || was === undefined) return;
      for (const fn of [...this.#ended]) {
        try {
          fn(id, was);
        } catch {
          // a listener's own failure
        }
      }
    };
  }

  /** Whom an API call from `pluginId` acts for, made inside `invocation` (or outside any). */
  callerFor(pluginId: string, invocation?: string): Caller {
    if (invocation === undefined) return { kind: "plugin", pluginId };
    const open = this.#open.get(invocation);
    if (open === undefined || open.pluginId !== pluginId) {
      throw new ContractError("closed", `the call this was made in has ended, or isn't one of ${pluginId}'s; a plugin acting later acts as itself`);
    }
    return structuredClone(open.caller);
  }

  /** What the core knows of the open tool call `invocation` of `pluginId`'s (its id, the `host` server and the tool); undefined
   *  for no call, a call that isn't a tool call (a handler's), or one that isn't open or isn't that plugin's. */
  infoFor(pluginId: string, invocation: string | undefined): { id: string; server?: string; tool?: string } | undefined {
    if (invocation === undefined) return undefined;
    const open = this.#open.get(invocation);
    if (open === undefined || open.pluginId !== pluginId || open.server === undefined) return undefined;
    return { id: invocation, ...(open.server !== undefined ? { server: open.server } : {}), ...(open.tool !== undefined ? { tool: open.tool } : {}) };
  }

  /** The open call's session, if it has one. */
  sessionOf(invocation: string): string | undefined {
    return this.#open.get(invocation)?.session;
  }

  get size(): number {
    return this.#open.size;
  }
}
