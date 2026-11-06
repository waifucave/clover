// Which computer is the main one (spec §6.4 "The main computer"): the one the user chose, otherwise one chosen for
// them. Kept in `<home>/lease/main.json` (no secret in it).
//
// * **Chosen automatically:** the always-on device. A headless server first, then a desktop; ties by device id, so every
//   computer that knows the same devices picks the same one. A cloud computer becomes main only after the user confirms
//   it (§9.2), so it's never picked automatically.
// * **The user's choice** is made on the chosen computer itself: there it's the user's own (their terminal, or a card
//   they answered), or a `peer.call` whose signed answer that computer checked (devices/rpc.ts). That computer then
//   tells its peers over the link that it's the main, and a peer takes only such a claim about the sender itself,
//   never one computer's word about another (`acceptClaim`). A claim grants nothing a member couldn't take anyway: any
//   member of the scope can take the lease from the handshake with `takeover`. What the claim decides is where a
//   takeover computer hands the bots back when that computer returns.
import { join } from "node:path";
import { Listeners, type Unsubscribe } from "../contracts/common";
import type { DeviceRecord } from "../contracts/device-registry";
import { readJsonFile, writeJsonFile } from "../devices/json-file";

export interface MainChoiceRecord {
  device: string;
  /** Shared time of the choice; the later of two wins. */
  at: number;
  /** Made here by the user (or by a signed answer checked here), or a peer's claim about itself. */
  via: "user" | "claim";
}

export interface MainChoiceOptions {
  home: string;
  self: string;
  /** The paired devices (the registry's `list`). */
  devices(): DeviceRecord[];
}

/** The automatic main: a headless server, then a desktop, by device id; never a cloud computer or a device with no
 *  core. Undefined when there is no such computer. */
export function automaticMain(devices: readonly DeviceRecord[]): string | undefined {
  const rank = (d: DeviceRecord) => (d.kind === "server" ? 0 : d.kind === "desktop" ? 1 : 9);
  const candidates = devices.filter((d) => d.runsCore && d.revokedAt === undefined && rank(d) < 9);
  candidates.sort((a, b) => rank(a) - rank(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return candidates[0]?.id;
}

export class MainChoice {
  readonly #o: MainChoiceOptions;
  readonly #path: string;
  readonly #listeners = new Listeners<string | null>();
  #record: MainChoiceRecord | undefined;

  constructor(o: MainChoiceOptions) {
    this.#o = o;
    this.#path = join(o.home, "lease", "main.json");
    const saved = readJsonFile<MainChoiceRecord>(this.#path);
    if (saved && typeof saved.device === "string" && typeof saved.at === "number" && (saved.via === "user" || saved.via === "claim")) this.#record = saved;
  }

  /** The record, if a choice was made (here or by a peer's claim). */
  record(): MainChoiceRecord | undefined {
    return this.#record ? { ...this.#record } : undefined;
  }

  /** The main computer now: the choice while the device is still a paired computer, else the automatic one. */
  current(): string | null {
    const devices = this.#o.devices();
    const r = this.#record;
    if (r && devices.some((d) => d.id === r.device && d.runsCore && d.revokedAt === undefined)) return r.device;
    return automaticMain(devices) ?? null;
  }

  /** Whether this computer is the main one now. */
  isSelf(): boolean {
    return this.current() === this.#o.self;
  }

  /** Whether the current main was chosen by the user (rather than automatically). */
  chosen(): boolean {
    const r = this.#record;
    return r !== undefined && this.current() === r.device;
  }

  /** The user made this computer the main one (here, or by an answer this computer checked). */
  chooseSelf(at: number): MainChoiceRecord {
    this.#set({ device: this.#o.self, at, via: "user" });
    return this.#record!;
  }

  /** A peer says it is the main one. Taken only about the sender itself, from a paired computer, and only when later
 *   than the choice this computer has. */
  acceptClaim(from: string, at: number): boolean {
    if (!Number.isFinite(at) || from === this.#o.self) return false;
    if (!this.#o.devices().some((d) => d.id === from && d.runsCore && d.revokedAt === undefined)) return false;
    if (this.#record && this.#record.at >= at) return false;
    this.#set({ device: from, at, via: "claim" });
    return true;
  }

  /** The device was revoked or unpaired: the automatic choice applies again. */
  forget(device: string): void {
    if (this.#record?.device !== device) return;
    this.#record = undefined;
    writeJsonFile(this.#path, {});
    this.#listeners.emit(this.current());
  }

  watch(fn: (main: string | null) => void): Unsubscribe {
    return this.#listeners.add(fn);
  }

  #set(r: MainChoiceRecord): void {
    this.#record = r;
    writeJsonFile(this.#path, r);
    this.#listeners.emit(this.current());
  }
}
