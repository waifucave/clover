// Cloud computers (spec §9.2; plan §4 J, M3): a cloud computer is a plugin folder that contributes `computer` (its
// provider, size and region). This is the core's side: it notices the folders, asks the user before it creates,
// resizes or deletes a VM, has the folder's provider plugin (`computerProviders`) do it, hands the VM a pairing token
// that works once, and keeps the VM's own state (its server id and address) here, not in the folder.
//
// * A new folder: the user's card for creating it, then the provider creates the VM with the official image's
//   cloud-init (`image.ts`), carrying a single-use pairing token. When the VM's daemon pairs with that token (lane H's
//   pairing calls `pairing.consume`), the computer is in the tree; the user is then asked whether to make it the main
//   computer, unless the folder says `makeMain: "no"`.
// * `size` changed in the folder: the user's card for resizing it, then the provider resizes it.
// * The folder removed: unless it says `onRemove: "keep"`, the user is asked whether to delete the VM too.
//   Deleting a VM always asks, whatever the folder says.
// * Nothing here talks to a cloud: the provider plugins do, with the user's own credentials through the core's keyed
//   fetch. The tests use fakes; no real VM is made until the live gates.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { COMPUTER_NAME_RE } from "@waifucave/clover-protocol";
import { ContractError } from "../contracts/common";

/** A cloud computer's folder, as its `computer` contribution says (the plugin SDK's `ComputerSchema`). */
export interface CloudFolder {
  /** The plugin folder that contributes it, e.g. `computer-hetzner-1`. */
  folder: string;
  provider: string;
  name: string;
  size: string;
  region: string;
  image?: string;
  makeMain?: "ask" | "no";
  onRemove?: "ask" | "keep";
}

/** What a provider plugin's `computerProviders` handler does (lane J's proposal for the point's shape). */
export interface CloudProviderHandler {
  /** Creates the VM with `userData` (cloud-init) and no cloud service account. */
  create(args: { name: string; size: string; region: string; image?: string; userData: string }, ctx?: { signal?: AbortSignal }): Promise<{ serverId: string; address?: string }>;
  resize(args: { serverId: string; region: string; size: string }, ctx?: { signal?: AbortSignal }): Promise<void>;
  delete(args: { serverId: string; region: string }, ctx?: { signal?: AbortSignal }): Promise<void>;
  status(args: { serverId: string; region: string }, ctx?: { signal?: AbortSignal }): Promise<{ state: "creating" | "running" | "off" | "gone"; address?: string }>;
}

/** The cards the user answers (lane C's broker shows them; any of the user's devices). */
export type CloudCard =
  | { kind: "cloud-create"; name: string; provider: string; size: string; region: string; folder: string }
  | { kind: "cloud-resize"; name: string; provider: string; from: string; to: string }
  | { kind: "cloud-delete"; name: string; provider: string; why: "folder-removed" | "asked" }
  | { kind: "cloud-make-main"; name: string };

export interface ReconcileResult {
  created: string[];
  resized: string[];
  deleted: string[];
  declined: string[];
  failed: { name: string; reason: string }[];
}

/** A VM's own state, kept by the core (never in the folder). */
export interface CloudVm {
  name: string;
  folder: string;
  provider: string;
  serverId: string;
  region: string;
  size: string;
  address?: string;
  state: "creating" | "paired" | "deleting";
  createdAt: number;
}

export interface CloudStateStore {
  load(): CloudVm[];
  save(vms: readonly CloudVm[]): void;
}

/** `<Clover home>/computers/cloud.json`: names, ids and addresses only, never a credential or a token. */
export class FileCloudStateStore implements CloudStateStore {
  readonly #path: string;
  constructor(cloverHome: string) {
    this.#path = join(cloverHome, "computers", "cloud.json");
  }
  load(): CloudVm[] {
    try {
      const v = JSON.parse(readFileSync(this.#path, "utf8")) as { vms?: CloudVm[] };
      return Array.isArray(v.vms) ? v.vms : [];
    } catch {
      return [];
    }
  }
  save(vms: readonly CloudVm[]): void {
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    const tmp = `${this.#path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ vms }, null, 2), { mode: 0o600 });
    renameSync(tmp, this.#path);
  }
}

/** Why the pair door refused a cloud token (`PairingTokens.claim`). */
export type TokenRefusal = "unknown" | "expired" | "used" | "other-device";

/** Pairing tokens that work once (§9.2 "Safety"): 32 random bytes, kept here only as a hash and an expiry, in memory,
 *  until used or expired. A VM's daemon presents its token at the pair door (lane H's pairing): the door `claim`s it,
 *  which binds it to the device the link authenticated, and the pairing `consume`s it once it is done. A token bound to
 *  one device is refused to any other; a used one is refused as used until it would have expired. */
export class PairingTokens {
  readonly #byHash = new Map<string, { computer: string; expiresAt: number; device?: string }>();
  /** Used tokens' hashes, until they would have expired: a second presentation is told apart from a wrong token. */
  readonly #used = new Map<string, number>();
  readonly #clock: { now(): number };
  readonly #ttlMs: number;

  constructor(o: { clock: { now(): number }; ttlMs?: number }) {
    this.#clock = o.clock;
    this.#ttlMs = o.ttlMs ?? 60 * 60 * 1000;
  }

  /** A new token for `computer`; any earlier one for it stops working. */
  mint(computer: string): string {
    for (const [h, v] of this.#byHash) if (v.computer === computer) this.#byHash.delete(h);
    const token = randomBytes(32).toString("base64url");
    this.#byHash.set(hash(token), { computer, expiresAt: this.#clock.now() + this.#ttlMs });
    return token;
  }

  /** The pair door's check: the computer a token was made for, bound from now on to `device` (the device the link
   *  authenticated). Refused when unknown, expired, used, or bound to another device. Claiming again from the same
   *  device (a pairing cut off midway) is fine until it is consumed. */
  claim(token: string, device: string): { computer: string } | { refused: TokenRefusal } {
    this.#prune();
    const found = this.#find(token);
    if (!found) return { refused: found === null && this.#wasUsed(token) ? "used" : "unknown" };
    const [, v] = found;
    if (v.expiresAt < this.#clock.now()) return { refused: "expired" };
    if (v.device !== undefined && v.device !== device) return { refused: "other-device" };
    v.device = device;
    return { computer: v.computer };
  }

  /** The computer a token was made for, once; null for an unknown, used or expired token, or (with `device`) one
   *  bound to another device. */
  consume(token: string, device?: string): string | null {
    const found = this.#find(token);
    if (!found) return null;
    const [k, v] = found;
    if (device !== undefined && v.device !== undefined && v.device !== device) return null;
    this.#byHash.delete(k);
    if (v.expiresAt < this.#clock.now()) return null;
    this.#used.set(k, v.expiresAt);
    return v.computer;
  }

  /** Whether `computer` has a token waiting. */
  waiting(computer: string): boolean {
    const now = this.#clock.now();
    return [...this.#byHash.values()].some((v) => v.computer === computer && v.expiresAt >= now);
  }

  /** The held entry for a token (compared in constant time); undefined when there is none, null for a malformed one. */
  #find(token: string): [string, { computer: string; expiresAt: number; device?: string }] | undefined | null {
    if (typeof token !== "string" || token.length < 32 || token.length > 128) return undefined;
    const h = hash(token);
    for (const [k, v] of this.#byHash) if (equal(k, h)) return [k, v];
    return null;
  }

  #wasUsed(token: string): boolean {
    const h = hash(token);
    for (const k of this.#used.keys()) if (equal(k, h)) return true;
    return false;
  }

  #prune(): void {
    const now = this.#clock.now();
    for (const [k, at] of this.#used) if (at < now) this.#used.delete(k);
  }
}

const hash = (t: string) => createHash("sha256").update(t).digest("hex");
const equal = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export interface CloudComputersOptions {
  clock: { now(): number };
  store: CloudStateStore;
  /** A `computerProviders` handler by id (lane D's plugin host). */
  provider: (id: string) => CloudProviderHandler | undefined;
  /** Shows the user a card and gives back whether they approved (lane C's broker). */
  confirm: (card: CloudCard) => Promise<boolean>;
  /** The official image's cloud-init for a VM (`image.ts`): its name and its pairing token. */
  userData: (o: { name: string; token: string }) => string;
  /** Makes a computer the main one (lane H's main election). */
  makeMain?: (name: string) => Promise<void>;
  pairing?: PairingTokens;
  log?: (line: string) => void;
}

/** The core's side of cloud computers. */
export class CloudComputers {
  readonly #o: CloudComputersOptions;
  readonly #vms = new Map<string, CloudVm>();
  readonly pairing: PairingTokens;
  /** One change per computer at a time. */
  readonly #busy = new Set<string>();

  constructor(o: CloudComputersOptions) {
    this.#o = o;
    this.pairing = o.pairing ?? new PairingTokens({ clock: o.clock });
    for (const vm of o.store.load()) this.#vms.set(vm.name, vm);
  }

  list(): CloudVm[] {
    return [...this.#vms.values()].map((v) => ({ ...v }));
  }

  get(name: string): CloudVm | undefined {
    const v = this.#vms.get(name);
    return v ? { ...v } : undefined;
  }

  /** Brings the VMs in line with the folders there are now: creates, resizes or asks about deleting, each with the
   *  user's card. `held` names folders that are still there but off, or waiting for the user's OK: their VMs are left
   *  as they are, neither changed nor asked about. One folder's failure (its provider isn't installed, the cloud
   *  refused) doesn't stop the rest; it is in `failed`. Answers what it did, for the log and the tests. */
  async reconcile(folders: readonly CloudFolder[], held: ReadonlySet<string> = new Set()): Promise<ReconcileResult> {
    const out: ReconcileResult = { created: [], resized: [], deleted: [], declined: [], failed: [] };
    this.remember(folders);
    const seen = new Set<string>();
    const folderIds = new Set(folders.map((f) => f.folder));
    const attempt = async (name: string, fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        out.failed.push({ name, reason });
        this.#o.log?.(`cloud computer ${name}: ${reason}`);
      }
    };
    for (const f of folders) {
      seen.add(f.name);
      await attempt(f.name, async () => {
        const vm = this.#vms.get(f.name);
        if (vm && vm.folder !== f.folder) throw new ContractError("conflict", `${f.name} is ${vm.folder}'s computer already`);
        // A folder whose name changed still has its VM under the old name: no second VM, and no card to delete the
        // first. The tree renames a computer (it keeps its old name as an alias); the folder follows.
        const before = !vm ? [...this.#vms.values()].find((v) => v.folder === f.folder) : undefined;
        if (before) throw new ContractError("conflict", `${f.folder}'s computer is ${before.name}; rename it in the tree, not in its folder`);
        if (!vm) {
          (await this.#create(f) ? out.created : out.declined).push(f.name);
        } else if (vm.size !== f.size && vm.state !== "deleting") {
          (await this.#resize(vm, f.size) ? out.resized : out.declined).push(f.name);
        }
      });
    }
    for (const vm of [...this.#vms.values()]) {
      if (seen.has(vm.name) || held.has(vm.folder) || folderIds.has(vm.folder)) continue;
      // A folder that said `keep`, or whose VM the user kept when it went: not asked about again.
      if (this.#removedKeep.has(vm.name)) continue;
      await attempt(vm.name, async () => {
        if (await this.delete(vm.name, "folder-removed")) out.deleted.push(vm.name);
        else {
          this.#removedKeep.add(vm.name);
          out.declined.push(vm.name);
        }
      });
    }
    return out;
  }

  /** Folders removed whose VM the user chose to keep, or whose folder said `keep`: not asked about again. */
  readonly #removedKeep = new Set<string>();

  /** Records a folder's `onRemove` before it goes, so a removed folder that said `keep` keeps its VM unasked. */
  remember(folders: readonly CloudFolder[]): void {
    for (const f of folders) {
      if (f.onRemove === "keep") this.#removedKeep.add(f.name);
      else this.#removedKeep.delete(f.name);
    }
  }

  /** Deletes a VM: always the user's card first, whatever the folder says. */
  async delete(name: string, why: "folder-removed" | "asked" = "asked"): Promise<boolean> {
    const vm = this.#vms.get(name);
    if (!vm) throw new ContractError("not_found", `no cloud computer ${name}`);
    return this.#one(name, async () => {
      const p = this.#provider(vm.provider);
      if (!(await this.#o.confirm({ kind: "cloud-delete", name, provider: vm.provider, why }))) return false;
      vm.state = "deleting";
      this.#save();
      await p.delete({ serverId: vm.serverId, region: vm.region });
      this.#vms.delete(name);
      this.#removedKeep.delete(name);
      this.#save();
      return true;
    });
  }

  /** Lane H's pairing calls this when a VM's daemon presents its token: the computer it was made for, once. Then the
   *  user is asked whether to make it the main computer, unless its folder said `no`. */
  async paired(token: string, folders: readonly CloudFolder[], device?: string): Promise<string | null> {
    const name = this.pairing.consume(token, device);
    if (!name) return null;
    const vm = this.#vms.get(name);
    if (!vm) return null;
    vm.state = "paired";
    this.#save();
    const folder = folders.find((f) => f.name === name);
    if (folder?.makeMain !== "no" && this.#o.makeMain && (await this.#o.confirm({ kind: "cloud-make-main", name }))) {
      await this.#o.makeMain(name);
    }
    return name;
  }

  async #create(f: CloudFolder): Promise<boolean> {
    if (!COMPUTER_NAME_RE.test(f.name)) throw new ContractError("invalid", `${f.name} isn't a computer name`);
    return this.#one(f.name, async () => {
      const p = this.#provider(f.provider);
      if (!(await this.#o.confirm({ kind: "cloud-create", name: f.name, provider: f.provider, size: f.size, region: f.region, folder: f.folder }))) return false;
      const token = this.pairing.mint(f.name);
      const made = await p.create({ name: f.name, size: f.size, region: f.region, ...(f.image ? { image: f.image } : {}), userData: this.#o.userData({ name: f.name, token }) });
      this.#vms.set(f.name, {
        name: f.name, folder: f.folder, provider: f.provider, serverId: made.serverId, region: f.region, size: f.size,
        ...(made.address ? { address: made.address } : {}), state: "creating", createdAt: this.#o.clock.now(),
      });
      this.#save();
      return true;
    });
  }

  async #resize(vm: CloudVm, size: string): Promise<boolean> {
    return this.#one(vm.name, async () => {
      if (!(await this.#o.confirm({ kind: "cloud-resize", name: vm.name, provider: vm.provider, from: vm.size, to: size }))) return false;
      await this.#provider(vm.provider).resize({ serverId: vm.serverId, region: vm.region, size });
      vm.size = size;
      this.#save();
      return true;
    });
  }

  #provider(id: string): CloudProviderHandler {
    const p = this.#o.provider(id);
    if (!p) throw new ContractError("not_installed", `no computer provider ${id}`);
    return p;
  }

  async #one<T>(name: string, fn: () => Promise<T>): Promise<T> {
    if (this.#busy.has(name)) throw new ContractError("conflict", `${name} is being changed already`);
    this.#busy.add(name);
    try {
      return await fn();
    } finally {
      this.#busy.delete(name);
    }
  }

  #save(): void {
    this.#o.store.save([...this.#vms.values()]);
  }
}
