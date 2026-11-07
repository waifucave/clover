// The fencing token on acts between computers (#187's lease contract): each computer carries its lease's token on the
// tree calls, the direct path and the level changes it asks of another, and judges the ones asked of it against its own
// lease. A main whose lease is over, asleep or cut off, can't act through the others; nor can a call without a token
// once the receiver has seen one. Without a lease nothing is carried or judged.
import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LeaseView } from "@waifucave/clover-protocol";
import { LocalHolder } from "../../src/tree/holder";
import { Cluster } from "./cluster-support";

const BOT = { kind: "session", sessionId: "s_alpha", sessionKind: "bot", bot: "alpha" } as const;
const utf8 = (text: string) => ({ encoding: "utf8" as const, text });
const rejection = async (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e);
const code = async (p: Promise<unknown>) => ((await rejection(p)) as { code?: string } | undefined)?.code ?? "ok";

/** A computer's own view of the lease, as lane H's lease reports it. */
class FakeLease {
  #state: LeaseView;
  readonly #fns = new Set<(s: LeaseView) => void>();
  constructor(holder: string, epoch: number) {
    this.#state = { main: holder, holder, scope: "acct_1", epoch, expiresAt: null } as LeaseView;
  }
  state(): LeaseView {
    return this.#state;
  }
  watch(fn: (s: LeaseView) => void) {
    this.#fns.add(fn);
    return () => void this.#fns.delete(fn);
  }
  set(holder: string, epoch: number): void {
    this.#state = { ...this.#state, main: holder, holder, epoch };
    for (const fn of this.#fns) fn(this.#state);
  }
}

let cluster: Cluster;
afterEach(() => cluster?.close());

async function two() {
  cluster = new Cluster();
  const leases = new Map<string, FakeLease>();
  const lease = (name: string) => {
    const l = new FakeLease("d_studio", 3);
    leases.set(name, l);
    return l;
  };
  const studio = await cluster.add("Studio", { lease });
  const laptop = await cluster.add("Laptop1", { lease });
  for (const c of [studio, laptop]) await c.node.registry.setLevel(c.name, "automatic", { via: "terminal" });
  await cluster.join();
  return { studio, laptop, leases };
}

describe("the fencing token", () => {
  test("acts under the current lease go through; a main whose lease is over is refused at every door", async () => {
    const { studio, leases } = await two();
    const t = studio.node.tree;
    await t.write("home/Laptop1/a.txt", utf8("a"), { as: BOT });
    writeFileSync(join(studio.home, "b.txt"), "b");
    await t.copy("home/Studio/b.txt", "home/Laptop1/b.txt", { as: BOT });
    // Laptop1 took over (epoch 4) while Studio slept: Studio still carries epoch 3.
    leases.get("Laptop1")!.set("d_laptop", 4);
    const stale = await rejection(t.write("home/Laptop1/c.txt", utf8("c"), { as: BOT }));
    expect(stale).toMatchObject({ code: "not_main", detail: { fence: "stale" } });
    expect(await code(t.read("home/Laptop1/a.txt", { as: BOT }))).toBe("not_main");
    writeFileSync(join(studio.home, "d.txt"), "d");
    expect(await code(t.copy("home/Studio/d.txt", "home/Laptop1/d.txt", { as: BOT }))).toBe("not_main");
    expect(await code(studio.node.registry.setLevel("Laptop1", "read-only", { via: "terminal" }))).toBe("not_main");
    const bash = await studio.node.tools.run("Bash", { command: "echo hi" }, { session: "s_alpha", sessionKind: "bot", bot: "alpha", callId: "c1", cwd: "home/Laptop1" });
    expect(bash).toMatchObject({ isError: true, output: { error: "not_main" } });
    // Studio's lease catches up: its acts go through again.
    leases.get("Studio")!.set("d_laptop", 4);
    await t.write("home/Laptop1/c.txt", utf8("c"), { as: BOT });
  });

  test("once a computer has seen a token for its scope, a call without one is refused", async () => {
    const { studio, laptop } = await two();
    await studio.node.tree.write("home/Laptop1/a.txt", utf8("a"), { as: BOT });
    const link = await cluster.net.endpoint(studio.device).connect(laptop.device);
    const bare = await rejection(link.request("tree.stat", { path: "home/Laptop1/a.txt" }));
    expect(bare).toMatchObject({ code: "not_main", detail: { fence: "missing" } });
    const judged = await rejection(link.request("tree.judge", { from: "home/Studio/x", to: "home/Laptop1/x", move: false, role: "destination", level: "automatic" }));
    expect(judged).toMatchObject({ code: "not_main" });
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
