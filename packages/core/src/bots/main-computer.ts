// Which computer runs the bots' conversations (spec §6.4 "The main computer", "The main holds a lease", "Fencing the
// old main", "When the main returns"). Owner: lane D, over lane H's `Lease` (its fake until H-M2).
//
// * **The runner** is the computer holding the lease; while no one holds it, the main the user chose (or that was
//   chosen for them). Every bot's main conversation runs there, so "the computer running the bot" (`BotView.computer`)
//   is the runner.
// * **This computer runs the bots** only while it holds the lease and may act on it (`Lease.canAct`): a main that
//   can't renew stops starting turns before its lease ends, with the margin the lease keeps for clock error.
// * **Without a lease** (one computer, or before lane H's link exists), this computer is always the runner
//   (`soleComputer`).
//
// The bot service follows `watch`: it closes the gate on bots' turns when this computer stops being the runner,
// catches up a conversation it takes over (calls the old runner never finished are recorded as maybe having run
// there), and hands the bots back to a returning main between turns (`BotService.handBack`).
import type { LeaseView } from "@waifucave/clover-protocol";
import { Listeners, type Unsubscribe } from "../contracts/common";
import type { Lease } from "../contracts/lease";

export interface MainComputer {
  /** This computer's name in the folder tree (§9.1). */
  readonly self: string;
  /** The computer running the bots' conversations now, by name; undefined while none is known. */
  runner(): string | undefined;
  /** The computer the user chose as main (or that was chosen automatically), by name. */
  main(): string | undefined;
  /** Whether this computer runs the bots now. */
  runsHere(): boolean;
  /** The lease epoch every record carries (§6.4 "Events carry their lease epoch"); none without a lease. */
  epoch(): number | undefined;
  /** Gives the lease up at once, so the main can take it (`BotService.handBack`). */
  release(): Promise<void>;
  watch(fn: () => void): Unsubscribe;
}

/** One computer with no lease: it always runs its bots. */
export function soleComputer(name: string): MainComputer {
  return {
    self: name,
    runner: () => name,
    main: () => name,
    runsHere: () => true,
    epoch: () => undefined,
    release: async () => {},
    watch: () => () => {},
  };
}

export interface LeaseMainComputerOptions {
  lease: Lease;
  /** This computer's name. */
  self: string;
  /** A device's computer name (lane H's `DeviceRecord.computer`); undefined for one that runs no core. */
  computerOf(device: string): string | undefined;
}

/** The runner, read from lane H's lease. */
export class LeaseMainComputer implements MainComputer {
  readonly self: string;
  readonly #o: LeaseMainComputerOptions;
  readonly #listeners = new Listeners<void>();
  readonly #off: Unsubscribe;

  constructor(opts: LeaseMainComputerOptions) {
    this.#o = opts;
    this.self = opts.self;
    this.#off = opts.lease.watch(() => this.#listeners.emit());
  }

  #state(): LeaseView {
    return this.#o.lease.state();
  }

  #name(device: string | null): string | undefined {
    if (device === null) return undefined;
    if (device === this.#o.lease.self) return this.self;
    return this.#o.computerOf(device);
  }

  runner(): string | undefined {
    const state = this.#state();
    return this.#name(state.holder) ?? this.#name(state.main);
  }

  main(): string | undefined {
    return this.#name(this.#state().main);
  }

  runsHere(): boolean {
    return this.#state().holder === this.#o.lease.self && this.#o.lease.canAct();
  }

  epoch(): number | undefined {
    return this.#state().epoch;
  }

  release(): Promise<void> {
    return this.#o.lease.release();
  }

  watch(fn: () => void): Unsubscribe {
    return this.#listeners.add(fn);
  }

  close(): void {
    this.#off();
  }
}
