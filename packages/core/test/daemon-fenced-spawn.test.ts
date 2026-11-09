// The daemon's fenced process (the daemon integration lane, C-M2 part 2's #321): one `fencedSpawner` over this computer's
// one fence, its hook door (`hookSpawner`), and its `recheck` (the second line behind each run's git-key revert) at each
// of the bot side's turn ends and, with `end`, at each session's end. Fakes only where their lanes use them: a local-only
// computer (no link sidecar), D's plugin registry and drivers, and a recording spawner in place of the real one.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionView } from "@waifucave/clover-protocol";
import { catalogPointDecl } from "../../plugin-sdk/src/catalogs/index";
import { botManifest, Drivers, pluginFromFolder, writePlugin } from "../src/bots/tests/fixtures";
import { SystemClock } from "../src/clock/system-clock";
import { FakePluginRegistry } from "../src/contracts/fakes/plugin-registry";
import { recheckAtTurnEnds, startDaemonParts } from "../src/daemon-parts";
import type { FencedSpawner } from "../src/fence/spawn";
import { startDaemonLinks } from "../src/ipc/device-links";
import { CloverSecretStore, KeychainValues, memoryVault } from "../src/secrets/clover-secret-store";
import { mainSessionIdFor } from "../src/sessions/ids";
import { hostOs } from "../src/tree/names";
import { darwinTest } from "./helpers/darwin-only";

const clock = new SystemClock();
const temp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));
let stops: Array<() => unknown> = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});

async function waitFor(what: string, cond: () => boolean, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

/** A spawner that records each recheck. */
function recording(): FencedSpawner & { calls: Array<[string, boolean]> } {
  const calls: Array<[string, boolean]> = [];
  return {
    available: true, calls,
    run: async () => ({ kind: "refused", reason: "a test" }),
    recheck: (id, o) => { calls.push([id, o?.end === true]); return null; },
  };
}

/** A host that only watches and records the notes delivered to it. */
function fakeHost() {
  const fns: Array<(v: SessionView) => void> = [];
  const notes: Array<[string, string]> = [];
  return {
    notes,
    emit: (id: string, status: SessionView["status"]) => { for (const f of [...fns]) f({ id, status } as SessionView); },
    watch: (fn: (v: SessionView) => void) => { fns.push(fn); return () => void fns.splice(fns.indexOf(fn), 1); },
    deliver: async (id: string, input: { from: string; text?: string }) => { if (input.from === "note") notes.push([id, input.text ?? ""]); return { disposition: "note" as const }; },
  };
}

describe("recheckAtTurnEnds", () => {
  test("a turn's end rechecks, a session's end rechecks with end once, and nothing else does", () => {
    const host = fakeHost();
    const s = recording();
    const lines: string[] = [];
    recheckAtTurnEnds(host as never, s, (l) => lines.push(l));
    host.emit("a", "ready"); // no turn ran: nothing
    host.emit("a", "prompting");
    host.emit("a", "prompting");
    host.emit("a", "idle"); // a turn's end
    host.emit("a", "idle"); // no turn since: nothing
    host.emit("b", "prompting");
    host.emit("b", "cancelling");
    host.emit("b", "ready"); // a cancelled turn's end
    host.emit("a", "stopped"); // the session's end
    host.emit("a", "failed"); // ended already: nothing
    expect(s.calls).toEqual([["a", false], ["b", false], ["a", true]]);
    expect(lines).toEqual([]);
    expect(host.notes).toEqual([]);
  });

  test("#365 should-fix 1: a session resumed under the same id is watched again", () => {
    const host = fakeHost();
    const s = recording();
    recheckAtTurnEnds(host as never, s, () => {});
    host.emit("a", "prompting");
    host.emit("a", "stopped");
    host.emit("a", "starting"); // resumed
    host.emit("a", "prompting");
    host.emit("a", "idle");
    host.emit("a", "stopped");
    expect(s.calls).toEqual([["a", true], ["a", false], ["a", true]]);
  });

  test("#365's blocker: the end pass rechecks, with end, every session still open; the close then only stops watching", async () => {
    const host = fakeHost();
    const s = recording();
    const watch = recheckAtTurnEnds(host as never, s, () => {});
    host.emit("a", "prompting"); // still running at the stop
    host.emit("b", "idle"); // open, idle
    host.emit("c", "prompting");
    host.emit("c", "stopped"); // ended already
    await watch.endPass();
    expect(s.calls).toEqual([["c", true], ["a", true], ["b", true]]);
    watch.close();
    host.emit("a", "idle"); // removed: nothing more
    expect(s.calls).toHaveLength(3);
  });

  test("#369's review: the end pass waits on its notes only so long (a note to a computer that's gone can't hang the stop)", async () => {
    const host = fakeHost();
    host.deliver = () => new Promise(() => {}); // never answers
    const lines: string[] = [];
    const watch = recheckAtTurnEnds(host as never, { recheck: () => "reverted core.hooksPath" }, (l) => lines.push(l));
    host.emit("a", "idle");
    const started = Date.now();
    await watch.endPass();
    expect(Date.now() - started).toBeLessThan(7_000);
    expect(lines).toContain("the stop's recheck notes weren't all recorded within 4 s");
  }, 10_000);

  test("#365 should-fix 2: a revert and a recheck that throws reach the log and the session's own record", () => {
    const host = fakeHost();
    let n = 0;
    const lines: string[] = [];
    recheckAtTurnEnds(host as never, { recheck: () => { if (n++ === 0) return "reverted core.hooksPath in project1/.git/config"; throw new Error("boom"); } }, (l) => lines.push(l));
    for (const status of ["prompting", "idle", "prompting", "idle"] as const) host.emit("s1", status);
    expect(lines).toEqual(["s1: reverted core.hooksPath in project1/.git/config", "s1: the recheck failed: boom"]);
    expect(host.notes).toEqual([
      ["s1", "Clover undid a git setting this session's commands changed: reverted core.hooksPath in project1/.git/config"],
      ["s1", "Clover couldn't look again at the git settings this session's commands may have changed: boom"],
    ]);
  });
});

test("the daemon's parts: one spawner over the fence, its hook door, and its recheck at a bot's turn end", async () => {
  const home = temp("clover-int-fenced-");
  const store = new CloverSecretStore({ home, values: new KeychainValues(memoryVault()), status: { backend: "memory", plaintext: false, state: "unlocked" } });
  const handlers = {};
  // One computer on its own: local-only links (no sidecar).
  const d = await startDaemonLinks({
    home, store, clock, self: { name: "Studio", os: "macos" }, handlers, binary: null,
    mainComputer: { watchSleep: false, monotonic: () => performance.now() }, dispatch: async () => null,
  });
  stops.push(() => d.close());
  const root = temp("clover-int-plugins-");
  const luna = writePlugin(root, "luna", { "clover.json": botManifest("luna", "Luna"), "bot/instructions.md": "You are Luna." });
  const fakes = new Drivers();
  const spawner = recording();
  const parts = await startDaemonParts({
    cloverHome: home, userHome: temp("clover-int-user-"), clock, links: d.links, handlers, spawner,
    bots: { registry: new FakePluginRegistry({ catalog: catalogPointDecl, plugins: (await pluginFromFolder(luna)).inputs }), drivers: () => fakes.factory, defaultModel: () => ({ model: "clover-test/calls" }) },
  });
  stops.push(() => parts.close());
  expect(parts.spawner).toBe(spawner);
  // Fenced on macOS and Linux (bwrap there, or a refusal with the reason where it's missing); the user's own on Windows.
  if (hostOs() === "windows") expect(parts.hookSpawner).not.toBe(spawner);
  else expect(parts.hookSpawner).toBe(spawner);

  const side = parts.bots!;
  const id = mainSessionIdFor("luna");
  // This computer holds its own lease, so Luna's conversation runs here.
  await waitFor("Luna to run here", () => side.bots.botsRunHere().includes("luna"));
  await side.host.sendUser(id, { text: "hello", device: d.links!.key.id, sentAt: Date.now(), clientMessageId: "m1" });
  await waitFor("Luna's turn", () => fakes.for(id).running);
  expect(spawner.calls).toEqual([]);
  fakes.for(id).end();
  await waitFor("the turn's recheck", () => spawner.calls.length > 0);
  expect(spawner.calls).toEqual([[id, false]]);

  // #365's blocker: the stop with a turn running. The bot side cancels it first, and its session is rechecked with
  // `end` after that, never skipped because the watch went first.
  await side.host.sendUser(id, { text: "again", device: d.links!.key.id, sentAt: Date.now(), clientMessageId: "m2" });
  await waitFor("Luna's second turn", () => fakes.for(id).running);
  const statusAtEnd: Array<string | undefined> = [];
  const recheck = spawner.recheck!;
  spawner.recheck = (sid, o) => { if (o?.end) statusAtEnd.push(side.host.get(sid)?.status); return recheck(sid, o); };
  await parts.close();
  expect(spawner.calls.at(-1)).toEqual([id, true]);
  // Looked at once the stop had cancelled its turn (a bot's conversation stays, idle), never while the turn still ran:
  // with the watch removed first, this would read "prompting".
  expect(statusAtEnd).toEqual(["idle"]);
});

darwinTest("#365's blocker, for real: a git key a session's command left behind after its run is reverted at the daemon's stop, and the session is told", async () => {
  const home = temp("clover-int-fenced-real-");
  const userHome = realpathSync(temp("clover-int-user-"));
  const project = join(userHome, "project1");
  mkdirSync(project, { recursive: true });
  expect(Bun.spawnSync(["git", "init", "-q", project]).exitCode).toBe(0);
  const store = new CloverSecretStore({ home, values: new KeychainValues(memoryVault()), status: { backend: "memory", plaintext: false, state: "unlocked" } });
  const handlers = {};
  const d = await startDaemonLinks({
    home, store, clock, self: { name: "Studio", os: "macos" }, handlers, binary: null,
    mainComputer: { watchSleep: false, monotonic: () => performance.now() }, dispatch: async () => null,
  });
  stops.push(() => d.close());
  const root = temp("clover-int-plugins-");
  const luna = writePlugin(root, "luna", { "clover.json": botManifest("luna", "Luna"), "bot/instructions.md": "You are Luna." });
  const fakes = new Drivers();
  // No spawner handed in: the parts' own, over their fence (Seatbelt on this Mac).
  const parts = await startDaemonParts({
    cloverHome: home, userHome, clock, links: d.links, handlers,
    bots: { registry: new FakePluginRegistry({ catalog: catalogPointDecl, plugins: (await pluginFromFolder(luna)).inputs }), drivers: () => fakes.factory, defaultModel: () => ({ model: "clover-test/calls" }) },
  });
  let closed = false;
  stops.push(() => (closed ? undefined : parts.close()));
  const side = parts.bots!;
  const id = mainSessionIdFor("luna");
  await waitFor("Luna to run here", () => side.bots.botsRunHere().includes("luna"));
  await side.host.sendUser(id, { text: "hello", device: d.links!.key.id, sentAt: Date.now(), clientMessageId: "m1" });
  await waitFor("Luna's turn", () => fakes.for(id).running);
  // A command of the session's in the repository, through the daemon's one spawner: its configs are watched from here.
  const ran = await parts.spawner!.run({
    command: "true", cwd: project, env: { PATH: "/usr/bin:/bin", HOME: userHome }, timeoutMs: 30_000,
    who: { caller: { kind: "session", sessionId: id, sessionKind: "bot", bot: "luna" } },
  });
  expect(ran.kind).toBe("exited");
  // The turn ends (its recheck finds nothing yet); the session stays open, idle.
  fakes.for(id).end();
  await waitFor("the turn's end", () => side.host.get(id)?.status === "idle");
  // Something the command left running plants a key after the run's own revert pass and the turn's recheck.
  const config = join(project, ".git", "config");
  writeFileSync(config, `${readFileSync(config, "utf8")}[core]\n\thooksPath = ${join(userHome, "evil-hooks")}\n`);
  await parts.close();
  closed = true;
  // Reverted by the stop's end pass (inside the bot side's close, before the sessions' release), whose note is on the
  // session's record: the note this test proves is the end pass's, not a turn end's.
  expect(readFileSync(config, "utf8")).not.toContain("evil-hooks");
  expect(side.host.history(id).some((r) => r.type === "input" && (r.input as { from?: string; text?: string }).from === "note" && /undid a git setting/.test((r.input as { text: string }).text))).toBe(true);
}, 60_000);
