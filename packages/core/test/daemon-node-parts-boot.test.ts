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
import { CLOVER_PROTOCOL_VERSION, ConnWriter, encodeLine, LineDecoder, METHODS, type WritableSocket } from "@waifucave/clover-protocol";
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
  return { registry, drivers: () => fakes.factory, defaultModel: () => ({ model: "clover-test/calls" }), fakes };
}

const mainComputer = { watchSleep: false, monotonic: () => performance.now() };

/** A shell that says it is ready and echoes what it is sent. */
const echoShell = { launch: () => ({ cmd: ["/bin/sh", "-c", "printf 'ready\\n'; exec cat"], env: { PATH: process.env.PATH ?? "/usr/bin:/bin", TERM: "xterm" } }) };

async function boot(o: { pairApp?: boolean; approvals?: { request(r: ApprovalRequest): Promise<{ allowed: boolean }> }; review?: (i: ReviewInput) => Promise<{ verdict: "safe" | "unsafe"; reason: string }>; net?: MemoryNetwork; hs?: { url: string } } = {}) {
  const net = o.net ?? new MemoryNetwork();
  const home = temp("clover-int-home-");
  const userHome = temp("clover-int-user-");
  daemon = await startDaemon({
    home, secrets: new FileSecretStore(join(home, "secrets.json")), agentProvider: null, ...(o.pairApp ? { appPeer: "none" as const } : { pair: false as const }),
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
  return { node: daemon.cloverParts.node()!, links: daemon.cloverParts.links()!, userHome, net, home };
}

const LUNA = { kind: "session", sessionId: mainSessionIdFor("luna"), sessionKind: "bot", bot: "luna" } as const;

describe("a bot's terminal on a real daemon", () => {
  test("opens and runs; a paste of several lines waits on the daemon's own broker's card, never dropped silently", async () => {
    if (!posix || typeof Bun.Terminal !== "function") return;
    const { node } = await boot();
    const broker = daemon!.cloverParts.broker()!;
    let seen = "";
    node.terminals.onOutput((out) => { seen += out.data; });
    const t = await node.terminals.open({ computer: "Studio", cols: 80, rows: 24, session: LUNA.sessionId }, LUNA);
    await waitFor("the shell", () => seen.includes("ready"));
    await node.terminals.write(t.terminalId, "hello from luna\n");
    await waitFor("the echo", () => seen.includes("hello from luna"));
    // The daemon's one broker (INT, #292) asks: a card shows, and the paste waits for it.
    const pasted = node.terminals.write(t.terminalId, "one\ntwo\n", { paste: true }).catch((e: Error) => e);
    await waitFor("the paste's card", () => broker.cards().length === 1);
    let settled = false;
    void pasted.then(() => (settled = true));
    await Bun.sleep(50);
    // Nothing went in while the card is open (a no or a yes is the next test's, with a broker of its own).
    expect(settled).toBe(false);
    expect(seen.includes("two")).toBe(false);
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
    // Unsafe: the user's answer is needed. The laptop asks it (askUser, lane J's #373): Studio's own card, opening with
    // Clover's line naming Studio, raised on the laptop's broker for the asking session. The user interrupts that
    // session (its pending cards are withdrawn): refused, nothing written.
    next = "unsafe";
    const broker = laptop.parts.broker!;
    const unsafe = tree.write("home/Studio/risky.md", { encoding: "utf8", text: "x" }, coding).catch((e: { code?: string; detail?: { needsAnswer?: boolean } }) => e);
    await waitFor("Studio's card on the laptop", () => broker.pending().length > 0);
    const card = broker.get(broker.pending()[0]!.id)?.card;
    expect(card?.fields.title).toEqual({ type: "text", text: "Studio asks you to approve this" });
    expect(card?.binds).toMatchObject({ computer: "Studio", method: "tree.write" });
    expect(broker.withdrawSession("s_code")).toBe(1);
    expect(await unsafe).toMatchObject({ code: "refused" });
    expect(existsSync(join(userHome, "risky.md"))).toBe(false);
    // A reviewer that fails: closed, the same (its card withdrawn the same way).
    next = "fail";
    let settled = false;
    const failing = tree.write("home/Studio/failed.md", { encoding: "utf8", text: "x" }, coding).catch((e: { code?: string }) => e).finally(() => { settled = true; });
    await waitFor("the failed review's refusal, or its card on the laptop", () => settled || broker.pending().length > 0);
    broker.withdrawSession("s_code");
    const failed = await failing;
    expect(failed).toMatchObject({ code: "refused" });
    expect(existsSync(join(userHome, "failed.md"))).toBe(false);
    expect(seen).toHaveLength(3);
  }, 60_000);
});

/** A Clover connection that stays open: requests, and what the daemon sends it unasked (`core.event`). */
async function connection(path: string) {
  const decoder = new LineDecoder();
  const pending = new Map<number, (m: { result?: unknown; error?: { code: number; message: string } }) => void>();
  const events: { type: string; [k: string]: unknown }[] = [];
  let next = 1;
  const socket = await Bun.connect({ unix: path, socket: {
    data(_s, chunk) {
      for (const l of decoder.push(chunk)) {
        const m = JSON.parse(l);
        if (typeof m.id === "number") { pending.get(m.id)?.(m); pending.delete(m.id); } else if (m.method === "core.event") events.push(m.params);
      }
    },
    drain() { writer.onDrain(); },
  } });
  const writer = new ConnWriter(socket as unknown as WritableSocket);
  return {
    events,
    request(method: string, params?: unknown) {
      const id = next++;
      writer.enqueue(encodeLine({ jsonrpc: "2.0", id, method, params }));
      return new Promise<{ result?: any; error?: { code: number; message: string } }>((r) => pending.set(id, r));
    },
    close() { socket.end(); },
  };
}

describe("the app's terminal panel on a real daemon (K's audit)", () => {
  test("terminal.open, write, resize and close for the app, the output to its connection alone, the paste waiting on the broker's card", async () => {
    if (!posix || typeof Bun.Terminal !== "function") return;
    const { node, home } = await boot({ pairApp: true });
    const hello = async () => {
      const c = await connection(daemon!.socketPath);
      const h = await c.request(METHODS.hello, { protocolVersion: CLOVER_PROTOCOL_VERSION, role: "app", token: readFileSync(join(home, "run", "app.token"), "utf8"), clientName: "test-app", features: ["app.quit"] });
      expect(h.error).toBeUndefined();
      expect((await c.request("events.subscribe", { areas: ["computers"] })).result).toEqual({ ok: true });
      return c;
    };
    const app = await hello();
    const other = await hello();
    const output = (c: { events: { type: string; data?: unknown }[] }) => c.events.filter((e) => e.type === "terminal_output").map((e) => String(e.data)).join("");
    const opened = await app.request("terminal.open", { computer: "Studio", cols: 80, rows: 24 });
    expect(opened.error).toBeUndefined();
    const id = (opened.result as { terminalId: string }).terminalId;
    await waitFor("the shell", () => output(app).includes("ready"));
    expect((await app.request("terminal.write", { terminalId: id, data: "typed by the user\n" })).result).toEqual({ ok: true });
    await waitFor("the echo", () => output(app).includes("typed by the user"));
    expect((await app.request("terminal.resize", { terminalId: id, cols: 100, rows: 30 })).result).toEqual({ ok: true });
    // A paste of several lines asks on the daemon's one broker (INT, #292): a card shows, and nothing goes in until
    // it's answered.
    const broker = daemon!.cloverParts.broker()!;
    let pasteSettled = false;
    void app.request("terminal.write", { terminalId: id, data: "one\ntwo\n", paste: true }).then(() => { pasteSettled = true; });
    await waitFor("the paste's card", () => broker.cards().length === 1);
    await Bun.sleep(50);
    expect(pasteSettled).toBe(false);
    expect(output(app).includes("two")).toBe(false);
    // Another connection doesn't see it, can't write to it or close it.
    expect(output(other)).toBe("");
    expect((await other.request("terminal.write", { terminalId: id, data: "x" })).error?.message).toContain(`no terminal ${id}`);
    expect((await other.request("terminal.close", { terminalId: id })).error).toBeDefined();
    expect((await app.request("terminal.close", { terminalId: id })).result).toEqual({ ok: true });
    // The connection's close ends what it opened.
    const second = await app.request("terminal.open", { computer: "Studio", cols: 80, rows: 24 });
    const id2 = (second.result as { terminalId: string }).terminalId;
    await waitFor("the second shell", () => node.terminalCount() === 1);
    app.close();
    await waitFor("its terminal to close with the connection", () => node.terminalCount() === 0);
    void id2;
    other.close();
  }, 30_000);
});

