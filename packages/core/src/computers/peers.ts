// The computers over the link (spec §9.1, §8.2): which ones are online, and what each says about itself. When a link
// comes up, each side sends `computer.hello`: its name, OS, display, installed agents and level, and where its part of
// the tree lives (its home folder's real path, the bots it runs). The registry and the tree take the rest from there:
// a computer whose link is down is offline, and answers "computer offline" at once (§9.1).
//
// The computers and their names come only from the device list (lane H's `DeviceRegistry`, `computer` on each record
// that runs clover-core); a hello from a device that isn't on it is ignored, and a revoked device leaves the tree at
// once. `computer.hello` is lane J's addition to the protocol (requested of lane B).
import { z } from "zod";
import { ComputerName, Level, Os, SignedCardAnswer, levelAbove, type ComputerView } from "@waifucave/clover-protocol";
import { utf16 } from "@waifucave/clover-protocol";
import { ContractError, Listeners, type Unsubscribe } from "../contracts/common";
import type { CallCardRenderer } from "../contracts/approval-broker";
import { needsAnswer, withAnswer, type AnswerAsker } from "../tree/judge";
import { offlineAs } from "../tree/remote";
import type { DeviceRecord, DeviceRegistry } from "../contracts/device-registry";
import type { LinkTransport } from "../contracts/link-transport";
import type { TreeComputer, TreeDirectory } from "../tree/tree";
import type { CoreComputerRegistry } from "./registry";

/** Where a computer's part of the tree lives. */
export const TreeRoots = z.object({
  home: utf16(4096, 1),
  botsRoot: utf16(4096, 1).optional(),
  os: Os,
  /** The bots this computer runs (`bots/<bot>/` lives here), by id. */
  bots: z.array(utf16(256, 1)).max(1024).optional(),
});
export type TreeRoots = z.infer<typeof TreeRoots>;

export const ComputerHello = z.object({
  name: ComputerName,
  os: Os,
  hasDisplay: z.boolean(),
  agents: z.array(utf16(128)).max(64),
  level: Level,
  tree: TreeRoots,
});
export type ComputerHello = z.infer<typeof ComputerHello>;

const SetLevelParams = z.object({ level: Level, answer: SignedCardAnswer.optional() });

export interface ComputerPeersOptions {
  registry: CoreComputerRegistry;
  transport: LinkTransport;
  /** This computer's part of the tree. */
  roots: () => TreeRoots;
  /** The device list: the only source of the computers in the tree and their names (review minor 1). */
  devices: DeviceRegistry;
  /** Which computer runs a bot, from lane D's registry (review S2). Left out, the hellos say, and a bot that two
   *  computers claim is refused rather than guessed. */
  placement?: (bot: string) => string | undefined;
  /** This computer's own card for a call, which a raise from another computer must answer (review N1). */
  render?: CallCardRenderer;
  /** Shows the user another computer's card for a raise, and gives back their signed answer (R1). */
  ask?: AnswerAsker;
  log?: (line: string) => void;
}

export class ComputerPeers {
  readonly #o: ComputerPeersOptions;
  readonly #roots = new Map<string, TreeRoots>();
  readonly #off: Unsubscribe[] = [];
  readonly #helloed = new Listeners<string>();
  #lastSelf = "";

  constructor(opts: ComputerPeersOptions) {
    this.#o = opts;
    const { registry, transport, devices } = opts;
    for (const d of devices.list()) this.#fromDevice(d);
    this.#off.push(devices.watch((change) => {
      if (change.type === "revoked") {
        const c = registry.byDevice(change.id);
        if (c) registry.remove(c.name);
        this.#roots.delete(change.id);
        return;
      }
      this.#fromDevice(change.device);
    }));
    this.#off.push(transport.onNotify("computer.hello", (params, from) => this.#hello(params, from)));
    // Levels per computer (J-M2): another computer asks this one to change its own level. A lowering applies; a raise
    // needs the user's answer signed for this computer's own card, which the caller is told to show.
    this.#off.push(transport.handle("computer.setLevel", async (raw, from) => {
      if (!(devices.get(from)?.runsCore && devices.get(from)?.revokedAt === undefined)) throw new ContractError("refused", "this computer isn't paired with yours");
      const p = SetLevelParams.safeParse(raw);
      if (!p.success) throw new ContractError("invalid", "computer.setLevel takes a level");
      const self = registry.self();
      if (levelAbove(p.data.level, self.level) && !p.data.answer) {
        throw needsAnswer(self.name, "computer.setLevel", { name: self.name, level: p.data.level }, opts.render, `raising ${self.name}'s level takes the user's answer`);
      }
      await registry.setLevel(self.name, p.data.level, p.data.answer ? { via: "signed", answer: p.data.answer } : undefined);
      return { applied: true };
    }));
    registry.setRemoteLevel((name, level, answer) => {
      const c = registry.get(name);
      if (!c) return Promise.reject(new ContractError("not_found", `no computer ${name}`));
      return withAnswer(answer ? undefined : opts.ask, async (a) => {
        try {
          const link = await transport.connect(c.device);
          await link.request("computer.setLevel", { level, ...((a ?? answer) ? { answer: a ?? answer } : {}) });
        } catch (e) {
          throw offlineAs(c.name, e);
        }
      });
    });
    this.#off.push(transport.watch((view) => {
      const c = registry.byDevice(view.peer);
      if (c) {
        registry.setOnline(c.name, view.up);
        if (view.path) registry.update(c.name, { link: view.path === "lan" ? "lan" : view.path === "relay" ? "relay" : "direct" });
      }
      if (view.up) this.#sendHello(view.peer);
    }));
    // A change to this computer's own entry (its level, a rename, an agent) goes to every computer online.
    this.#off.push(registry.watch((change) => {
      if (change.type !== "computer" || change.computer.name !== registry.self().name) return;
      const now = JSON.stringify(this.#hello_());
      if (now === this.#lastSelf) return;
      this.#lastSelf = now;
      for (const v of transport.links()) if (v.up) this.#sendHello(v.peer);
    }));
    for (const v of transport.links()) {
      const c = registry.byDevice(v.peer);
      if (c) registry.setOnline(c.name, v.up);
      if (v.up) this.#sendHello(v.peer);
    }
  }

  /** Where another computer's part of the tree lives, from its hello. */
  roots(device: string): TreeRoots | undefined {
    const r = this.#roots.get(device);
    return r ? structuredClone(r) : undefined;
  }

  /** Once per hello received, with the device that sent it (tests wait on it). */
  onHello(fn: (device: string) => void): Unsubscribe {
    return this.#helloed.add(fn);
  }

  /** The tree's view of the computers: the registry's entries, with each one's part of the tree. */
  directory(): TreeDirectory {
    const registry = this.#o.registry;
    const toTree = (v: ComputerView): TreeComputer => {
      const self = v.name === registry.self().name;
      const r = self ? this.#o.roots() : this.#roots.get(v.device);
      return {
        name: v.name, aliases: v.aliases, online: v.state === "online", level: v.level,
        ...(r ? { home: r.home, os: r.os, ...(r.botsRoot === undefined ? {} : { botsRoot: r.botsRoot }) } : {}),
      };
    };
    return {
      self: () => registry.self().name,
      get: (nameOrAlias) => {
        const v = registry.get(nameOrAlias);
        return v ? toTree(v) : undefined;
      },
    };
  }

  /** Which computer runs `bot`: this one if its own roots say so, else the one whose hello lists it. */
  botComputer(bot: string): string | undefined {
    const registry = this.#o.registry;
    if (this.#o.placement) return this.#o.placement(bot);
    const claims = new Set<string>();
    if (this.#o.roots().bots?.includes(bot)) claims.add(registry.self().name);
    for (const [device, r] of this.#roots) {
      const name = registry.byDevice(device)?.name;
      if (name !== undefined && r.bots?.includes(bot)) claims.add(name);
    }
    if (claims.size > 1) {
      throw new ContractError("conflict", `${[...claims].join(" and ")} each say they run ${bot}; its folder waits until only one does`, { bot, computers: [...claims] });
    }
    return claims.values().next().value;
  }


  close(): void {
    for (const off of this.#off.splice(0)) off();
  }

  #hello_(): ComputerHello {
    const self = this.#o.registry.self();
    return { name: self.name, os: self.os, hasDisplay: self.hasDisplay, agents: self.agents, level: self.level, tree: this.#o.roots() };
  }

  #sendHello(device: string): void {
    const hello = this.#hello_();
    void this.#o.transport.connect(device).then((link) => link.notify("computer.hello", hello, { priority: "control" }), () => {});
  }

  #hello(params: unknown, from: string): void {
    const parsed = ComputerHello.safeParse(params);
    if (!parsed.success) {
      this.#o.log?.(`computers: a hello from ${from} didn't parse: ${parsed.error.issues[0]?.message}`);
      return;
    }
    const h = parsed.data;
    const { registry } = this.#o;
    const c = registry.byDevice(from);
    if (!c) {
      // A device the list doesn't know as a computer never joins the tree from its own word, nor names itself.
      this.#o.log?.(`computers: a hello from ${from}, which isn't a paired computer, was ignored`);
      return;
    }
    this.#roots.set(from, h.tree);
    const up = this.#o.transport.links().find((v) => v.peer === from)?.up ?? true;
    registry.update(c.name, { os: h.os, hasDisplay: h.hasDisplay, agents: h.agents, level: h.level });
    registry.setOnline(registry.byDevice(from)!.name, up);
    this.#helloed.emit(from);
  }

  /** A device on the list that runs clover-core is a computer in the tree, offline until its link comes up. */
  #fromDevice(d: DeviceRecord): void {
    const { registry } = this.#o;
    if (!d.runsCore || d.revokedAt !== undefined || d.id === registry.self().device) return;
    const name = d.computer ?? d.name;
    const known = registry.byDevice(d.id);
    if (known) {
      if (known.name !== name) void registry.rename(known.name, name).catch((e) => this.#o.log?.(`computers: ${known.name} can't be renamed ${name}: ${(e as Error).message}`));
      return;
    }
    const up = this.#o.transport.links().find((v) => v.peer === d.id)?.up ?? false;
    try {
      registry.add({ name, device: d.id, ...(d.os ? { os: d.os } : {}), ...(d.hasDisplay === undefined ? {} : { hasDisplay: d.hasDisplay }), state: up ? "online" : "offline" });
    } catch (e) {
      this.#o.log?.(`computers: device ${d.id} can't join the tree as ${name}: ${(e as Error).message}`);
    }
  }
}
