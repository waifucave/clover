// Lane D's bot-side options on a real daemon in a temp home (daemon-parts.ts `botSideOptions`): a routine fires on its
// schedule and posts its result into its bot's conversation, a bot's conversation compacts on the clock, and a bot's
// conversation picks up where it was after the daemon restarts. Fakes only where lane D's own tests use them: the
// plugin registry and the session drivers; H's in-memory network and local handshake for the links.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FileSecretStore } from "../src/auth/secret-store";
import { botManifest, pluginFromFolder, writePlugin } from "../src/bots/tests/fixtures";
import type { BotSessionContext } from "../src/bots/service";
import { catalogPointDecl } from "../../plugin-sdk/src/catalogs/index";
import { SystemClock } from "../src/clock/system-clock";
import { FakePluginRegistry } from "../src/contracts/fakes/plugin-registry";
import { FakeSessionDriver } from "../src/contracts/fakes/session-host";
import type { CompactReason } from "../src/sessions/durable-host";
import { startDaemon, type RunningDaemon } from "../src/daemon";
import type { DaemonBotsInput } from "../src/daemon-parts";
import { cloverCall } from "../src/ipc/clover-client";
import { HandshakeClient } from "../src/links/handshake";
import { startFakeHandshake } from "../src/links/handshake-fake";
import { MemoryNetwork } from "../src/links/memory-wire";
import { routineFilePath } from "../src/routines/engine";
import { CloverSecretStore, KeychainValues, memoryVault } from "../src/secrets/clover-secret-store";
import { mainSessionIdFor } from "../src/sessions/ids";

const clock = new SystemClock();
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

/** A fake driver that also compacts when the host asks, as lane A's runtime does. */
class CompactingDriver extends FakeSessionDriver {
  readonly compactions: CompactReason[] = [];
  compact(req: { reason: CompactReason; signal: AbortSignal }): Promise<{ compacted: boolean }> {
    this.compactions.push(req.reason);
    return Promise.resolve({ compacted: true });
  }
}

/** Lane D's fakes for the daemon: a registry holding Luna, read from her folder, and drivers the test steers. */
async function lunaBots(opts: Partial<DaemonBotsInput> = {}) {
  const root = temp("clover-d-side-plugins-");
  const luna = writePlugin(root, "luna", { "clover.json": botManifest("luna", "Luna"), "bot/instructions.md": "You are Luna." });
  const registry = new FakePluginRegistry({ catalog: catalogPointDecl, plugins: (await pluginFromFolder(luna)).inputs });
  const made: { ctx: BotSessionContext; driver: CompactingDriver }[] = [];
  const bots: DaemonBotsInput = {
    registry,
    drivers: () => (ctx) => {
      const driver = new CompactingDriver({ canFold: true });
      made.push({ ctx, driver });
      return driver;
    },
    defaultModel: () => ({ model: "winter-test/calls" }),
    ...opts,
  };
  const latest = (pick: (m: { ctx: BotSessionContext }) => boolean) => [...made].reverse().find(pick)?.driver;
  return { bots, made, latest };
}

/** A daemon on `home` with its links on an in-memory network, as the daemon integration's own boot test runs it. */
async function boot(home: string, bots: DaemonBotsInput, net: MemoryNetwork, hs: { url: string }, contractSecrets?: CloverSecretStore): Promise<RunningDaemon> {
  const d = await startDaemon({
    home, secrets: new FileSecretStore(join(home, "secrets.json")), agentProvider: null, pair: false,
    ...(contractSecrets === undefined ? {} : { contractSecrets }),
    links: {
      wire: (k) => net.endpoint(k.publicKey), handshake: new HandshakeClient({ baseUrl: hs.url, clock }), publicTime: null,
      mainComputer: { watchSleep: false, monotonic: () => performance.now() }, watch: () => () => {}, self: { name: "Studio", os: "macos" },
    },
    parts: { userHome: temp("clover-d-side-user-"), bots },
  });
  await d.cloverParts.ready;
  // The user makes this computer the main one (the lease), so it runs the bots' conversations.
  const links = d.cloverParts.links();
  if (links === undefined) {
    await d.stop();
    throw new Error("the daemon's links didn't start");
  }
  const cli = { role: "cli" as const, token: d.tokens.harness, clientName: "lane-d-test" };
  await cloverCall(d.socketPath, cli, "main.set", { device: links.key.id });
  await waitFor("this computer running Luna", () => d.cloverParts.bots()?.bots.botsRunHere().includes("luna") === true);
  return d;
}

function network() {
  const hs = startFakeHandshake();
  stops.push(() => hs.stop());
  return { net: new MemoryNetwork(), hs };
}

const luna = mainSessionIdFor("luna");
const user = (text: string) => ({ text, device: "studio-device", sentAt: Date.now(), clientMessageId: `m-${text}` });

describe("the bot side's options on a booted daemon", () => {
  test("a routine fires on its schedule: its side thread runs, and its result is posted into its bot's conversation", async () => {
    const { net, hs } = network();
    const home = temp("clover-d-side-home-");
    // A routine of Luna's, every second, in this computer's routines folder.
    const file = routineFilePath(home, "luna", "tick");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "---\nid: r_ticktick\nname: Tick\ntriggers:\n  - schedule: every 1s\n---\nSay the time.\n");
    const { bots, latest } = await lunaBots();
    daemon = await boot(home, bots, net, hs);
    const side = daemon.cloverParts.bots()!;
    expect(side.routines).toBeDefined();
    // The app's `routine.*` are served over the socket: the routine is listed.
    const cli = { role: "cli" as const, token: daemon.tokens.harness, clientName: "lane-d-test" };
    const listed = await cloverCall(daemon.socketPath, cli, "routine.list", { bot: "luna" }) as { routines: { id: string; name: string }[] };
    expect(listed.routines).toEqual([expect.objectContaining({ id: "r_ticktick", name: "Tick" })]);
    await waitFor("the routine's side thread", () => latest((m) => m.ctx.kind === "side-thread")?.running === true);
    const thread = latest((m) => m.ctx.kind === "side-thread")!;
    expect(thread.turns[0]?.input).toMatchObject({ from: "routine", routine: "r_ticktick", name: "Tick" });
    thread.end({ text: "It's tea time." });
    await waitFor("its result in Luna's conversation", () => side.host.history(luna).some((r) => r.type === "input" && r.input.from === "routine"));
    const posted = side.host.history(luna).find((r) => r.type === "input" && r.input.from === "routine");
    expect(posted).toMatchObject({ input: { from: "routine", routine: "r_ticktick", text: "It's tea time." } });
  });

  test("a bot's conversation compacts on the clock, with the daemon's numbers", async () => {
    const { net, hs } = network();
    // The cache lives 1.2 s here and the compaction starts 1 s before it expires, over 1000 tokens of context.
    const { bots, latest } = await lunaBots({ compaction: () => ({ cacheTtlMs: 1_200, thresholdTokens: 1_000, leadMs: 1_000 }) });
    daemon = await boot(temp("clover-d-side-home-"), bots, net, hs);
    const side = daemon.cloverParts.bots()!;
    await side.host.sendUser(luna, user("hello"));
    const driver = latest((m) => m.ctx.sessionId === luna)!;
    await waitFor("Luna's turn", () => driver.running);
    driver.end({ text: "hi", usage: { inputTokens: 6_000, outputTokens: 100, contextTokens: 2_000 } });
    await waitFor("the cache-timed compaction", () => driver.compactions.length > 0);
    expect(driver.compactions).toEqual(["cache"]);
  });

  test("after a restart, a bot's conversation picks up where it was and takes its next message", async () => {
    const { net, hs } = network();
    const home = temp("clover-d-side-home-");
    // The device's key outlives the restart, as the Keychain keeps it.
    const store = new CloverSecretStore({ home, values: new KeychainValues(memoryVault()), status: { backend: "memory", plaintext: false, state: "unlocked" } });
    const first = await lunaBots();
    daemon = await boot(home, first.bots, net, hs, store);
    let side = daemon.cloverParts.bots()!;
    await side.host.sendUser(luna, user("before"));
    const before = first.latest((m) => m.ctx.sessionId === luna)!;
    await waitFor("the first turn", () => before.running);
    before.end({ text: "noted" });
    await waitFor("the first turn's end", () => side.host.history(luna).some((r) => r.type === "turn_ended"));
    const held = side.host.history(luna);
    await daemon.stop();
    daemon = undefined;

    // The restarted daemon's links come up on a fresh network (the old one still names the stopped daemon's key).
    const second = await lunaBots();
    daemon = await boot(home, second.bots, new MemoryNetwork(), hs, store);
    side = daemon.cloverParts.bots()!;
    // The conversation is the same one, its log whole, and a new driver attached to it.
    expect(side.host.history(luna).slice(0, held.length)).toEqual(held);
    expect(side.host.isAttached(luna)).toBe(true);
    await side.host.sendUser(luna, user("after"));
    const after = second.latest((m) => m.ctx.sessionId === luna)!;
    await waitFor("the next turn", () => after.running);
    expect(after.turns.at(-1)?.input).toMatchObject({ from: "user", text: "after" });
    after.end({ text: "still here" });
    await waitFor("its end", () => side.host.history(luna).filter((r) => r.type === "turn_ended").length === 2);
    // The seq goes on from where it was.
    expect(side.host.history(luna).at(-1)!.seq).toBeGreaterThan(held.at(-1)!.seq);
  });
});
