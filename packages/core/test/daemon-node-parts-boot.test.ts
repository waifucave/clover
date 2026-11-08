// The computer node's own parts on a real daemon in a temp home (lane J's `nodeParts`, the controller's wiring ruling):
// a bot's terminal works, and a paste of several lines is never dropped silently (refused with a reason before the
// daemon's broker exists, a card through the broker after); and another computer's call at "ask for risky actions"
// runs past the daemon's safety reviewer, which fails closed.
//
// Fakes only where each part's own lane uses them: H's in-memory network and local handshake, D's plugin registry and
// session drivers, and the reviewer and broker seams (`parts.reviewer`, `parts.approvals`). The second computer is
// built from the same assembly the daemon uses (`startDaemonLinks`, `startDaemonParts`).
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSecretStore } from "../src/auth/secret-store";
import { botManifest, Drivers, pluginFromFolder, writePlugin } from "../src/bots/tests/fixtures";
import { catalogPointDecl } from "../../plugin-sdk/src/catalogs/index";
import { SystemClock } from "../src/clock/system-clock";
import type { ReviewInput } from "../src/agent/reviewer";
import type { ApprovalRequest } from "../src/contracts/approval-broker";
import { FakePluginRegistry } from "../src/contracts/fakes/plugin-registry";
import { startDaemon, type RunningDaemon } from "../src/daemon";
import { startDaemonParts, type DaemonBotsInput, type DaemonParts } from "../src/daemon-parts";
import { startDaemonLinks, type DaemonLinks } from "../src/ipc/device-links";
import { cloverCall } from "../src/ipc/clover-client";
import { HandshakeClient } from "../src/links/handshake";
import { startFakeHandshake } from "../src/links/handshake-fake";
import { MemoryNetwork } from "../src/links/memory-wire";
import type { DeviceLinks } from "../src/links/node";
import { CloverSecretStore, KeychainValues, memoryVault } from "../src/secrets/clover-secret-store";
import { mainSessionIdFor } from "../src/sessions/ids";
import { PASTE_CANT_ASK } from "../src/tree/terminals";

const clock = new SystemClock();
const posix = process.platform !== "win32";
let stops: Array<() => unknown> = [];
let daemon: RunningDaemon | undefined;
afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
  for (const s of stops.reverse()) await s();
  stops = [];
});

const temp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));

async function waitFor(what: string, cond: () => boolean, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(20);
  }
}

async function fakeBots(): Promise<DaemonBotsInput & { fakes: Drivers }> {
  const root = temp("clover-int-plugins-");
  const luna = writePlugin(root, "luna", { "clover.json": botManifest("luna", "Luna"), "bot/instructions.md": "You are Luna." });
  const registry = new FakePluginRegistry({ catalog: catalogPointDecl, plugins: (await pluginFromFolder(luna)).inputs });
  const fakes = new Drivers();
  return { registry, drivers: () => fakes.factory, defaultModel: () => ({ model: "winter-test/calls" }), fakes };
}

const mainComputer = { watchSleep: false, monotonic: () => performance.now() };

/** A shell that says it is ready and echoes what it is sent. */
const echoShell = { launch: () => ({ cmd: ["/bin/sh", "-c", "printf 'ready\\n'; exec cat"], env: { PATH: process.env.PATH ?? "/usr/bin:/bin", TERM: "xterm" } }) };

async function boot(o: { approvals?: { request(r: ApprovalRequest): Promise<{ allowed: boolean }> }; review?: (i: ReviewInput) => Promise<{ verdict: "safe" | "unsafe"; reason: string }>; net?: MemoryNetwork; hs?: { url: string } } = {}) {
  const net = o.net ?? new MemoryNetwork();
  const home = temp("clover-int-home-");
  const userHome = temp("clover-int-user-");
  daemon = await startDaemon({
    home, secrets: new FileSecretStore(join(home, "secrets.json")), agentProvider: null, pair: false,
    links: {
      wire: (k) => net.endpoint(k.publicKey), handshake: o.hs ? new HandshakeClient({ baseUrl: o.hs.url, clock }) : null, publicTime: null,
      mainComputer, watch: () => () => {}, self: { name: "Studio", os: "macos" },
    },
    parts: {
      userHome, bots: await fakeBots(), node: { terminals: echoShell },
      ...(o.review ? { reviewer: { review: o.review } } : {}),
      ...(o.approvals ? { approvals: o.approvals as never } : {}),
    },
  });
  await daemon.cloverParts.ready;
  return { node: daemon.cloverParts.node()!, links: daemon.cloverParts.links()!, userHome, net };
}

const LUNA = { kind: "session", sessionId: mainSessionIdFor("luna"), sessionKind: "bot", bot: "luna" } as const;

describe("a bot's terminal on a real daemon", () => {
  test("opens and runs; a paste of several lines is refused with a reason while there's no broker, never dropped silently", async () => {
    if (!posix || typeof Bun.Terminal !== "function") return;
    const { node } = await boot();
    let seen = "";
    node.terminals.onOutput((out) => { seen += out.data; });
    const t = await node.terminals.open({ computer: "Studio", cols: 80, rows: 24, session: LUNA.sessionId }, LUNA);
    await waitFor("the shell", () => seen.includes("ready"));
    await node.terminals.write(t.terminalId, "hello from luna\n");
    await waitFor("the echo", () => seen.includes("hello from luna"));
    const refused = await node.terminals.write(t.terminalId, "one\ntwo\n", { paste: true }).catch((e: Error) => e);
    expect((refused as Error).message).toBe(PASTE_CANT_ASK);
    await node.terminals.close(t.terminalId);
  }, 30_000);

  test("with the broker, the paste raises a confirm card and goes in on the person's yes", async () => {
    if (!posix || typeof Bun.Terminal !== "function") return;
    const asked: ApprovalRequest[] = [];
    const { node } = await boot({ approvals: { request: async (r) => { asked.push(r); return { allowed: true }; } } });
    let seen = "";
    node.terminals.onOutput((out) => { seen += out.data; });
    const t = await node.terminals.open({ computer: "Studio", cols: 80, rows: 24, session: LUNA.sessionId }, LUNA);
    await waitFor("the shell", () => seen.includes("ready"));
    await node.terminals.write(t.terminalId, "first line\nsecond line\n", { paste: true });
    await waitFor("the paste", () => seen.includes("second line"));
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ kind: "confirm", computers: ["Studio"], fields: { command: { type: "list", items: ["first line", "second line"] } } });
    await node.terminals.close(t.terminalId);
  }, 30_000);
});

/** A second computer, from the same assembly the daemon runs. */
async function peer(net: MemoryNetwork, hs: { url: string }, name: string): Promise<{ d: DaemonLinks; parts: DaemonParts; links: DeviceLinks }> {
  const home = temp("clover-int-peer-");
  const store = new CloverSecretStore({ home, values: new KeychainValues(memoryVault()), status: { backend: "memory", plaintext: false, state: "unlocked" } });
  const handlers = {};
  const d = await startDaemonLinks({
    home, store, clock, self: { name, os: "linux" }, handlers, binary: null, wire: (k) => net.endpoint(k.publicKey),
    handshake: new HandshakeClient({ baseUrl: hs.url, clock }), publicTime: null, mainComputer, watch: () => () => {},
    dispatch: async () => null,
  });
  stops.push(() => d.close());
  const parts = await startDaemonParts({ cloverHome: home, userHome: temp("clover-int-user-"), clock, links: d.links, handlers, bots: await fakeBots() });
  stops.push(() => parts.close());
  return { d, parts, links: d.links! };
}

async function pair(a: DeviceLinks, b: DeviceLinks): Promise<void> {
  const view = await a.pairing.begin();
  const joined = await b.pairing.join(view.qr!);
  await waitFor("the words", () => a.pairing.get(view.pairingId)?.status === "words");
  await Promise.all([a.pairing.confirm(view.pairingId, joined.words!, { terminal: true }), b.pairing.confirm(view.pairingId, joined.words!, { terminal: true })]);
  await waitFor("the pair", () => a.registry.pairWith(b.key.id)?.registeredAt !== undefined && b.registry.group() !== undefined);
}

describe("the daemon's safety reviewer for another computer's calls", () => {
  test("a paired computer's write at ask-risky runs past the reviewer; unsafe, or a reviewer that fails, needs the user's answer", async () => {
    const hs = startFakeHandshake();
    stops.push(() => hs.stop());
    const net = new MemoryNetwork();
    const seen: ReviewInput[] = [];
    let next: "safe" | "unsafe" | "fail" = "safe";
    const { links, userHome } = await boot({
      net, hs,
      review: async (i) => {
        seen.push(i);
        if (next === "fail") throw new Error("the reviewer's model timed out");
        return { verdict: next, reason: "test" };
      },
    });
    const laptop = await peer(net, hs, "Laptop");
    await pair(links, laptop.links);
    // The user makes Studio the main computer: the group's lease is held, so the computers act.
    const cli = { role: "cli" as const, token: daemon!.tokens.harness, clientName: "int-test" };
    expect(await cloverCall(daemon!.socketPath, cli, "main.set", { device: links.key.id })).toEqual({ applied: true });
    await waitFor("the laptop seeing the lease", () => laptop.links.main!.lease.state().holder === links.key.id);
    const tree = laptop.parts.node!.tree;
    await waitFor("the laptop's tree naming Studio", () => laptop.parts.node!.registry.get("Studio")?.state === "online");
    const coding = { as: { kind: "session", sessionId: "s_code", sessionKind: "coding" } as const };
    // Studio is at "ask for risky actions" (the default): its reviewer judges the laptop's write.
    await tree.write("home/Studio/from-laptop.md", { encoding: "utf8", text: "hello" }, coding);
    expect(readFileSync(join(userHome, "from-laptop.md"), "utf8")).toBe("hello");
    expect(seen.at(-1)).toMatchObject({ class: "fs", precis: expect.stringContaining("tree.write path: home/Studio/from-laptop.md, 5 characters") });
    expect(JSON.stringify(seen.at(-1))).not.toContain("hello\"");
    // Unsafe: the user's answer is needed, and the laptop can't ask it yet: refused, nothing written.
    next = "unsafe";
    const unsafe = await tree.write("home/Studio/risky.md", { encoding: "utf8", text: "x" }, coding).catch((e: { code?: string; detail?: { needsAnswer?: boolean } }) => e);
    expect(unsafe).toMatchObject({ code: "refused" });
    expect(existsSync(join(userHome, "risky.md"))).toBe(false);
    // A reviewer that fails: closed, the same.
    next = "fail";
    const failed = await tree.write("home/Studio/failed.md", { encoding: "utf8", text: "x" }, coding).catch((e: { code?: string }) => e);
    expect(failed).toMatchObject({ code: "refused" });
    expect(existsSync(join(userHome, "failed.md"))).toBe(false);
    expect(seen).toHaveLength(3);
  }, 60_000);
});
