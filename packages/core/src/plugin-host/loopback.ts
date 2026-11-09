// The plugin host with its host side in this process (`HostRuntime` over `loopbackPeers`): the real daemon side and
// the real host side, with modules a caller defines instead of a plugin's built entry. The conformance suite runs on
// it (`tests/core-host.test.ts`), with the fake's drivers (`define`, `undefine`, `crash`, `forgeApiCall`), so what the
// processes run is what the suite pins.
import type { HostProcess, PluginSource } from "@waifucave/clover-protocol";
import type { Clock } from "../contracts/clock";
import type { HostModule } from "../contracts/sdk-types";
import { CorePluginHost, type HostedRecord } from "./core-host";
import { loopbackPeers, type RpcPeer } from "./link";
import { HostRuntime } from "./runtime";

export class LoopbackPluginHost extends CorePluginHost {
  readonly #modules: Map<string, HostModule>;
  readonly #records: Map<string, HostedRecord>;
  readonly #ends = new Map<string, { core: RpcPeer; host: RpcPeer; runtime: HostRuntime }>();

  constructor(opts: { clock: Clock; computer?: string }) {
    const records = new Map<string, HostedRecord>();
    const link: { to?: (process: HostProcess, pluginId: string) => RpcPeer } = {};
    super({ clock: opts.clock, computer: opts.computer ?? "Studio", record: (id) => records.get(id), connect: (process, pluginId) => link.to!(process, pluginId) });
    this.#records = records;
    this.#modules = new Map();
    link.to = (process, pluginId) => this.#link(process, pluginId).core;
  }

  /** Installs a plugin's host module with what its install record says (default: a local plugin on Bun); a module
   *  defined while the old one runs takes over at its next start. */
  define(pluginId: string, module: HostModule, record: { source?: PluginSource; runtime?: "bun" | "node" } = {}): void {
    this.#modules.set(pluginId, module);
    this.#records.set(pluginId, {
      id: pluginId, source: record.source ?? "local", ...(record.runtime ? { runtime: record.runtime } : {}),
      folder: `/plugins/${pluginId}`, entry: "host/index.js", dataFolder: `/plugin-data/${pluginId}`,
    });
  }

  undefine(pluginId: string): void {
    this.#modules.delete(pluginId);
    this.#records.delete(pluginId);
    void this.removed(pluginId);
  }

  /** The worker died: the host side drops it, and the daemon side applies the crash rules. */
  override crash(pluginId: string, reason?: string): void {
    for (const e of this.#ends.values()) e.runtime.drop(pluginId);
    super.crash(pluginId, reason);
  }

  /** What a compromised process could send on its own link: any plugin id. */
  forgeApiCall(process: HostProcess, pluginId: string, path: string, args: unknown[]): Promise<unknown> {
    const { host } = this.#link(process, pluginId);
    return host.request("pluginHost.api", { pluginId, callId: "forged", call: path, args }).then((r) => (r as { result: unknown }).result);
  }

  #link(process: HostProcess, pluginId: string) {
    const key = process === "own" ? `own:${pluginId}` : process;
    let e = this.#ends.get(key);
    if (e === undefined || e.core.closed) {
      const [core, host] = loopbackPeers();
      const runtime = new HostRuntime({ peer: host, computer: this.computer, load: (p) => this.#modules.get(p.pluginId) ?? {} });
      e = { core, host, runtime };
      this.#ends.set(key, e);
    }
    return e;
  }
}
