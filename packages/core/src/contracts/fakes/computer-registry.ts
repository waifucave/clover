// FakeComputerRegistry: computers in memory, with the hold, mark and window rules. `setOnline` stands for a computer
// sleeping or coming back.
import {
  COMPUTER_NAME_RE, DEFAULT_LEVEL, levelAbove,
  type CloverWindow, type ComputerView, type HoldView, type Level,
} from "@waifucave/clover-protocol";
import type { Clock } from "../clock";
import { ContractError, Listeners, type Unsubscribe } from "../common";
import { holdsOverlap, type ComputerChange, type ComputerRegistry, type HoldRequest } from "../computer-registry";

export type FakeComputerInput = Partial<ComputerView> & Pick<ComputerView, "name" | "device">;

export class FakeComputerRegistry implements ComputerRegistry {
  readonly #clock: Pick<Clock, "now">;
  readonly #self: string;
  readonly #computers = new Map<string, ComputerView>();
  readonly #holds = new Map<string, HoldView>();
  readonly #working = new Map<string, Set<string>>();
  readonly #running = new Set<string>();
  readonly #windows = new Map<string, CloverWindow[]>();
  readonly #listeners = new Listeners<ComputerChange>();
  #holdSeq = 0;

  constructor(opts: { clock: Pick<Clock, "now">; self: FakeComputerInput; others?: FakeComputerInput[] }) {
    this.#clock = opts.clock;
    this.#self = opts.self.name;
    for (const c of [opts.self, ...(opts.others ?? [])]) this.add(c, c === opts.self);
  }

  /** A computer was connected (paired, or created as a cloud computer). */
  add(input: FakeComputerInput, isSelf = false): ComputerView {
    if (!COMPUTER_NAME_RE.test(input.name)) throw new ContractError("invalid", "a computer's name is letters, digits and hyphens");
    if (this.#find(input.name)) throw new ContractError("conflict", `${input.name} is taken`);
    const view: ComputerView = {
      aliases: [], os: "macos", hasDisplay: true, agents: [], level: DEFAULT_LEVEL, state: "online", isMain: false,
      ...(isSelf ? { link: "self" as const } : { link: "lan" as const }),
      ...structuredClone(input),
    };
    this.#computers.set(view.name, view);
    this.#listeners.emit({ type: "computer", computer: structuredClone(view) });
    return structuredClone(view);
  }

  remove(name: string): void {
    const c = this.#find(name);
    if (!c) return;
    this.#computers.delete(c.name);
    for (const [id, h] of this.#holds) if (h.computer === c.name) this.#holds.delete(id);
    this.#listeners.emit({ type: "removed", name: c.name });
  }

  setOnline(name: string, online: boolean): void {
    const c = this.#must(name);
    c.state = online ? "online" : "offline";
    this.#listeners.emit({ type: "computer", computer: structuredClone(c) });
  }

  self(): ComputerView {
    return structuredClone(this.#computers.get(this.#self)!);
  }

  list(): ComputerView[] {
    return [...this.#computers.values()].map((c) => structuredClone(c));
  }

  get(nameOrAlias: string): ComputerView | undefined {
    const c = this.#find(nameOrAlias);
    return c ? structuredClone(c) : undefined;
  }

  async setLevel(name: string, level: Level, card?: string): Promise<void> {
    const c = this.#must(name);
    if (levelAbove(level, c.level) && card === undefined) throw new ContractError("refused", "raising a computer's level takes the user's sealed card");
    c.level = level;
    this.#listeners.emit({ type: "computer", computer: structuredClone(c) });
  }

  async rename(name: string, newName: string): Promise<void> {
    const c = this.#must(name);
    if (!COMPUTER_NAME_RE.test(newName)) throw new ContractError("invalid", "a computer's name is letters, digits and hyphens");
    const other = this.#find(newName);
    if (other && other !== c) throw new ContractError("conflict", `${newName} is taken`);
    if (newName === c.name) return;
    this.#computers.delete(c.name);
    c.aliases = [...c.aliases.filter((a) => a !== newName), c.name];
    const old = c.name;
    c.name = newName;
    this.#computers.set(newName, c);
    for (const h of this.#holds.values()) if (h.computer === old) h.computer = newName;
    for (const map of [this.#working, this.#windows] as Map<string, unknown>[]) {
      if (map.has(old)) {
        map.set(newName, map.get(old));
        map.delete(old);
      }
    }
    if (this.#running.delete(old)) this.#running.add(newName);
    this.#listeners.emit({ type: "computer", computer: structuredClone(c) });
  }

  holds(computer?: string): HoldView[] {
    const name = computer === undefined ? undefined : this.#find(computer)?.name;
    return [...this.#holds.values()].filter((h) => name === undefined || h.computer === name).map((h) => structuredClone(h));
  }

  takeHold(req: HoldRequest): HoldView {
    const c = this.#must(req.computer);
    if (c.state !== "online") throw new ContractError("computer_offline", `${c.name} is offline`);
    if (this.#working.get(c.name)?.has(req.target.app)) {
      throw new ContractError("user_working", `you're working in ${req.target.app}; your message or an answer to a question lets the agent act`, { app: req.target.app });
    }
    for (const h of this.#holds.values()) {
      if (h.computer !== c.name || !holdsOverlap(h.target, req.target)) continue;
      if (h.session === req.session && h.session !== undefined) {
        if (h.target.kind === req.target.kind && JSON.stringify(h.target) === JSON.stringify(req.target)) return structuredClone(h);
        continue;
      }
      throw new ContractError("held", `${h.session ?? h.pluginId} holds ${req.target.app}`, { holder: h.session ?? h.pluginId, hold: h.id });
    }
    const hold: HoldView = {
      id: `hold_${++this.#holdSeq}`, computer: c.name, target: structuredClone(req.target), pluginId: req.pluginId, since: this.#clock.now(),
      ...(req.session === undefined ? {} : { session: req.session }),
    };
    this.#holds.set(hold.id, hold);
    this.#emitHolds(c.name);
    return structuredClone(hold);
  }

  releaseHold(id: string): void {
    const h = this.#holds.get(id);
    if (!h) return;
    this.#holds.delete(id);
    this.#emitHolds(h.computer);
  }

  releaseSession(session: string): number {
    const touched = new Set<string>();
    let n = 0;
    for (const [id, h] of [...this.#holds]) {
      if (h.session !== session) continue;
      this.#holds.delete(id);
      touched.add(h.computer);
      n++;
    }
    for (const c of touched) this.#emitHolds(c);
    return n;
  }

  markUserWorking(computer: string, app: string): void {
    const c = this.#must(computer);
    const set = this.#working.get(c.name) ?? new Set<string>();
    set.add(app);
    this.#working.set(c.name, set);
    this.#listeners.emit({ type: "user-working", computer: c.name, apps: [...set] });
  }

  liftUserWorking(computer: string): void {
    const c = this.#must(computer);
    if (!this.#working.get(c.name)?.size) return;
    this.#working.delete(c.name);
    this.#listeners.emit({ type: "user-working", computer: c.name, apps: [] });
  }

  userWorking(computer: string): string[] {
    const c = this.#find(computer);
    return c ? [...(this.#working.get(c.name) ?? [])] : [];
  }

  setActionRunning(computer: string, running: boolean): void {
    const c = this.#must(computer);
    if (running === this.#running.has(c.name)) return;
    if (running) this.#running.add(c.name);
    else this.#running.delete(c.name);
    this.#listeners.emit({ type: "action-running", computer: c.name, running });
  }

  isActionRunning(computer: string): boolean {
    const c = this.#find(computer);
    return c ? this.#running.has(c.name) : false;
  }

  setCloverWindows(computer: string, windows: CloverWindow[]): void {
    this.#windows.set(this.#must(computer).name, structuredClone(windows));
  }

  cloverWindows(computer: string): CloverWindow[] {
    const c = this.#find(computer);
    return c ? structuredClone(this.#windows.get(c.name) ?? []) : [];
  }

  watch(fn: (change: ComputerChange) => void): Unsubscribe {
    return this.#listeners.add(fn);
  }

  #find(nameOrAlias: string): ComputerView | undefined {
    const direct = this.#computers.get(nameOrAlias);
    if (direct) return direct;
    for (const c of this.#computers.values()) if (c.aliases.includes(nameOrAlias)) return c;
    return undefined;
  }

  #must(nameOrAlias: string): ComputerView {
    const c = this.#find(nameOrAlias);
    if (!c) throw new ContractError("not_found", `no computer ${nameOrAlias}`);
    return c;
  }

  #emitHolds(computer: string): void {
    this.#listeners.emit({ type: "holds", computer, holds: this.holds(computer) });
  }
}
