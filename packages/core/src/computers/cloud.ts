// Cloud computers (spec §9.2; plan §4 J, M3): a cloud computer is a plugin folder that contributes `computer` (its
// provider, size and region). This is the core's side: it notices the folders, asks the user before it creates,
// resizes or deletes a VM, has the folder's provider plugin (`computerProviders`) do it, and hands the VM a pairing
// token that works once (#254's review and the controller's rulings throughout).
//
// * Only the main computer acts: the one whose lease (lane H's) lets it act now (`CloudAuthority`). Its tenure (the
//   lease's scope and epoch) is taken when a change starts and looked at again after the user's card answer and
//   right before each provider call: an answer that comes after this computer lost the lease does nothing.
// * The cloud is the source of truth. Every VM carries the `clover-computer` label with its folder's id; before a VM
//   is made, the provider is asked for one with that label, and one that exists is adopted, never made twice. A new
//   main finds every VM the same way. `cloud.json` is only a cache: a `creating` entry, with its label, is written
//   before the provider is asked to create, and settled from the provider afterwards. A resize or a delete names the
//   instance by its id and its label, and the provider plugin acts only when the two match: never on a bare name.
// * A pairing token works once, for an hour, and is bound to the tenure that minted it. Its hash and expiry are kept
//   in the main's home (`pairing.json`, 0600), so a restart keeps them; the token itself goes only into the VM's
//   cloud-init. A VM still unpaired when its token expired, or when the main changed, gets a "pair again" card, which
//   deletes the empty VM and makes it again with a new token: nothing new is pushed into a running VM. Lane H's
//   authenticated pairing door consumes the token (`CloudPairingDoor`), binding it to the device that presented it.
// * Nothing here talks to a cloud: the provider plugins do, with the user's own credentials through the core's keyed
//   fetch. The tests use fakes; no real VM is made until the live gates.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { COMPUTER_NAME_RE, pluginIdToSegment } from "@waifucave/clover-protocol";
import { ContractError } from "../contracts/common";

/** The label every cloud computer's VM carries, with its folder's id (`/` written `--`). */
export const CLOUD_LABEL = "clover-computer";

/** The label value for a folder: its id, `/` written `--`, which both clouds take as a label value (lower case,
 *  digits and `-`); one over their 63 characters is written `h-` and the first 40 hex digits of its SHA-256. */
export const cloudLabelOf = (folder: string): string => {
  const seg = pluginIdToSegment(folder);
  return seg.length <= 63 ? seg : `h-${createHash("sha256").update(seg).digest("hex").slice(0, 40)}`;
};

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

/** A VM as its provider lists it. */
export interface CloudInstance {
  serverId: string;
  /** Its `clover-computer` label. */
  label: string;
  region: string;
  size?: string;
  state: "creating" | "running" | "off" | "gone";
  address?: string;
}

/** What a provider plugin's `computerProviders` handler does (lane J's proposal for the point's shape). Every call but
 *  `create` and `list` names the instance by its id and its label, and the plugin acts only when the instance there
 *  carries that label. */
export interface CloudProviderHandler {
  /** Creates the VM with `userData` (cloud-init), the `clover-computer` label set to `label`, and no cloud identity. */
  create(args: { name: string; size: string; region: string; image?: string; userData: string; label: string }, ctx?: { signal?: AbortSignal }): Promise<{ serverId: string; address?: string }>;
  /** The VMs carrying the `clover-computer` label: with that value, or any value when `label` is left out. */
  list(args: { label?: string }, ctx?: { signal?: AbortSignal }): Promise<CloudInstance[]>;
  resize(args: { serverId: string; label: string; region: string; size: string }, ctx?: { signal?: AbortSignal }): Promise<void>;
  delete(args: { serverId: string; label: string; region: string }, ctx?: { signal?: AbortSignal }): Promise<void>;
  status(args: { serverId: string; label: string; region: string }, ctx?: { signal?: AbortSignal }): Promise<{ state: CloudInstance["state"]; address?: string }>;
  /** The VM has paired: clear what it was handed where the cloud allows (Google Cloud's `user-data`). */
  paired?(args: { serverId: string; label: string; region: string }, ctx?: { signal?: AbortSignal }): Promise<void>;
}

/** Whether this computer may act as the main computer now, and under which tenure (lane H's lease: its scope and
 *  epoch). */
export interface CloudAuthority {
  canAct(): boolean;
  /** `<scope>:<epoch>` while this computer holds the lease; undefined otherwise. */
  tenure(): string | undefined;
}

/** The cards the user answers (lane C's broker shows them; any of the user's devices). */
export type CloudCard =
  | { kind: "cloud-create"; name: string; provider: string; size: string; region: string; folder: string }
  | { kind: "cloud-resize"; name: string; provider: string; from: string; to: string }
  | { kind: "cloud-delete"; name: string; provider: string; why: "folder-removed" | "asked" }
  | { kind: "cloud-repair"; name: string; provider: string; why: "token-expired" | "main-changed" }
  | { kind: "cloud-make-main"; name: string };

/** A VM's own state, as this main last saw it: a cache, settled from the provider. */
export interface CloudVm {
  name: string;
  folder: string;
  provider: string;
  label: string;
  /** Unknown while a create is in flight. */
  serverId?: string;
  region: string;
  size: string;
  address?: string;
  state: "creating" | "created" | "paired" | "deleting";
  createdAt: number;
  /** The device that paired with its token (lane H's pairing door). */
  device?: string;
}

export interface CloudState {
  vms: CloudVm[];
  /** Labels of VMs whose folder went and that the user chose to keep, or whose folder said `keep`. */
  kept: string[];
  /** Pairing tokens, by hash: never the token itself. */
  tokens: { hash: string; computer: string; expiresAt: number; tenure: string }[];
}

export interface CloudStateStore {
  load(): CloudState;
  save(state: CloudState): void;
}

const EMPTY: CloudState = { vms: [], kept: [], tokens: [] };

/** `<Clover home>/computers/cloud.json`, 0600, written whole: names, ids, labels and token hashes, never a credential
 *  or a token. */
export class FileCloudStateStore implements CloudStateStore {
  readonly #path: string;
  constructor(cloverHome: string) {
    this.#path = join(cloverHome, "computers", "cloud.json");
  }
  load(): CloudState {
    try {
      const v = JSON.parse(readFileSync(this.#path, "utf8")) as Partial<CloudState>;
      return { vms: Array.isArray(v.vms) ? v.vms : [], kept: Array.isArray(v.kept) ? v.kept : [], tokens: Array.isArray(v.tokens) ? v.tokens : [] };
    } catch {
      return structuredClone(EMPTY);
    }
  }
  save(state: CloudState): void {
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    const tmp = `${this.#path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(tmp, this.#path);
  }
}

const hash = (t: string) => createHash("sha256").update(t).digest("hex");
const equal = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Pairing tokens that work once (§9.2 "Safety"): 32 random bytes, kept only as a hash with its expiry and the tenure
 *  that minted it, in the state store, until used or expired. */
export class PairingTokens {
  readonly #clock: { now(): number };
  readonly #ttlMs: number;
  readonly #state: () => CloudState;
  readonly #save: () => void;

  constructor(o: { clock: { now(): number }; ttlMs?: number; state?: () => CloudState; save?: () => void }) {
    this.#clock = o.clock;
    this.#ttlMs = o.ttlMs ?? 60 * 60 * 1000;
    const own = structuredClone(EMPTY);
    this.#state = o.state ?? (() => own);
    this.#save = o.save ?? (() => {});
  }

  /** A new token for `computer` under `tenure`; any earlier one for it stops working. */
  mint(computer: string, tenure = ""): string {
    const s = this.#state();
    s.tokens = s.tokens.filter((t) => t.computer !== computer);
    const token = randomBytes(32).toString("base64url");
    s.tokens.push({ hash: hash(token), computer, expiresAt: this.#clock.now() + this.#ttlMs, tenure });
    this.#save();
    return token;
  }

  /** The computer a token was made for, once, under the same tenure; null for an unknown, used, expired or another
   *  tenure's token. */
  consume(token: string, tenure = ""): string | null {
    if (typeof token !== "string" || token.length < 32 || token.length > 128) return null;
    const s = this.#state();
    const h = hash(token);
    const i = s.tokens.findIndex((t) => equal(t.hash, h));
    if (i < 0) return null;
    const [t] = s.tokens.splice(i, 1);
    this.#save();
    return t!.expiresAt >= this.#clock.now() && t!.tenure === tenure ? t!.computer : null;
  }

  /** Whether `computer` has a token still good under `tenure`. */
  waiting(computer: string, tenure = ""): boolean {
    const now = this.#clock.now();
    return this.#state().tokens.some((t) => t.computer === computer && t.expiresAt >= now && t.tenure === tenure);
  }
}

/** What lane H's authenticated pairing door calls when a device presents a cloud computer's token: the computer it
 *  was made for, bound to that device, once; null when the token doesn't hold. */
export interface CloudPairingDoor {
  consume(token: string, device: string): Promise<{ computer: string } | null>;
}

export interface CloudComputersOptions {
  clock: { now(): number };
  store: CloudStateStore;
  /** A `computerProviders` handler by id (lane D's plugin host). */
  provider: (id: string) => CloudProviderHandler | undefined;
  /** The installed providers' ids, to find every VM with the label (a removed folder's too). */
  providerIds: () => string[];
  /** The lease: only the main computer acts (lane H). */
  authority: CloudAuthority;
  /** Shows the user a card and gives back whether they approved (lane C's broker). */
  confirm: (card: CloudCard) => Promise<boolean>;
  /** The official image's cloud-init for a VM (`image.ts`): its name and its pairing token. */
  userData: (o: { name: string; token: string }) => string;
  /** Whether a computer of that name is in the tree, paired (lane H's device list). */
  isPaired?: (name: string) => boolean;
  /** Makes a computer the main one (lane H's main election). */
  makeMain?: (name: string) => Promise<void>;
  /** How long a `creating` entry waits for its provider before it is looked up again (default 15 minutes). */
  createWaitMs?: number;
  log?: (line: string) => void;
}

export interface ReconcileResult {
  created: string[];
  adopted: string[];
  resized: string[];
  deleted: string[];
  repaired: string[];
  declined: string[];
  failed: { name: string; reason: string }[];
}

const emptyResult = (): ReconcileResult => ({ created: [], adopted: [], resized: [], deleted: [], repaired: [], declined: [], failed: [] });

/** The core's side of cloud computers, on the main computer. */
export class CloudComputers {
  readonly #o: CloudComputersOptions;
  readonly #state: CloudState;
  readonly pairing: PairingTokens;
  /** One change per computer at a time. */
  readonly #busy = new Set<string>();

  constructor(o: CloudComputersOptions) {
    this.#o = o;
    this.#state = o.store.load();
    this.pairing = new PairingTokens({ clock: o.clock, state: () => this.#state, save: () => this.#save() });
  }

  list(): CloudVm[] {
    return this.#state.vms.map((v) => ({ ...v }));
  }

  get(name: string): CloudVm | undefined {
    const v = this.#state.vms.find((x) => x.name === name);
    return v ? { ...v } : undefined;
  }

  /** Brings the VMs in line with the folders there are now, on the main computer only. `held` names folders that are
   *  there but off or waiting for the user's OK: their VMs are left alone. One folder's failure doesn't stop the rest;
   *  it is in `failed`. */
  async reconcile(folders: readonly CloudFolder[], held: ReadonlySet<string> = new Set()): Promise<ReconcileResult> {
    const out = emptyResult();
    const tenure = this.#o.authority.tenure();
    if (!this.#o.authority.canAct() || tenure === undefined) return out;
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
      if (f.onRemove === "keep") this.#keep(cloudLabelOf(f.folder));
      else this.#unkeep(cloudLabelOf(f.folder));
    }
    // What the clouds say: every VM with the label, per installed provider. A provider that can't be asked leaves
    // its VMs alone this time (nothing made, nothing deleted).
    const found = new Map<string, { provider: string; vm: CloudInstance }>();
    const unreachable = new Map<string, string>();
    for (const id of new Set([...this.#o.providerIds(), ...folders.map((f) => f.provider), ...this.#state.vms.map((v) => v.provider)])) {
      const p = this.#o.provider(id);
      if (!p) {
        unreachable.set(id, `no computer provider ${id}`);
        continue;
      }
      try {
        for (const vm of await p.list({})) if (vm.state !== "gone") found.set(vm.label, { provider: id, vm });
      } catch (e) {
        unreachable.set(id, `the computer provider ${id} couldn't be asked for its VMs (${(e as Error).message}); nothing was changed`);
        this.#o.log?.(`cloud provider ${id} can't be asked for its VMs: ${(e as Error).message}`);
      }
    }
    const seen = new Set<string>();
    for (const f of folders) {
      const label = cloudLabelOf(f.folder);
      seen.add(label);
      await attempt(f.name, async () => {
        if (!COMPUTER_NAME_RE.test(f.name)) throw new ContractError("invalid", `${f.name} isn't a computer name`);
        const why = unreachable.get(f.provider);
        if (why) throw new ContractError("not_installed", why);
        const other = this.#state.vms.find((v) => v.name === f.name && v.label !== label);
        if (other) throw new ContractError("conflict", `${f.name} is ${other.folder}'s computer already`);
        const renamed = this.#state.vms.find((v) => v.label === label && v.name !== f.name);
        if (renamed) throw new ContractError("conflict", `${f.folder}'s computer is ${renamed.name}; rename it in the tree, not in its folder`);
        const there = found.get(label);
        if (there) {
          const vm = this.#adopt(f, label, there.vm, out);
          if (vm.state === "deleting") return;
          if (vm.size !== f.size) {
            (await this.#resize(vm, f.size, tenure) ? out.resized : out.declined).push(f.name);
            return;
          }
          if (vm.state !== "paired" && !this.pairing.waiting(f.name, tenure)) {
            const why = this.#minted(f.name) ? "token-expired" : "main-changed";
            (await this.#repair(f, vm, why, tenure) ? out.repaired : out.declined).push(f.name);
          }
          return;
        }
        // None with the label. A create in flight (this main's, or one that crashed) waits for its provider.
        const pending = this.#state.vms.find((v) => v.label === label);
        if (pending?.state === "creating" && this.#o.clock.now() - pending.createdAt < (this.#o.createWaitMs ?? 15 * 60_000)) return;
        if (pending) this.#drop(pending.name);
        const made = await this.#create(f, label, tenure);
        if (made !== "exists") (made === "created" ? out.created : out.declined).push(f.name);
      });
    }
    // VMs with the label whose folder is gone: unless held, kept, or their provider couldn't be asked.
    for (const [label, { provider, vm }] of found) {
      if (seen.has(label) || this.#state.kept.includes(label)) continue;
      const cached = this.#state.vms.find((v) => v.label === label);
      if (held.has(cached?.folder ?? "") || [...held].some((h) => cloudLabelOf(h) === label)) continue;
      const name = cached?.name ?? label;
      await attempt(name, async () => {
        if (await this.#delete({ name, label, provider, serverId: vm.serverId, region: vm.region }, "folder-removed", tenure)) out.deleted.push(name);
        else {
          this.#keep(label);
          out.declined.push(name);
        }
      });
    }
    // Cached VMs the clouds no longer have (and that no folder names): gone.
    for (const v of [...this.#state.vms]) {
      if (unreachable.has(v.provider) || seen.has(v.label) || found.has(v.label)) continue;
      this.#drop(v.name);
    }
    this.#save();
    return out;
  }

  /** Deletes a VM: always the user's card first, whatever the folder says. */
  async delete(name: string, why: "folder-removed" | "asked" = "asked"): Promise<boolean> {
    const tenure = this.#mustAct();
    const vm = this.#state.vms.find((v) => v.name === name);
    if (!vm) throw new ContractError("not_found", `no cloud computer ${name}`);
    const p = this.#provider(vm.provider);
    const there = (await p.list({ label: vm.label })).find((x) => x.label === vm.label && x.state !== "gone");
    if (!there) {
      this.#drop(name);
      this.#save();
      return true;
    }
    return this.#delete({ name, label: vm.label, provider: vm.provider, serverId: there.serverId, region: there.region }, why, tenure);
  }

  /** Lane H's pairing door, when a device presents a VM's token: the computer it was made for, once, under this main's
   *  tenure, bound to that device. Then the cloud is told to clear what it handed the VM, and the user is asked
   *  whether to make it the main computer, unless its folder said `no`. */
  door(folders: () => readonly CloudFolder[]): CloudPairingDoor {
    return {
      consume: async (token, device) => {
        const tenure = this.#o.authority.tenure();
        if (!this.#o.authority.canAct() || tenure === undefined) return null;
        const name = this.pairing.consume(token, tenure);
        if (!name) return null;
        const vm = this.#state.vms.find((v) => v.name === name);
        if (!vm) return null;
        vm.state = "paired";
        vm.device = device;
        this.#save();
        const p = this.#o.provider(vm.provider);
        if (p?.paired && vm.serverId) {
          await p.paired({ serverId: vm.serverId, label: vm.label, region: vm.region }).catch((e: Error) => this.#o.log?.(`cloud computer ${name}: its user-data wasn't cleared (${e.message})`));
        }
        const folder = folders().find((f) => f.name === name);
        if (folder?.makeMain !== "no" && this.#o.makeMain && (await this.#o.confirm({ kind: "cloud-make-main", name })) && this.#stillMain(tenure)) {
          await this.#o.makeMain(name);
        }
        return { computer: name };
      },
    };
  }

  #adopt(f: CloudFolder, label: string, i: CloudInstance, out: ReconcileResult): CloudVm {
    let vm = this.#state.vms.find((v) => v.label === label);
    const paired = this.#o.isPaired?.(f.name) ?? false;
    if (!vm) {
      vm = {
        name: f.name, folder: f.folder, provider: f.provider, label, serverId: i.serverId, region: i.region, size: i.size ?? f.size,
        ...(i.address ? { address: i.address } : {}), state: paired ? "paired" : "created", createdAt: this.#o.clock.now(),
      };
      this.#state.vms.push(vm);
      out.adopted.push(f.name);
    } else {
      vm.serverId = i.serverId;
      vm.region = i.region;
      if (i.size) vm.size = i.size;
      if (i.address) vm.address = i.address;
      if (vm.state === "creating") vm.state = "created";
      if (paired && vm.state !== "deleting") vm.state = "paired";
    }
    return vm;
  }

  /** `exists`: the cloud has one with the label by now (another main's), adopted on the next pass: never two. */
  async #create(f: CloudFolder, label: string, tenure: string): Promise<"created" | "declined" | "exists"> {
    return this.#one(f.name, async () => {
      const p = this.#provider(f.provider);
      if (!(await this.#o.confirm({ kind: "cloud-create", name: f.name, provider: f.provider, size: f.size, region: f.region, folder: f.folder }))) return "declined";
      this.#guard(tenure);
      if ((await p.list({ label })).some((x) => x.label === label && x.state !== "gone")) return "exists";
      // Written before the provider is asked, with its label, so a crash in between is settled from the cloud.
      const vm: CloudVm = { name: f.name, folder: f.folder, provider: f.provider, label, region: f.region, size: f.size, state: "creating", createdAt: this.#o.clock.now() };
      this.#state.vms.push(vm);
      const token = this.pairing.mint(f.name, tenure);
      this.#save();
      this.#guard(tenure);
      await this.#made(p, vm, () => p.create({ name: f.name, size: f.size, region: f.region, ...(f.image ? { image: f.image } : {}), userData: this.#o.userData({ name: f.name, token }), label }));
      return "created";
    });
  }

  /** Settles a `creating` entry from the provider's answer. When the create throws, the cloud is asked by label at
   *  once: none there drops the entry (a retry may ask again); one there, or no answer, leaves it `creating`, settled
   *  by the next pass's lookup. */
  async #made(p: CloudProviderHandler, vm: CloudVm, create: () => Promise<{ serverId: string; address?: string }>): Promise<void> {
    let made: { serverId: string; address?: string };
    try {
      made = await create();
    } catch (e) {
      const there = await p.list({ label: vm.label }).then((l) => l.some((x) => x.label === vm.label && x.state !== "gone"), () => true);
      if (!there) {
        this.#drop(vm.name);
        this.#save();
      }
      throw e;
    }
    vm.serverId = made.serverId;
    if (made.address) vm.address = made.address;
    vm.state = "created";
    this.#save();
  }

  async #resize(vm: CloudVm, size: string, tenure: string): Promise<boolean> {
    return this.#one(vm.name, async () => {
      if (!(await this.#o.confirm({ kind: "cloud-resize", name: vm.name, provider: vm.provider, from: vm.size, to: size }))) return false;
      this.#guard(tenure);
      await this.#provider(vm.provider).resize({ serverId: vm.serverId!, label: vm.label, region: vm.region, size });
      vm.size = size;
      this.#save();
      return true;
    });
  }

  /** Pair again: the VM is still empty (unpaired) and its token is gone, so it is deleted and made again, with the
   *  user's card. */
  async #repair(f: CloudFolder, vm: CloudVm, why: "token-expired" | "main-changed", tenure: string): Promise<boolean> {
    return this.#one(f.name, async () => {
      const p = this.#provider(f.provider);
      if (!(await this.#o.confirm({ kind: "cloud-repair", name: f.name, provider: f.provider, why }))) return false;
      this.#guard(tenure);
      vm.state = "deleting";
      this.#save();
      await p.delete({ serverId: vm.serverId!, label: vm.label, region: vm.region });
      this.#drop(f.name);
      const fresh: CloudVm = { name: f.name, folder: f.folder, provider: f.provider, label: vm.label, region: f.region, size: f.size, state: "creating", createdAt: this.#o.clock.now() };
      this.#state.vms.push(fresh);
      const token = this.pairing.mint(f.name, tenure);
      this.#save();
      this.#guard(tenure);
      await this.#made(p, fresh, () => p.create({ name: f.name, size: f.size, region: f.region, ...(f.image ? { image: f.image } : {}), userData: this.#o.userData({ name: f.name, token }), label: vm.label }));
      return true;
    });
  }

  async #delete(t: { name: string; label: string; provider: string; serverId: string; region: string }, why: "folder-removed" | "asked", tenure: string): Promise<boolean> {
    return this.#one(t.name, async () => {
      const p = this.#provider(t.provider);
      if (!(await this.#o.confirm({ kind: "cloud-delete", name: t.name, provider: t.provider, why }))) return false;
      this.#guard(tenure);
      const vm = this.#state.vms.find((v) => v.label === t.label);
      if (vm) vm.state = "deleting";
      this.#save();
      this.#guard(tenure);
      await p.delete({ serverId: t.serverId, label: t.label, region: t.region });
      this.#state.vms = this.#state.vms.filter((v) => v.label !== t.label);
      this.#unkeep(t.label);
      this.#save();
      return true;
    });
  }

  /** Still the main under the tenure a change started in: refused otherwise, before anything happens. */
  #guard(tenure: string): void {
    if (!this.#stillMain(tenure)) throw new ContractError("not_main", "this computer lost the main computer's lease; nothing was done");
  }

  #stillMain(tenure: string): boolean {
    return this.#o.authority.canAct() && this.#o.authority.tenure() === tenure;
  }

  #mustAct(): string {
    const tenure = this.#o.authority.tenure();
    if (!this.#o.authority.canAct() || tenure === undefined) throw new ContractError("not_main", "only the main computer changes cloud computers");
    return tenure;
  }

  /** Whether a token was ever minted for `name` in this store (its hash still there, expired or not). */
  #minted(name: string): boolean {
    return this.#state.tokens.some((t) => t.computer === name);
  }

  #keep(label: string): void {
    if (!this.#state.kept.includes(label)) this.#state.kept.push(label);
  }

  #unkeep(label: string): void {
    this.#state.kept = this.#state.kept.filter((l) => l !== label);
  }

  #drop(name: string): void {
    this.#state.vms = this.#state.vms.filter((v) => v.name !== name);
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
    this.#o.store.save(this.#state);
  }
}
