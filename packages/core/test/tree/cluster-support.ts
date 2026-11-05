// Several computers in one test, joined by lane B's fake link (plan §3): each its own `startComputerNode` on its own
// temp home and Clover home, with a FakeFence over its real paths, a device list pairing it with the others (lane B's
// fake, keys in memory) and a plain Bash executor (tests only: the daemon's executor is the runtime's sandboxed Bash).
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AnswerDevices, AnswerLedger, CallCardRenderer } from "../../src/contracts/approval-broker";
import type { Unsubscribe } from "../../src/contracts/common";
import type { DeviceChange, DeviceRecord, DeviceRegistry } from "../../src/contracts/device-registry";
import { FakeDeviceRegistry } from "../../src/contracts/fakes/device-registry";
import type { Fence, FenceOp } from "../../src/contracts/fence";
import { FakeFence } from "../../src/contracts/fakes/fence";
import { FakeLinkNetwork } from "../../src/contracts/fakes/link-transport";
import { startComputerNode, type ComputerNode } from "../../src/computers/node";
import { hostOs } from "../../src/tree/names";
import type { ToolExecutor } from "../../src/tree/service";

export interface TestComputer {
  name: string;
  device: string;
  /** The home folder's real path: `home/<name>/`. */
  home: string;
  cloverHome: string;
  node: ComputerNode;
  bots: string[];
}

/** A plain shell, for tests: the command in `cwd`, its output streamed, killed on abort. */
export const shellExecutor: ToolExecutor = {
  async run(_tool, input, ctx) {
    const { command } = input as { command: string };
    const shell = process.platform === "win32" ? ["cmd.exe", "/d", "/s", "/c", command] : ["/bin/sh", "-c", command];
    const proc = Bun.spawn(shell, { cwd: ctx.cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { PATH: process.env.PATH ?? "", HOME: ctx.cwd } });
    const onAbort = () => proc.kill();
    ctx.signal.addEventListener("abort", onAbort, { once: true });
    const pump = async (s: ReadableStream<Uint8Array>, stream: "stdout" | "stderr", into: string[]) => {
      const dec = new TextDecoder();
      for await (const chunk of s) {
        const text = dec.decode(chunk, { stream: true });
        into.push(text);
        ctx.output(text, stream);
      }
    };
    const out: string[] = [];
    const err: string[] = [];
    // A killed shell can leave its child holding the pipes (dash doesn't exec the last command), so a cancelled call
    // answers once the shell is gone rather than when the pipes close.
    const done = Promise.all([pump(proc.stdout, "stdout", out), pump(proc.stderr, "stderr", err), proc.exited]);
    const cancelled = new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve(), { once: true }));
    await Promise.race([done, cancelled.then(() => proc.exited)]);
    ctx.signal.removeEventListener("abort", onAbort);
    const code = proc.exitCode;
    return { output: { stdout: out.join(""), stderr: err.join(""), code, aborted: ctx.signal.aborted }, isError: code !== 0 };
  },
};

/** The fake fence speaks POSIX paths; on Windows the holder's are `C:\\…`, so both sides meet as `C:/…`. */
const posix = (p: string) => p.replace(/\\/g, "/");
function posixFence(f: Pick<Fence, "check" | "fencedSet">): Pick<Fence, "check" | "fencedSet"> {
  return {
    check: (op: FenceOp) => f.check(op.op === "move" ? { ...op, path: posix(op.path), to: posix(op.to) } : { ...op, path: posix(op.path) }),
    fencedSet: () => f.fencedSet(),
  };
}

/** A computer's device list in tests: lane B's fake, plus a way to change a computer's tree name as lane H's list
 *  would after a rename (the fake renames only the device). */
export class ClusterDevices implements DeviceRegistry {
  readonly inner: FakeDeviceRegistry;
  readonly #computerNames = new Map<string, string>();
  readonly #listeners = new Set<(change: DeviceChange) => void>();

  constructor(inner: FakeDeviceRegistry) {
    this.inner = inner;
  }

  #patch(d: DeviceRecord): DeviceRecord {
    const name = this.#computerNames.get(d.id);
    return name === undefined ? d : { ...d, computer: name };
  }

  self(): DeviceRecord { return this.#patch(this.inner.self()); }
  list(): DeviceRecord[] { return this.inner.list().map((d) => this.#patch(d)); }
  get(id: string): DeviceRecord | undefined {
    const d = this.inner.get(id);
    return d && this.#patch(d);
  }
  add(device: Parameters<DeviceRegistry["add"]>[0], proof: Parameters<DeviceRegistry["add"]>[1]): Promise<DeviceRecord> { return this.inner.add(device, proof); }
  revoke(id: string, reason?: string): Promise<void> { return this.inner.revoke(id, reason); }
  rename(id: string, name: string): Promise<void> { return this.inner.rename(id, name); }
  verify(id: string, data: Uint8Array, signature: Uint8Array): Promise<boolean> { return this.inner.verify(id, data, signature); }
  verifyAnswer(id: string, data: Uint8Array, signature: Uint8Array): Promise<boolean> { return this.inner.verifyAnswer(id, data, signature); }
  watch(fn: (change: DeviceChange) => void): Unsubscribe {
    const off = this.inner.watch((c) => fn(c.type === "revoked" ? c : { ...c, device: this.#patch(c.device) }));
    this.#listeners.add(fn);
    return () => {
      off();
      this.#listeners.delete(fn);
    };
  }

  /** The computer on device `id` is now called `name` in the tree. */
  setComputer(id: string, name: string): void {
    this.#computerNames.set(id, name);
    const d = this.get(id);
    if (d) for (const fn of this.#listeners) fn({ type: "changed", device: d });
  }
}

export interface ClusterOptions {
  /** A device list of the test's own, with the device ids it gives (`deviceIds`). */
  devices?: (name: string) => DeviceRegistry | undefined;
  answers?: (name: string) => { devices: AnswerDevices; ledger: AnswerLedger; render: CallCardRenderer } | undefined;
  deviceIds?: Record<string, string>;
}

export class Cluster {
  readonly net = new FakeLinkNetwork();
  readonly computers = new Map<string, TestComputer>();
  // The native realpath, as the holder's: on Windows it gives long names where the JS one keeps `RUNNER~1`.
  readonly #root = realpathSync.native(mkdtempSync(join(tmpdir(), "lane-j-cluster-")));
  readonly #keys = new Map<string, { publicKey: string; devices: ClusterDevices }>();

  /** A computer on its own temp home, paired with every computer already here (each a desktop that runs the core),
   *  unless the test brings its own device list. */
  async add(name: string, opts: ClusterOptions = {}): Promise<TestComputer> {
    const clock = { now: () => Date.now() };
    const custom = opts.devices?.(name);
    let device: string;
    let devices: DeviceRegistry;
    if (custom) {
      device = opts.deviceIds?.[name] ?? custom.self().id;
      devices = custom;
    } else {
      const made = await FakeDeviceRegistry.create({ clock, name, computer: name, os: hostOs() });
      const mine = new ClusterDevices(made.registry);
      device = made.device.id;
      devices = mine;
      for (const [otherDevice, other] of this.#keys) {
        const peer = [...this.computers.values()].find((c) => c.device === otherDevice)!;
        await other.devices.add({ id: device, name, kind: "desktop", runsCore: true, computer: name, publicKey: made.device.publicKey }, { via: "terminal" });
        await mine.add({ id: otherDevice, name: peer.name, kind: "desktop", runsCore: true, computer: peer.name, publicKey: other.publicKey }, { via: "terminal" });
      }
      this.#keys.set(device, { publicKey: made.device.publicKey, devices: mine });
    }
    const home = join(this.#root, name, "home");
    const cloverHome = join(home, ".clover");
    mkdirSync(cloverHome, { recursive: true });
    const bots: string[] = [];
    const answers = opts.answers?.(name);
    const node = startComputerNode({
      clock,
      transport: this.net.endpoint(device),
      self: { name, device, os: hostOs() },
      home,
      cloverHome,
      fence: posixFence(new FakeFence({ os: hostOs(), home: posix(home), cloverHome: posix(cloverHome) })),
      executor: shellExecutor,
      bots: () => bots,
      devices,
      ...(answers ? { answers } : {}),
    });
    const c: TestComputer = { name, device, home, cloverHome, node, bots };
    this.computers.set(name, c);
    return c;
  }

  /** What lane H's device list does after a rename: every computer's list names the computer anew. */
  renameComputer(device: string, name: string): void {
    for (const k of this.#keys.values()) k.devices.setComputer(device, name);
  }

  get(name: string): TestComputer {
    const c = this.computers.get(name);
    if (!c) throw new Error(`no computer ${name}`);
    return c;
  }

  /** Brings up the link between every pair and waits until each side has the other's hello. */
  async join(): Promise<void> {
    const all = [...this.computers.values()];
    const waits: Promise<void>[] = [];
    for (const a of all) {
      for (const b of all) {
        if (a === b) continue;
        waits.push(helloFrom(a, b.device));
      }
    }
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) await this.net.endpoint(all[i]!.device).connect(all[j]!.device);
    }
    await Promise.all(waits);
  }

  close(): void {
    for (const c of this.computers.values()) c.node.close();
  }
}

/** Resolves once `c` has a hello from `device`. */
export function helloFrom(c: TestComputer, device: string): Promise<void> {
  return new Promise((resolve) => {
    if (c.node.peers.roots(device)) return resolve();
    const off = c.node.peers.onHello((d) => {
      if (d !== device) return;
      off();
      resolve();
    });
  });
}

/** Waits until `check` holds, or fails after `ms`. */
export async function until(check: () => boolean | Promise<boolean>, ms = 3000, what = "the condition"): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}
