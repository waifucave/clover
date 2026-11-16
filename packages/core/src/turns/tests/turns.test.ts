// Turns (§5.4 "Turns"): the queue's order; each way a turn ends (done, its limit, its holder gone, its plugin stopped,
// the daemon closing) and the log line for each; a waiting take that dies leaves the queue; who may use which name;
// and a host half's `take` through the real host runtime and the router (the `Turn` it gets, `lost`, a refusal).
import { describe, expect, test } from "bun:test";
import type { TurnEvent, TurnState } from "@waifucave/moss-plugin-sdk";
import type { Caller } from "@waifucave/moss-protocol";
import { FakeClock, flush } from "../../contracts/fakes/clock";
import { isContractError } from "../../contracts/common";
import type { PluginRecord } from "../../contracts/plugin-registry";
import type { HandlerContext } from "../../contracts/sdk-types";
import { createApiRouter } from "../../plugin-host/api/router";
import { LoopbackPluginHost } from "../../plugin-host/loopback";
import { checkTurnName, turnsApi } from "../api";
import { cleanTurnNote, TURN_TAKES_ALL, TURN_TAKES_PER_NAME, TURN_TAKES_PER_PLUGIN, TurnQueues } from "../queue";

function make() {
  const clock = new FakeClock({ start: 1_000_000 });
  const lines: string[] = [];
  const q = new TurnQueues({ clock, log: (l) => lines.push(l) });
  const taker = (pluginId: string, side: "ui" | "shared" = "shared", opts: { limitMs?: number; note?: string } = {}) => {
    const events: TurnEvent[] = [];
    const t = q.take("tarot/deck", { pluginId, side }, opts, (e) => events.push(e));
    return { ...t, events, granted: () => events.some((e) => e.type === "granted"), ended: () => events.find((e) => e.type === "ended") };
  };
  return { clock, lines, q, taker };
}

describe("turns: the queue", () => {
  test("first come, first served, one holder per name; each waiting take hears its place; done hands the turn on", () => {
    const { q, taker, lines } = make();
    const a = taker("tarot");
    const b = taker("cards");
    const c = taker("dice", "ui");
    expect(a.granted()).toBe(true);
    expect(b.granted() || c.granted()).toBe(false);
    expect(b.events).toEqual([{ type: "waiting", ahead: 1 }]);
    expect(c.events).toEqual([{ type: "waiting", ahead: 2 }]);
    expect(q.state("tarot/deck")).toMatchObject({ holder: { plugin: "tarot" }, waiting: 2 });
    q.done(a.id, "tarot");
    expect(a.ended()).toEqual({ type: "ended", reason: "done" });
    expect(b.granted()).toBe(true);
    expect(c.events.at(-1)).toEqual({ type: "waiting", ahead: 1 });
    q.done(b.id, "cards");
    expect(c.granted()).toBe(true);
    q.done(c.id, "dice");
    expect(q.state("tarot/deck")).toEqual({ name: "tarot/deck", waiting: 0 });
    expect(q.size).toBe(0);
    expect(lines.filter((l) => l.includes(" granted to "))).toHaveLength(3);
    expect(lines.filter((l) => l.includes("(done) after"))).toHaveLength(3);
    expect(lines[0]).toMatch(/^turns: tarot\/deck granted to tarot \(its host half, process shared\) after 0 ms waiting; its limit 60 s$/);
  });

  test("its limit ends it (default 60 s); extend moves it on, never past 10 minutes from the grant", () => {
    const { q, taker, clock, lines } = make();
    const a = taker("tarot", "shared", { limitMs: 1_000, note: "the reading" });
    const b = taker("cards");
    expect(q.extend(a.id, "tarot", 500)).toBe(1_001_500);
    expect(a.events.at(-1)).toEqual({ type: "extended", until: 1_001_500 });
    clock.advance(1_499);
    expect(a.ended()).toBeUndefined();
    clock.advance(1);
    expect(a.ended()).toEqual({ type: "ended", reason: "limit" });
    expect(b.granted()).toBe(true);
    expect(lines.some((l) => l === "turns: tarot/deck taken from tarot (its limit of 1.5 s passed) after 1500 ms")).toBe(true);
    // The default, and the cap on extensions.
    const until = (b.events.find((e) => e.type === "granted") as { until: number }).until;
    expect(until - clock.now()).toBe(60_000);
    expect(q.extend(b.id, "cards", 600_000)).toBe(clock.now() + 600_000);
    clock.advance(600_000);
    expect(b.ended()).toEqual({ type: "ended", reason: "limit" });
    // Only a held turn extends; another plugin's turn is not the caller's.
    const c = taker("dice");
    const d = taker("tarot");
    expect(isContractError(capture(() => q.extend(d.id, "tarot", 10)), "refused")).toBe(true);
    expect(isContractError(capture(() => q.extend(c.id, "tarot", 10)), "not_found")).toBe(true);
    expect(isContractError(capture(() => q.done(c.id, "tarot")), "not_found")).toBe(true);
  });

  test("its holder going (its frame, its host process, the app) is a loss; its plugin stopping too; the daemon closing ends all", () => {
    const { q, taker, lines } = make();
    const a = taker("tarot", "ui");
    const b = taker("cards");
    const c = taker("dice");
    a.leave();
    expect(a.ended()).toEqual({ type: "ended", reason: "stopped" });
    expect(lines.some((l) => l.startsWith("turns: tarot/deck taken from tarot (its taker went: its frame is gone, or the app quit)"))).toBe(true);
    expect(b.granted()).toBe(true);
    // A host half that stops loses only what its host process took.
    const d = taker("cards", "ui");
    q.endPlugin("cards", "its host half is restarting", (side) => side !== "ui");
    expect(b.ended()).toEqual({ type: "ended", reason: "stopped" });
    expect(lines.some((l) => l.startsWith("turns: tarot/deck taken from cards (its host half is restarting)"))).toBe(true);
    expect(c.granted()).toBe(true);
    expect(d.ended()).toBeUndefined();
    q.close();
    expect(c.ended()).toEqual({ type: "ended", reason: "stopped" });
    expect(d.ended()).toEqual({ type: "ended", reason: "stopped" });
    expect(q.size).toBe(0);
    // A take that is already over ends nothing again.
    a.leave();
    q.done(a.id, "tarot");
  });

  test("a waiting take that dies leaves the queue: it is never granted, and the ones behind it move up", () => {
    const { q, taker, lines } = make();
    const a = taker("tarot");
    const b = taker("cards", "ui");
    const c = taker("dice");
    b.leave();
    expect(b.ended()).toEqual({ type: "ended", reason: "stopped" });
    expect(lines.at(-1)).toBe("turns: cards's take of tarot/deck left the queue (its taker went: its frame is gone, or the app quit)");
    expect(c.events.at(-1)).toEqual({ type: "waiting", ahead: 1 });
    expect(q.state("tarot/deck").waiting).toBe(1);
    // Its plugin stopping takes a waiting take out the same way.
    const d = taker("ouija");
    q.endPlugin("ouija", "its plugin is off");
    expect(d.ended()).toEqual({ type: "ended", reason: "stopped" });
    q.done(a.id, "tarot");
    expect(b.granted()).toBe(false);
    expect(d.granted()).toBe(false);
    expect(c.granted()).toBe(true);
  });

  test("watch hears each change of the queue: a grant, a take joining, an end", () => {
    const { q, taker } = make();
    const seen: TurnState[] = [];
    const off = q.watch("tarot/deck", (s) => seen.push(s));
    const a = taker("tarot");
    taker("cards");
    q.done(a.id, "tarot");
    off();
    expect(seen.map((s) => [s.holder?.plugin ?? "-", s.waiting])).toEqual([["tarot", 0], ["tarot", 1], ["cards", 0]]);
  });
});

describe("turns: the caps on queued takes, and a take's note", () => {
  const takeOf = (q: TurnQueues, name: string, pluginId: string, note?: string) => q.take(name, { pluginId, side: "shared" }, note !== undefined ? { note } : {}, () => {});

  test("a plugin's takes of one name are capped; one over is refused with why; once one ends another joins", () => {
    const { q } = make();
    const held = Array.from({ length: TURN_TAKES_PER_NAME }, () => takeOf(q, "tarot/deck", "tarot"));
    const over = capture(() => takeOf(q, "tarot/deck", "tarot"));
    expect(isContractError(over, "refused")).toBe(true);
    expect((over as Error).message).toBe(`tarot already has ${TURN_TAKES_PER_NAME} takes of tarot/deck held or waiting; one must end before another joins`);
    expect(q.size).toBe(TURN_TAKES_PER_NAME);
    // Another name of its own, and another plugin on the same name, are not held up by it.
    expect(capture(() => takeOf(q, "tarot/spread", "tarot"))).toBeUndefined();
    expect(capture(() => takeOf(q, "tarot/deck", "cards"))).toBeUndefined();
    held[3]!.leave();
    expect(capture(() => takeOf(q, "tarot/deck", "tarot"))).toBeUndefined();
  });

  test("a plugin's takes over all its names are capped; the cap on every take on the computer too", () => {
    const { q } = make();
    const perName = TURN_TAKES_PER_PLUGIN / TURN_TAKES_PER_NAME;
    for (let n = 0; n < perName; n++) for (let i = 0; i < TURN_TAKES_PER_NAME; i++) takeOf(q, `tarot/n${n}`, "tarot");
    const over = capture(() => takeOf(q, "tarot/another", "tarot"));
    expect(isContractError(over, "refused")).toBe(true);
    expect((over as Error).message).toBe(`tarot already has ${TURN_TAKES_PER_PLUGIN} takes held or waiting; one must end before another joins`);
    q.endPlugin("tarot", "its plugin is off");
    expect(q.size).toBe(0);
    // Every plugin's takes together: fill the computer from many plugins, each under its own caps.
    const plugins = TURN_TAKES_ALL / TURN_TAKES_PER_PLUGIN;
    for (let p = 0; p < plugins; p++) for (let n = 0; n < perName; n++) for (let i = 0; i < TURN_TAKES_PER_NAME; i++) takeOf(q, `p${p}/n${n}`, `p${p}`);
    expect(q.size).toBe(TURN_TAKES_ALL);
    const full = capture(() => takeOf(q, "fresh/deck", "fresh"));
    expect(isContractError(full, "refused")).toBe(true);
    expect((full as Error).message).toBe(`${TURN_TAKES_ALL} takes are held or waiting on this computer; one must end before another joins`);
    q.endPlugin("p0", "its plugin is off");
    expect(capture(() => takeOf(q, "fresh/deck", "fresh"))).toBeUndefined();
    q.close();
  });

  test("a note's control characters never reach the log or state: each run is one space, the ends trimmed", () => {
    const { q, lines } = make();
    const raw = "\u001b[31mline one\r\n\tline two\u0007\u0085\u2028three\u202e\u2066four\u0000 ";
    takeOf(q, "tarot/deck", "tarot", raw);
    expect(q.state("tarot/deck").holder?.note).toBe("[31mline one line two three four");
    expect(lines.at(-1)).toContain(`, "[31mline one line two three four") after 0 ms waiting`);
    for (const l of lines) expect(l).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/);
    // A note that is nothing but control characters is no note.
    const q2 = make();
    takeOf(q2.q, "tarot/deck", "tarot", "\r\n\u0007");
    expect(q2.q.state("tarot/deck").holder).not.toHaveProperty("note");
    expect(q2.lines.at(-1)).toMatch(/^turns: tarot\/deck granted to tarot \(its host half, process shared\) after/);
    expect(cleanTurnNote("plain words")).toBe("plain words");
  });
});

const rec = (id: string, granted: string[] = [], turns?: { name: string; doc: string }[]): PluginRecord =>
  ({ id, enabled: true, state: "running", granted, manifest: { manifest: 1, id, name: id, version: "1.0.0", ...(turns ? { contributes: { turns } } : {}) } }) as unknown as PluginRecord;

describe("turns: who may use a name", () => {
  const records = new Map<string, PluginRecord>([
    ["tarot", rec("tarot", [], [{ name: "deck", doc: "the one deck" }])],
    ["cards", rec("cards")],
    ["voice", rec("voice", ["audio"])],
    ["talk", rec("talk", ["microphone"])],
    ["moss/voice", rec("moss/voice")],
  ]);
  const check = (caller: string, name: string) => capture(() => checkTurnName(name, { pluginId: caller, record: records.get(caller)! }, (id) => records.get(id)));

  test("its own needs no declaration; another plugin's only if that plugin lists it; a device turn needs its capability", () => {
    expect(check("cards", "cards/anything")).toBeUndefined();
    expect(check("moss/voice", "moss/voice/queue")).toBeUndefined();
    expect(check("cards", "tarot/deck")).toBeUndefined();
    const undeclared = check("cards", "tarot/spread");
    expect(isContractError(undeclared, "refused")).toBe(true);
    expect((undeclared as Error).message).toContain("tarot/spread is tarot's own turn, which it doesn't offer to other plugins");
    expect(isContractError(check("cards", "nobody/deck"), "refused")).toBe(true);
    expect(isContractError(check("cards", "device/speech"), "refused")).toBe(true);
    expect(check("voice", "device/speech")).toBeUndefined();
    // The microphone's turn is behind `microphone`, as speech's is behind `audio`.
    expect(check("talk", "device/microphone")).toBeUndefined();
    expect(isContractError(check("voice", "device/microphone"), "refused")).toBe(true);
    expect(isContractError(check("voice", "device/elsewhere"), "invalid")).toBe(true);
    expect(isContractError(check("voice", "Deck"), "invalid")).toBe(true);
    expect(isContractError(check("voice", "tarot/Deck Two"), "invalid")).toBe(true);
  });
});

describe("turns: a host half's take, through the host runtime and the router", () => {
  const USER: Caller = { kind: "user", client: "app" };
  function setup() {
    const clock = new FakeClock({ start: 1_000_000 });
    const lines: string[] = [];
    const queues = new TurnQueues({ clock, log: (l) => lines.push(l) });
    const records = new Map<string, PluginRecord>([["tarot", rec("tarot", [], [{ name: "deck", doc: "the one deck" }])], ["cards", rec("cards")]]);
    const host = new LoopbackPluginHost({ clock });
    host.serveApi(createApiRouter({ registry: { get: (id) => records.get(id) }, handlers: [turnsApi({ queues, record: (id) => records.get(id) })] }));
    const apis = new Map<string, HandlerContext["api"]>();
    for (const id of records.keys()) host.define(id, { start: async (api: HandlerContext["api"]) => void apis.set(id, api), ping: async () => "pong" });
    return { clock, queues, host, apis, lines };
  }

  test("take resolves with the turn once it comes; done hands it on; its limit settles lost; an undeclared name is refused", async () => {
    const { clock, queues, host, apis, lines } = setup();
    for (const id of ["tarot", "cards"]) await host.invoke({ pluginId: id, handler: "ping", args: null, caller: USER });
    const tarot = apis.get("tarot")!;
    const cards = apis.get("cards")!;
    // Granted at once: the grant comes while the take opens, and still reaches the take.
    const first = await tarot.turns.take("tarot/deck", { limitMs: 5_000, note: "first" });
    expect(first.until).toBe(clock.now() + 5_000);
    const heard: string[] = [];
    const second = cards.turns.take("tarot/deck", {}, (e) => heard.push(e.type));
    await settle();
    expect(heard).toEqual(["waiting"]);
    expect(await tarot.turns.state("tarot/deck")).toMatchObject({ holder: { plugin: "tarot", note: "first" }, waiting: 1 });
    await first.done();
    const turn = await second;
    // Its done reached the daemon as done, not as its holder going.
    expect(lines.filter((l) => l.startsWith("turns: tarot/deck ")).slice(0, 3)).toEqual([
      "turns: tarot/deck granted to tarot (its host half, process shared, \"first\") after 0 ms waiting; its limit 5 s",
      expect.stringMatching(/^turns: tarot\/deck ended by tarot \(done\) after \d+ ms$/) as unknown as string,
      expect.stringMatching(/^turns: tarot\/deck granted to cards /) as unknown as string,
    ]);
    expect(heard).toEqual(["waiting", "granted"]);
    expect(await turn.extend(1_000)).toBe(turn.until);
    let lost: string | undefined;
    void turn.lost.then((l) => (lost = l));
    clock.advance(61_000);
    await settle();
    expect(lost).toBe("limit");
    expect(queues.size).toBe(0);
    // Another plugin's name it doesn't offer.
    const refused = await cards.turns.take("tarot/spread").then(() => undefined, (e: unknown) => e);
    expect(isContractError(refused, "refused")).toBe(true);
    // An abort takes a waiting take out of the queue.
    const held = await tarot.turns.take("tarot/deck");
    const ctl = new AbortController();
    const waiting = cards.turns.take("tarot/deck", { signal: ctl.signal }).then(() => "granted", (e: unknown) => (e as Error).message);
    await settle();
    expect(queues.state("tarot/deck").waiting).toBe(1);
    ctl.abort();
    expect(await waiting).toContain("aborted before its turn");
    await settle();
    expect(queues.state("tarot/deck").waiting).toBe(0);
    await held.done();
  });
});

function capture(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (err) {
    return err;
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await flush();
}
