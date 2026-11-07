// The fencing token on acts between computers (#187's lease contract, #237's review): each computer carries its view of
// the group's lease on every act it asks of another (tree calls, the direct path, tool calls, terminals, holds, Mirror,
// level changes) and judges the ones asked of it against its own lease. A computer whose view is behind (a main that
// lost its lease asleep) can't act through the others, at any door; nor can a call without a token, restart or not.
// `lease: null` (no group yet) carries and judges nothing, and says so once.
import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LeaseView } from "@waifucave/clover-protocol";
import { fencingTokenOf, type Lease } from "../../src/contracts/lease";
import { startComputerNode } from "../../src/computers/node";
import { LocalHolder } from "../../src/tree/holder";
import { Cluster } from "./cluster-support";

const BOT = { kind: "session", sessionId: "s_alpha", sessionKind: "bot", bot: "alpha" } as const;
const utf8 = (text: string) => ({ encoding: "utf8" as const, text });
const rejection = async (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e);
const code = async (p: Promise<unknown>) => ((await rejection(p)) as { code?: string } | undefined)?.code ?? "ok";

/** A computer's own view of the group's lease, as lane H's lease reports it. */
class FakeLease implements Lease {
  readonly self: string;
  #state: LeaseView;
  readonly #fns = new Set<(s: LeaseView) => void>();
  constructor(self: string, holder: string, epoch: number) {
    this.self = self;
    this.#state = { main: holder, holder, scope: "acct_1", epoch, expiresAt: null } as LeaseView;
  }
  state(): LeaseView {
    return this.#state;
  }
  canAct(): boolean {
    return this.#state.holder === this.self;
  }
  async acquire(): Promise<LeaseView> {
    return this.#state;
  }
  async renew(): Promise<LeaseView> {
    return this.#state;
  }
  async release(): Promise<void> {}
  wake(): void {}
  watch(fn: (s: LeaseView) => void) {
    this.#fns.add(fn);
    return () => void this.#fns.delete(fn);
  }
  set(holder: string | null, epoch: number): void {
    this.#state = { ...this.#state, main: holder, holder, epoch };
    for (const fn of this.#fns) fn(this.#state);
  }
}

let cluster: Cluster;
afterEach(() => cluster?.close());

/** A launcher that must never run: a refused terminal never starts a shell. */
const noShell = () => ({ launch: () => { throw new Error("a shell was started"); } });

async function two() {
  cluster = new Cluster();
  const leases = new Map<string, FakeLease>();
  const lease = (name: string) => {
    const l = new FakeLease(`d_${name}`, "d_Studio", 3);
    leases.set(name, l);
    return l;
  };
  const installed: string[] = [];
  const mcp = (name: string) => ({
    placement: () => undefined, fields: () => ({}), call: async () => ({ content: [] }), scratch: () => `home/${name}`,
    install: async (server: string) => { installed.push(`${name} ${server}`); },
  });
  const studio = await cluster.add("Studio", { lease, terminals: noShell, mcp });
  const laptop = await cluster.add("Laptop1", { lease, terminals: noShell, mcp });
  for (const c of [studio, laptop]) await c.node.registry.setLevel(c.name, "automatic", { via: "terminal" });
  await cluster.join();
  return { studio, laptop, leases, installed };
}

describe("the fencing token", () => {
  test("acts under the current lease go through; a computer whose view is behind is refused at every door", async () => {
    const { studio, laptop, leases, installed } = await two();
    const t = studio.node.tree;
    await t.write("home/Laptop1/a.txt", utf8("a"), { as: BOT });
    writeFileSync(join(studio.home, "b.txt"), "b");
    await t.copy("home/Studio/b.txt", "home/Laptop1/b.txt", { as: BOT });
    const hold = await studio.node.holds.takeHold({ computer: "Laptop1", target: { kind: "app", app: "com.example.app" }, pluginId: "clover/shell", session: "s_alpha" });
    await studio.node.holds.releaseHold(hold.id, { pluginId: "clover/shell", session: "s_alpha" });
    // Laptop1 took over (epoch 4) while Studio slept: Studio still carries epoch 3.
    leases.get("Laptop1")!.set("d_Laptop1", 4);
    const stale = await rejection(t.write("home/Laptop1/c.txt", utf8("c"), { as: BOT }));
    expect(stale).toMatchObject({ code: "not_main", detail: { fence: "stale" } });
    expect(await code(t.read("home/Laptop1/a.txt", { as: BOT }))).toBe("not_main");
    writeFileSync(join(studio.home, "d.txt"), "d");
    expect(await code(t.copy("home/Studio/d.txt", "home/Laptop1/d.txt", { as: BOT }))).toBe("not_main");
    expect(await code(studio.node.registry.setLevel("Laptop1", "read-only", { via: "terminal" }))).toBe("not_main");
    const bash = await studio.node.tools.run("Bash", { command: "echo hi" }, { session: "s_alpha", sessionKind: "bot", bot: "alpha", callId: "c1", cwd: "home/Laptop1" });
    expect(bash).toMatchObject({ isError: true, output: { error: "not_main" } });
    // A shell: neither opened nor typed into, resized or closed.
    expect(await code(studio.node.terminals.open({ computer: "Laptop1", cols: 80, rows: 24 }))).toBe("not_main");
    const link = await cluster.net.endpoint(studio.device).connect(laptop.device);
    const fence = fencingTokenOf(leases.get("Studio")!.state())!;
    const terminalId = "t_0123456789abcdef";
    for (const [method, params] of [
      ["terminal.write", { terminalId, data: "rm -rf ~\n" }],
      ["terminal.resize", { terminalId, cols: 80, rows: 24 }],
      ["terminal.close", { terminalId }],
      ["terminal.closeSession", { session: "s_alpha" }],
      ["computer.releaseHold", { id: "h_1" }],
      ["computer.releaseSession", { session: "s_alpha" }],
      ["computer.holds", {}],
      ["tree.sent", { sendId: "x" }],
    ] as const) {
      expect([method, await code(link.request(method, { ...params, fence }))]).toEqual([method, "not_main"]);
    }
    // A hold, and a Mirror install.
    expect(await code(studio.node.holds.takeHold({ computer: "Laptop1", target: { kind: "app", app: "com.example.app" }, pluginId: "clover/shell" }))).toBe("not_main");
    const mirrored = await studio.node.mirror("blender", { command: "blender-mcp" }, ["Laptop1"]);
    expect(mirrored.failed).toMatchObject([{ computer: "Laptop1", code: "not_main" }]);
    expect(installed).toEqual([]);
    // Studio's view catches up: its acts go through again.
    leases.get("Studio")!.set("d_Laptop1", 4);
    await t.write("home/Laptop1/c.txt", utf8("c"), { as: BOT });
  });

  test("a receiver whose lease has a holder refuses an act without a token, even right after a restart", async () => {
    const { studio, laptop } = await two();
    // Nothing has been asked of Laptop1 yet: it has seen no token, and still refuses a call without one.
    const link = await cluster.net.endpoint(studio.device).connect(laptop.device);
    const bare = await rejection(link.request("tree.stat", { path: "home/Laptop1/a.txt" }));
    expect(bare).toMatchObject({ code: "not_main", detail: { fence: "missing" } });
    expect(await code(link.request("tree.judge", { from: "home/Studio/x", to: "home/Laptop1/x", move: false, role: "destination", level: "automatic" }))).toBe("not_main");
    expect(await code(link.request("terminal.open", { cwd: "home/Laptop1", cols: 80, rows: 24, level: "automatic" }))).toBe("not_main");
    expect(await code(link.request("computer.takeHold", { target: { kind: "app", app: "com.example.app" }, pluginId: "clover/shell" }))).toBe("not_main");
    expect(await code(link.request("mcp.mirror", { server: "blender", config: null, level: "automatic" }))).toBe("not_main");
  });
});

describe("a lapsed lease", () => {
  test("with nobody main, nobody acts: the old holder's token for the lapsed epoch is refused", async () => {
    const { studio, leases } = await two();
    await studio.node.tree.write("home/Laptop1/a.txt", utf8("a"), { as: BOT });
    // Laptop1's own records say the lease lapsed: no holder, same epoch.
    leases.get("Laptop1")!.set(null, 3);
    const lapsed = await rejection(studio.node.tree.read("home/Laptop1/a.txt", { as: BOT }));
    expect(lapsed).toMatchObject({ code: "not_main", detail: { fence: "lapsed" } });
    expect(await code(studio.node.terminals.open({ computer: "Laptop1", cols: 80, rows: 24 }))).toBe("not_main");
    // Someone takes it again; Studio's view catches up; acts go through.
    leases.get("Laptop1")!.set("d_Studio", 4);
    leases.get("Studio")!.set("d_Studio", 4);
    expect(await studio.node.tree.read("home/Laptop1/a.txt", { as: BOT })).toEqual(utf8("a"));
  });
});

describe("lease: null", () => {
  test("is required, says there is no group yet, once, and then nothing is carried or judged", async () => {
    cluster = new Cluster();
    const studio = await cluster.add("Studio");
    const laptop = await cluster.add("Laptop1");
    await laptop.node.registry.setLevel("Laptop1", "automatic", { via: "terminal" });
    await cluster.join();
    await studio.node.tree.write("home/Laptop1/a.txt", utf8("a"), { as: BOT });
    const link = await cluster.net.endpoint(studio.device).connect(laptop.device);
    expect(await code(link.request("tree.stat", { path: "home/Laptop1/a.txt" }))).toBe("ok");
    // The log line, once, at start.
    const lines: string[] = [];
    const node = startComputerNode({
      clock: { now: () => Date.now() }, transport: cluster.net.endpoint("d_lonely"), self: { name: "Lonely", device: "d_lonely" },
      home: studio.home, cloverHome: studio.cloverHome, devices: { list: () => [], get: () => undefined, watch: () => () => {} } as never,
      lease: null, log: (l) => lines.push(l),
    });
    node.close();
    expect(lines.filter((l) => l.includes("no lease yet"))).toHaveLength(1);
  });
});

describe("Windows' aliases (lane B's rule)", () => {
  test("a short 8.3 name is refused wherever it is, for every caller", async () => {
    const h = new LocalHolder({ clock: { now: () => Date.now() }, name: () => "Studio", home: "/nonexistent-home", os: "windows" });
    for (const as of [BOT, { kind: "user", client: "app" } as const]) {
      expect(await code(h.stat("home/Studio/CLOVER~1/settings.json", { as }))).toBe("refused");
      expect(await code(h.write("home/Studio/PROGRA~1/x.txt", utf8("x"), { as }))).toBe("refused");
    }
  });
});
