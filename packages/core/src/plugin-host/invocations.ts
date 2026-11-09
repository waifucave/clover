// Who a plugin's API call acts for (ruling R7; the PluginHost contract): the core keeps its own record of every call it
// makes into a plugin (a handler's `pluginHost.invoke`, an MCP request with `_meta["clover/invocation"]`), and binds
// each API call made inside one to that call's caller, looked up by the call's id. A call made outside any acts as the
// plugin. An id that isn't an open call to that plugin is refused: it was never one, it belongs to another plugin, or
// its call has ended (a `ctx.api` kept past its call, #179's review S1). The plugin never names its caller.
import type { Caller } from "@waifucave/clover-protocol";
import { ContractError } from "../contracts/common";

export interface OpenInvocation {
  pluginId: string;
  caller: Caller;
  session?: string;
}

export class InvocationTable {
  readonly #open = new Map<string, OpenInvocation>();

  /** The core is making call `id` into `pluginId` for `caller`; the returned function ends it. */
  open(id: string, invocation: OpenInvocation): () => void {
    if (this.#open.has(id)) throw new ContractError("conflict", `call ${id} is already open`);
    this.#open.set(id, { ...invocation, caller: structuredClone(invocation.caller) });
    return () => {
      this.#open.delete(id);
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

  /** The open call's session, if it has one. */
  sessionOf(invocation: string): string | undefined {
    return this.#open.get(invocation)?.session;
  }

  get size(): number {
    return this.#open.size;
  }
}
