// The computer registry (spec §9.1, §9.2, §5.4 `computers.read` and `computers.control`, §5.5; plan §4 J, M1): every
// computer the user connected, its name, OS, display, agents, level and state, and, for computer use, its holds, the
// user-working mark, whether an action is running and where Clover's own windows are. Holds, the mark and
// `computers.control` are kept for opensky (§4, §9.2), with the rules of the inherited computer-use code (helper
// 1.22.0).
//
// What each computer owns: its own name, level and agents, which it says to the others in its hello over the link
// (`peers.ts`). A computer's level changes only on that computer (§8.5: levels stay on each computer), and raising it
// takes proof (`LevelRaiseProof`); the others hold a copy of it for their tree calls' level (§9.1). Holds, the mark,
// the action signal and the windows are kept by the computer whose screen they are about.
import { createHash } from "node:crypto";
import {
  COMPUTER_NAME_RE, DEFAULT_LEVEL, callBindingInput, levelAbove,
  type CloverWindow, type ComputerView, type HoldView, type Level,
} from "@waifucave/clover-protocol";
import { type AnswerDevices, type AnswerLedger, type CallCardRenderer, verifySignedAnswer } from "../contracts/approval-broker";
import type { Clock } from "../contracts/clock";
import { ContractError, Listeners, type Unsubscribe } from "../contracts/common";
import {
  holdsOverlap, levelRaiseCall, type ComputerChange, type ComputerRegistry, type HoldRequest, type LevelRaiseProof,
} from "../contracts/computer-registry";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

export type ComputerInput = Partial<ComputerView> & Pick<ComputerView, "name" | "device">;

/** What this computer keeps of its own entry across restarts: its level and its old names. */
export interface SelfState {
  name?: string;
  level?: Level;
  aliases?: string[];
}

export interface SelfStateStore {
  load(): SelfState;
  save(state: SelfState): void;
}

/** A store that keeps nothing (tests, and a computer before its home is set up). */
export const MEMORY_SELF_STORE: SelfStateStore = { load: () => ({}), save: () => {} };

/** Each computer's record of the card ids it took as proof: in memory until lane C's ledger lands on disk. */
class Ledger implements AnswerLedger {
  readonly #used = new Set<string>();
  claim(cardId: string): boolean {
    if (this.#used.has(cardId)) return false;
    this.#used.add(cardId);
    return true;
  }
}

export interface CoreComputerRegistryOptions {
  clock: Pick<Clock, "now">;
  self: ComputerInput;
  others?: ComputerInput[];
  /** Checks a signed answer from elsewhere (a paired device's); without it, no signed raise counts. */
  devices?: AnswerDevices;
  ledger?: AnswerLedger;
  /** This computer's own card for a call, which a signed answer's card must match (review N1). */
  render?: CallCardRenderer;
  /** Where this computer's own level and old names are kept. */
  store?: SelfStateStore;
}

export class CoreComputerRegistry implements ComputerRegistry {
  readonly #clock: Pick<Clock, "now">;
  #self: string;
  readonly #computers = new Map<string, ComputerView>();
  readonly #holds = new Map<string, HoldView>();
  readonly #working = new Map<string, Set<string>>();
  readonly #running = new Set<string>();
  readonly #windows = new Map<string, CloverWindow[]>();
  readonly #listeners = new Listeners<ComputerChange>();
  readonly #devices: AnswerDevices | undefined;
  readonly #ledger: AnswerLedger;
  readonly #render: CallCardRenderer;
  readonly #store: SelfStateStore;
  #holdSeq = 0;

  constructor(opts: CoreComputerRegistryOptions) {
    this.#clock = opts.clock;
    this.#devices = opts.devices;
    this.#render = opts.render ?? (() => undefined);
    this.#ledger = opts.ledger ?? new Ledger();
    this.#store = opts.store ?? MEMORY_SELF_STORE;
    const saved = this.#store.load();
    const self: ComputerInput = {
      ...opts.self,
      ...(saved.name !== undefined && COMPUTER_NAME_RE.test(saved.name) ? { name: saved.name } : {}),
      ...(saved.level !== undefined ? { level: saved.level } : {}),
      ...(saved.aliases !== undefined ? { aliases: saved.aliases } : {}),
    };
    this.#self = self.name;
    this.add(self, true);
    for (const c of opts.others ?? []) this.add(c);
  }

  // ---- what the link, the device list and the app tell it (drivers) -------------------------------------------

  /** A computer was connected (paired, or created as a cloud computer), or said hello for the first time. */
  add(input: ComputerInput, isSelf = false): ComputerView {
    if (!COMPUTER_NAME_RE.test(input.name)) throw new ContractError("invalid", "a computer's name is letters, digits and hyphens");
    if (this.#find(input.name)) throw new ContractError("conflict", `${input.name} is taken`);
    if (this.byDevice(input.device)) throw new ContractError("conflict", `device ${input.device} is already a computer here`);
    const view: ComputerView = {
      aliases: [], os: "macos", hasDisplay: true, agents: [], level: DEFAULT_LEVEL, state: "online", isMain: false,
      ...(isSelf ? { link: "self" as const } : { link: "lan" as const }),
      ...structuredClone(input),
    };
    if (isSelf) view.state = "online";
    this.#computers.set(view.name, view);
    this.#listeners.emit({ type: "computer", computer: structuredClone(view) });
    return structuredClone(view);
  }

  /** A computer was revoked or removed: it leaves the tree, with its holds. Never this computer. */
  remove(name: string): void {
    const c = this.#find(name);
    if (!c || c.name === this.#self) return;
    this.#computers.delete(c.name);
    for (const [id, h] of this.#holds) if (h.computer === c.name) this.#holds.delete(id);
    this.#working.delete(c.name);
    this.#running.delete(c.name);
    this.#windows.delete(c.name);
    this.#listeners.emit({ type: "removed", name: c.name });
  }

  /** The link to it came up or went down (a computer asleep, or back). This computer is always online. */
  setOnline(name: string, online: boolean): void {
    const c = this.#must(name);
    if (c.name === this.#self) return;
    const state = online ? "online" : "offline";
    if (c.state === state) return;
    c.state = state;
    this.#listeners.emit({ type: "computer", computer: structuredClone(c) });
  }

  /** What another computer said about itself in its hello: its OS, display, agents and level (a copy; it enforces its
   *  own), and how the link reaches it. Never this computer's entry. */
  update(name: string, patch: Partial<Pick<ComputerView, "os" | "hasDisplay" | "agents" | "level" | "link" | "isMain" | "secrets">>): void {
    const c = this.#must(name);
    if (c.name === this.#self) return;
    const next = { ...c, ...structuredClone(patch) };
    if (JSON.stringify(next) === JSON.stringify(c)) return;
    Object.assign(c, structuredClone(patch));
    this.#listeners.emit({ type: "computer", computer: structuredClone(c) });
  }

  /** This computer's own facts changed (an agent installed, the display): announced to the others by `peers.ts`. */
  updateSelf(patch: Partial<Pick<ComputerView, "os" | "hasDisplay" | "agents" | "isMain" | "secrets">>): void {
    const c = this.#computers.get(this.#self)!;
    Object.assign(c, structuredClone(patch));
    this.#listeners.emit({ type: "computer", computer: structuredClone(c) });
  }

  /** The computer a device is. */
  byDevice(device: string): ComputerView | undefined {
    for (const c of this.#computers.values()) if (c.device === device) return structuredClone(c);
    return undefined;
  }

  // ---- the contract -----------------------------------------------------------------------------------------------

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

  async setLevel(name: string, level: Level, proof?: LevelRaiseProof): Promise<void> {
    const c = this.#must(name);
    if (c.name !== this.#self) {
      // §8.5: levels stay on each computer. Another computer's level changes there, with its own card or the user's
      // signed answer travelling to it (J-M2, "levels per computer").
      throw new ContractError("refused", `${c.name}'s level changes on ${c.name}`);
    }
    if (levelAbove(level, c.level)) {
      const why = await this.#checkRaise(c.name, level, proof);
      if (why !== null) throw new ContractError("refused", `raising a computer's level takes the user's answer: ${why}`);
    }
    if (c.level === level) return;
    c.level = level;
    this.#saveSelf();
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
    if (this.#self === old) {
      this.#self = newName;
      this.#saveSelf();
    }
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
    if (c.state !== "online") throw new ContractError("computer_offline", `${c.name} is offline`, { computer: c.name });
    if (this.#working.get(c.name)?.has(req.target.app)) {
      throw new ContractError("user_working", `you're working in ${req.target.app}; your message or an answer to a question lets the agent act`, { app: req.target.app });
    }
    for (const h of this.#holds.values()) {
      if (h.computer !== c.name || !holdsOverlap(h.target, req.target)) continue;
      if (h.session === req.session && h.session !== undefined) {
        if (JSON.stringify(h.target) === JSON.stringify(req.target)) return structuredClone(h);
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
    if (set.has(app)) return;
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

  // ---- inside -----------------------------------------------------------------------------------------------------

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

  #saveSelf(): void {
    const c = this.#computers.get(this.#self)!;
    this.#store.save({ name: c.name, level: c.level, aliases: [...c.aliases] });
  }

  async #checkRaise(name: string, level: Level, proof: LevelRaiseProof | undefined): Promise<string | null> {
    if (!proof) return "no proof";
    if (proof.via === "terminal") return null;
    const { method, params } = levelRaiseCall(name, level);
    if (proof.via === "signed") {
      if (!this.#devices) return "no device registry to check a signed answer";
      const verdict = await verifySignedAnswer(proof.answer, { self: name, method, params, now: this.#clock.now(), sha256, devices: this.#devices, ledger: this.#ledger, render: this.#render });
      return verdict === "ok" ? null : verdict;
    }
    const { card, outcome, optionId } = proof.record;
    if (outcome !== "approved" || card.options.find((o) => o.id === optionId)?.kind !== "approve") return "the card wasn't approved";
    const b = card.binds;
    if (card.change !== "computer-level" || !b || b.computer !== name || b.method !== method || b.params !== sha256(callBindingInput(method, params))) return "the card is for another change";
    return this.#ledger.claim(card.id) ? null : "the card was used already";
  }

  #emitHolds(computer: string): void {
    this.#listeners.emit({ type: "holds", computer, holds: this.holds(computer) });
  }
}
