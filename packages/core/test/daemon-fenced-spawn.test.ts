// The daemon's fenced process (the daemon integration lane, C-M2 part 2's #321): one `fencedSpawner` over this computer's
// one fence, its hook door (`hookSpawner`), and its `recheck` (the second line behind each run's git-key revert) at each
// of the bot side's turn ends and, with `end`, at each session's end. Fakes only where their lanes use them: a local-only
// computer (no link sidecar), D's plugin registry and drivers, and a recording spawner in place of the real one.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
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

describe("recheckAtTurnEnds", () => {
  test("a turn's end rechecks, a session's end rechecks with end once, and nothing else does", () => {
    const fns: Array<(v: SessionView) => void> = [];
    const host = { watch: (fn: (v: SessionView) => void) => (fns.push(fn), () => {}) };
    const s = recording();
    const lines: string[] = [];
    recheckAtTurnEnds(host, s, (l) => lines.push(l));
    const emit = (id: string, status: SessionView["status"]) => { for (const f of fns) f({ id, status } as SessionView); };
    emit("a", "ready"); // no turn ran: nothing
    emit("a", "prompting");
    emit("a", "prompting");
    emit("a", "idle"); // a turn's end
    emit("a", "idle"); // no turn since: nothing
    emit("b", "prompting");
    emit("b", "cancelling");
    emit("b", "ready"); // a cancelled turn's end
    emit("a", "stopped"); // the session's end
    emit("a", "prompting"); // forgotten: nothing more
    emit("a", "failed");
    expect(s.calls).toEqual([["a", false], ["b", false], ["a", true]]);
    expect(lines).toEqual([]);
  });

  test("a recheck's report and a recheck that throws reach the log, and the watch goes on", () => {
    const fns: Array<(v: SessionView) => void> = [];
    const host = { watch: (fn: (v: SessionView) => void) => (fns.push(fn), () => {}) };
    let n = 0;
    const lines: string[] = [];
    recheckAtTurnEnds(host, { recheck: () => { if (n++ === 0) return "reverted core.hooksPath in project1/.git/config"; throw new Error("boom"); } }, (l) => lines.push(l));
    for (const status of ["prompting", "idle", "prompting", "idle"] as const) for (const f of fns) f({ id: "s1", status } as SessionView);
    expect(lines).toEqual(["s1: reverted core.hooksPath in project1/.git/config", "s1: the recheck failed: boom"]);
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
  // Fenced on macOS; the user's own elsewhere (hooks are plugin code the user installed).
  if (hostOs() === "macos") expect(parts.hookSpawner).toBe(spawner);
  else expect(parts.hookSpawner).not.toBe(spawner);

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
});
