// Several computers in one test, joined by lane B's fake link (plan §3): each its own `startComputerNode` on its own
// temp home and Clover home, with a FakeFence over its real paths and a plain Bash executor (tests only: the daemon's
// executor is the runtime's sandboxed Bash).
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AnswerDevices, AnswerLedger, CallCardRenderer } from "../../src/contracts/approval-broker";
import type { DeviceRegistry } from "../../src/contracts/device-registry";
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
function posixFence(f: Pick<Fence, "check">): Pick<Fence, "check"> {
  return { check: (op: FenceOp) => f.check(op.op === "move" ? { ...op, path: posix(op.path), to: posix(op.to) } : { ...op, path: posix(op.path) }) };
}

export interface ClusterOptions {
  devices?: (name: string) => DeviceRegistry | undefined;
  answers?: (name: string) => { devices: AnswerDevices; ledger: AnswerLedger; render: CallCardRenderer } | undefined;
  deviceIds?: Record<string, string>;
}

export class Cluster {
  readonly net = new FakeLinkNetwork();
  readonly computers = new Map<string, TestComputer>();
  // The native realpath, as the holder's: on Windows it gives long names where the JS one keeps `RUNNER~1`.
  readonly #root = realpathSync.native(mkdtempSync(join(tmpdir(), "lane-j-cluster-")));

  add(name: string, opts: ClusterOptions = {}): TestComputer {
    const device = opts.deviceIds?.[name] ?? `${name.toLowerCase().replace(/[^a-z0-9]/g, "")}0000000000000000`.slice(0, 20);
    const home = join(this.#root, name, "home");
    const cloverHome = join(home, ".clover");
    mkdirSync(cloverHome, { recursive: true });
    const bots: string[] = [];
    const devices = opts.devices?.(name);
    const answers = opts.answers?.(name);
    const node = startComputerNode({
      clock: { now: () => Date.now() },
      transport: this.net.endpoint(device),
      self: { name, device, os: hostOs() },
      home,
      cloverHome,
      fence: posixFence(new FakeFence({ os: hostOs(), home: posix(home), cloverHome: posix(cloverHome) })),
      executor: shellExecutor,
      bots: () => bots,
      ...(devices ? { devices } : {}),
      ...(answers ? { answers } : {}),
    });
    const c: TestComputer = { name, device, home, cloverHome, node, bots };
    this.computers.set(name, c);
    return c;
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
