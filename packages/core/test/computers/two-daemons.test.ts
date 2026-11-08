// J-M3's "done when" (plan §4 J): a bot works across two daemons as one tree, on lane H's real links. Each daemon has
// its own temp home, its own device key and secret store, and pairs with the other the way the user does (lane H's
// pairing, confirmed in the terminal); the computer node takes its transport, device list and tree name from the
// links (`computerNodeLinks`). The wire is H's in-memory network, so the test runs the same on all three OSes in CI;
// the real sidecar is H's own suite. C-M2's real fence joins here once it lands.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SystemClock } from "../../src/clock/system-clock";
import { MemorySecretStore } from "../../src/contracts/fakes/secret-store";
import { startComputerNode, type ComputerNode } from "../../src/computers/node";
import { MemoryNetwork } from "../../src/links/memory-wire";
import { computerNodeLinks, startDeviceLinks, type DeviceLinks } from "../../src/links/node";
import { hostOs } from "../../src/tree/names";
import { shellExecutor, until } from "../tree/cluster-support";

const clock = new SystemClock();
const BOT = { kind: "session", sessionId: "s_alpha", sessionKind: "bot", bot: "alpha" } as const;
const utf8 = (text: string) => ({ encoding: "utf8" as const, text });

let stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.reverse()) await s();
  stops = [];
});

async function daemon(net: MemoryNetwork, name: string, bots: string[] = []) {
  const root = mkdtempSync(join(tmpdir(), "lane-j-daemon-"));
  const home = join(root, "home");
  const cloverHome = join(home, ".clover");
  mkdirSync(cloverHome, { recursive: true });
  const links = await startDeviceLinks({ home: cloverHome, store: new MemorySecretStore(), clock, self: { name, os: hostOs() }, wire: (key) => net.endpoint(key.publicKey) });
  stops.push(() => links.close());
  return { name, home, cloverHome, links, bots };
}

function node(d: Awaited<ReturnType<typeof daemon>>): ComputerNode {
  const handoff = computerNodeLinks(d.links);
  const n = startComputerNode({
    clock, ...handoff, home: d.home, cloverHome: d.cloverHome, executor: shellExecutor, bots: () => d.bots, lease: null,
  });
  stops.push(() => n.close());
  return n;
}

async function pair(a: DeviceLinks, b: DeviceLinks) {
  const view = await a.pairing.begin();
  const joined = await b.pairing.join(view.qr!);
  await until(() => a.pairing.get(view.pairingId)?.status === "words", 5000, "the pairing's words");
  await Promise.all([a.pairing.confirm(view.pairingId, joined.words!, { terminal: true }), b.pairing.confirm(view.pairingId, joined.words!, { terminal: true })]);
  await until(() => a.registry.get(b.key.id) !== undefined && b.registry.get(a.key.id) !== undefined, 5000, "both device lists");
}

describe("two daemons, one tree (J-M3's done when)", () => {
  test("a bot on one daemon reads, writes, copies and runs Bash on the other's files, on real links", async () => {
    const net = new MemoryNetwork();
    const studio = await daemon(net, "Studio", ["alpha"]);
    const laptop = await daemon(net, "Laptop");
    await pair(studio.links, laptop.links);
    const s = node(studio);
    const l = node(laptop);
    // Each sees the other in the tree once their hellos cross.
    await until(() => s.registry.get("Laptop")?.state === "online" && l.registry.get("Studio")?.state === "online", 5000, "the hellos");
    // The user lets bots act on both computers without asking (levels per computer; the stricter of the two judges a
    // move or copy between them).
    await l.registry.setLevel("Laptop", "automatic", { via: "terminal" });
    await s.registry.setLevel("Studio", "automatic", { via: "terminal" });
    await until(() => s.registry.get("Laptop")?.level === "automatic" && l.registry.get("Studio")?.level === "automatic", 5000, "the levels");

    // Write and read on the other computer, through its holder.
    await s.tree.write("home/Laptop/notes/plan.md", utf8("# Plan\n"), { as: BOT });
    expect(readFileSync(join(laptop.home, "notes", "plan.md"), "utf8")).toBe("# Plan\n");
    expect(await s.tree.read("home/Laptop/notes/plan.md", { as: BOT })).toEqual(utf8("# Plan\n"));
    expect((await s.tree.list("home/Laptop/notes", { as: BOT })).map((e) => e.path)).toEqual(["home/Laptop/notes/plan.md"]);
    // The direct path: a copy from Studio straight into Laptop's folder.
    writeFileSync(join(studio.home, "draft.md"), "draft");
    await s.tree.copy("home/Studio/draft.md", "home/Laptop/notes/draft.md", { as: BOT });
    expect(readFileSync(join(laptop.home, "notes", "draft.md"), "utf8")).toBe("draft");
    // Bash where the files are: the command runs on Laptop.
    const cmd = process.platform === "win32" ? "type plan.md" : "cat plan.md";
    const r = await s.tools.run("Bash", { command: cmd }, { session: "s_alpha", sessionKind: "bot", bot: "alpha", callId: "c1", cwd: "home/Laptop/notes" });
    expect(r.isError).toBe(false);
    expect(r.computer).toBe("Laptop");
    expect(JSON.stringify(r.output)).toContain("# Plan");
    // And the bot's own folder lives on the computer that runs it.
    expect(s.tree.resolve("bots/alpha/notes/x.md").computer).toBe("Studio");
    expect(l.tree.resolve("bots/alpha/notes/x.md").computer).toBe("Studio");
  });
});
