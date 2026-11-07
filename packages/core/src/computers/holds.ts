// Holds on another computer's screen (J-M1 review minor 4): a hold lives on the computer whose screen it is, so two
// computers can never hold the same app on a third. Asking for one on another computer is `computer.takeHold` over
// the link; that computer's registry decides, with its own user-working marks, and keeps it. The asking computer keeps
// only which holds it took where, to release them (by id, or a session's at its turn end).
//
// A dropped link lets go of every hold the other computer took here: its sessions can't act here any more.
import { z } from "zod";
import { HoldTarget, SessionId, type HoldView } from "@waifucave/clover-protocol";
import { ContractError, type Unsubscribe } from "../contracts/common";
import type { HoldRequest } from "../contracts/computer-registry";
import type { LinkTransport } from "../contracts/link-transport";
import { offlineAs } from "../tree/remote";
import type { CoreComputerRegistry } from "./registry";

const TakeParams = z.object({ target: HoldTarget, pluginId: z.string().min(1).max(256), session: SessionId.optional() });
const ReleaseParams = z.object({ id: z.string().min(1).max(128) });
const SessionParams = z.object({ session: SessionId });

/** Who asks to release a hold: the plugin, and the session the router says made the call. */
export interface HoldOwner {
  pluginId: string;
  session?: string | undefined;
}

/** A session's hold is released only by that session; a hold with no session only by the plugin that took it. A
 *  plugin is installed on every computer (Mirror), so the plugin alone never speaks for a session (#177's review). */
export function mayRelease(h: { session?: string | undefined; pluginId: string }, by: HoldOwner): boolean {
  if (h.session !== undefined) return by.session === h.session && by.pluginId === h.pluginId;
  return by.pluginId === h.pluginId;
}

/** This computer's side: holds that other computers take on its screen. */
export function serveHolds(o: { transport: LinkTransport; registry: CoreComputerRegistry; mayCall: (device: string) => boolean }): Unsubscribe {
  const t = o.transport;
  /** Which device took each hold here. */
  const takenBy = new Map<string, string>();
  const offs: Unsubscribe[] = [];
  const guard = (from: string) => {
    if (!o.mayCall(from)) throw new ContractError("refused", "this computer isn't paired with yours");
  };
  offs.push(t.handle("computer.takeHold", (raw, from) => {
    guard(from);
    const p = TakeParams.safeParse(raw);
    if (!p.success) throw new ContractError("invalid", `computer.takeHold: ${p.error.issues[0]?.message ?? "bad params"}`);
    const hold = o.registry.takeHold({ computer: o.registry.self().name, target: p.data.target, pluginId: p.data.pluginId, ...(p.data.session ? { session: p.data.session } : {}) });
    takenBy.set(hold.id, from);
    return { hold };
  }));
  offs.push(t.handle("computer.releaseHold", (raw, from) => {
    guard(from);
    const p = ReleaseParams.safeParse(raw);
    if (!p.success) throw new ContractError("invalid", "computer.releaseHold takes an id");
    if (takenBy.get(p.data.id) !== from) return { ok: true };
    takenBy.delete(p.data.id);
    o.registry.releaseHold(p.data.id);
    return { ok: true };
  }));
  offs.push(t.handle("computer.releaseSession", (raw, from) => {
    guard(from);
    const p = SessionParams.safeParse(raw);
    if (!p.success) throw new ContractError("invalid", "computer.releaseSession takes a session");
    let n = 0;
    for (const h of o.registry.holds(o.registry.self().name)) {
      if (h.session !== p.data.session || takenBy.get(h.id) !== from) continue;
      takenBy.delete(h.id);
      o.registry.releaseHold(h.id);
      n++;
    }
    return { released: n };
  }));
  offs.push(t.handle("computer.holds", (_raw, from) => {
    guard(from);
    const self = o.registry.self().name;
    return { holds: o.registry.holds(self), userWorking: o.registry.userWorking(self).length > 0 };
  }));
  offs.push(t.watch((view) => {
    if (view.up) return;
    for (const [id, device] of [...takenBy]) {
      if (device !== view.peer) continue;
      takenBy.delete(id);
      o.registry.releaseHold(id);
    }
  }));
  return () => { for (const off of offs) off(); };
}

/** The asking side: takes and releases holds on whichever computer's screen they are. */
export class HoldRouter {
  readonly #registry: CoreComputerRegistry;
  readonly #transport: LinkTransport;
  /** Holds taken on other computers: id → computer, device and session. */
  readonly #remote = new Map<string, { computer: string; device: string; session?: string; pluginId: string }>();

  constructor(o: { registry: CoreComputerRegistry; transport: LinkTransport }) {
    this.#registry = o.registry;
    this.#transport = o.transport;
  }

  async takeHold(req: HoldRequest): Promise<HoldView> {
    const c = this.#registry.get(req.computer);
    if (!c) throw new ContractError("not_found", `no computer ${req.computer}`);
    if (c.name === this.#registry.self().name) return this.#registry.takeHold({ ...req, computer: c.name });
    if (c.state !== "online") throw new ContractError("computer_offline", `${c.name} is offline`, { computer: c.name });
    const r = await this.#request<{ hold: HoldView }>(c.name, c.device, "computer.takeHold", { target: req.target, pluginId: req.pluginId, ...(req.session ? { session: req.session } : {}) });
    this.#remote.set(r.hold.id, { computer: c.name, device: c.device, pluginId: req.pluginId, ...(req.session ? { session: req.session } : {}) });
    return r.hold;
  }

  /** A hold by id, here or where it was taken, by whoever owns it (`mayRelease`). */
  async releaseHold(id: string, by: HoldOwner): Promise<void> {
    const r = this.#remote.get(id);
    if (!r) {
      const h = this.#registry.holds().find((x) => x.id === id);
      if (!h) return;
      if (!mayRelease(h, by)) throw new ContractError("refused", "only the session that took a hold, or for a hold with no session the plugin that took it, releases it");
      this.#registry.releaseHold(id);
      return;
    }
    if (!mayRelease(r, by)) throw new ContractError("refused", "only the session that took a hold, or for a hold with no session the plugin that took it, releases it");
    this.#remote.delete(id);
    await this.#request(r.computer, r.device, "computer.releaseHold", { id }).catch(() => {});
  }

  /** A session's turn ended: it lets go of its holds everywhere. */
  async releaseSession(session: string): Promise<number> {
    let n = this.#registry.releaseSession(session);
    const where = new Map<string, { computer: string; device: string }>();
    for (const [id, r] of [...this.#remote]) {
      if (r.session !== session) continue;
      this.#remote.delete(id);
      where.set(r.device, r);
    }
    for (const r of where.values()) {
      const got = await this.#request<{ released: number }>(r.computer, r.device, "computer.releaseSession", { session }).catch(() => ({ released: 0 }));
      n += got.released;
    }
    return n;
  }

  /** The holds on a computer's screen, from that computer. */
  async holds(computer: string): Promise<{ holds: HoldView[]; userWorking: boolean }> {
    const c = this.#registry.get(computer);
    if (!c) throw new ContractError("not_found", `no computer ${computer}`);
    if (c.name === this.#registry.self().name) return { holds: this.#registry.holds(c.name), userWorking: this.#registry.userWorking(c.name).length > 0 };
    if (c.state !== "online") throw new ContractError("computer_offline", `${c.name} is offline`, { computer: c.name });
    return this.#request(c.name, c.device, "computer.holds", {});
  }

  async #request<R>(computer: string, device: string, method: string, params: unknown): Promise<R> {
    try {
      const link = await this.#transport.connect(device);
      return await link.request<R>(method, params);
    } catch (e) {
      throw offlineAs(computer, e);
    }
  }
}
