// MOSS's seam to the engine (engine.ts) and its presence (presence.ts), against the fake engine built from the spine's
// contracts' fakes: the bots with their moods, last lines and unread dots; a piece the engine doesn't serve shows as
// waiting, never as made-up data; the conversation as plain messages with its attachment; and the router's placement
// from MOSS's presence: the bot on screen gets its card in the conversation, another bot's goes to the window's strip,
// and a reconnect reads the placements again (`card_placed` is transient).
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { daemonEndpoint, dial, type DaemonClient } from "../src/main/client";
import { messageOf, MossEngine } from "../src/main/engine";
import { PresenceReporter } from "../src/main/presence";
import { SealedFrames } from "../src/main/sealed";
import { mossHello } from "../src/main/connection";
import { startFakeEngine, type FakeEngine, type FakePiece } from "./fake-engine/engine";

const homes: string[] = [];
const closers: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

const until = async (what: () => boolean, ms = 2_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!what()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

async function setup(drop: FakePiece[] = []): Promise<{ e: FakeEngine; client: DaemonClient; engine: MossEngine; sealed: SealedFrames }> {
  const h = mkdtempSync(join(tmpdir(), "ma-"));
  homes.push(h);
  const e = await startFakeEngine({ home: h, drop });
  closers.push(() => e.close());
  const client = (await dial(daemonEndpoint(h)))!;
  closers.push(() => client.close());
  await client.request("protocol.prove", { nonce: "n" });
  await client.request("protocol.hello", mossHello(e.token, "0.124.0", 1));
  const sealed = new SealedFrames("moss");
  const engine = new MossEngine(sealed);
  client.onNotification((m, p) => engine.notification(m, p));
  engine.setConnection("connected");
  await engine.attach(client);
  return { e, client, engine, sealed };
}

describe("the bots, from the engine", () => {
  test("each bot with its mood from the feed, its last line and its unread dot", async () => {
    const { engine } = await setup();
    const v = engine.view();
    expect(v.bots.length).toBe(8);
    const by = new Map(v.bots.map((b) => [b.id, b]));
    expect(by.get("juniper")).toMatchObject({ name: "Juniper", mood: "working", tool: "mcp__moss__Browser", unread: false });
    expect(by.get("kite")).toMatchObject({ mood: "asking", unread: true });
    expect(by.get("onyx")?.mood).toBe("asleep");
    expect(by.get("ada")?.face).toEqual({ shape: "cup", color: "violet" });
    expect(new Set(v.bots.map((b) => b.mood)).size).toBe(8);
    // Newest activity first.
    expect(v.bots[0]?.id).toBe("juniper");
    expect(v.pieces).toMatchObject({ bots: "ready", summaries: "ready", activity: "ready" });
  });

  test("a piece the engine doesn't serve yet is waiting, and nothing is made up for it", async () => {
    const { engine } = await setup(["activity", "router", "bots"]);
    const v = engine.view();
    expect(v.pieces).toMatchObject({ bots: "waiting", activity: "waiting", router: "waiting" });
    expect(v.bots).toEqual([]);
    expect(v.cards).toEqual([]);
    expect(await engine.conversation("juniper")).toEqual({ waiting: true });
  });

  test("a mood change in the feed reaches the bot's row", async () => {
    const { e, engine } = await setup();
    let last = engine.view();
    engine.onView((v) => { last = v; });
    e.feed.set({ subject: { kind: "bots", id: "maple" }, state: "done", name: "Maple", since: Date.now() });
    await until(() => last.bots.find((b) => b.id === "maple")?.mood === "done");
  });
});

describe("the conversation", () => {
  test("plain messages, the person's file as an attachment, and the token out of the words", async () => {
    const { engine } = await setup();
    const page = await engine.conversation("juniper");
    if ("waiting" in page) throw new Error("waiting");
    expect(page.messages.map((m) => m.from)).toEqual(["user", "bot", "user", "bot"]);
    const withFile = page.messages[2]!;
    expect(withFile.files).toEqual([{ name: "Travel notes.pdf", kind: "file" }]);
    expect(withFile.text).toBe("Use my travel notes for the seat and the bag.");
  });

  test("a bot's markup stays text: the message is the string as written", () => {
    const m = messageOf({ type: "assistant_message", seq: 1, sessionId: "s", ts: 1, threadId: "t", text: "<img src=x onerror=alert(1)><b>hi</b>" });
    expect(m?.text).toBe("<img src=x onerror=alert(1)><b>hi</b>");
  });

  test("the person's words arrive live in the conversation it follows", async () => {
    const { engine } = await setup();
    const got: string[] = [];
    engine.onMessage((bot, m) => got.push(`${bot}:${m.text}`));
    await engine.conversation("kite");
    await until(() => true);
    await new Promise((r) => setTimeout(r, 30));
    expect(await engine.send("kite", "Yes, go ahead", "m1")).toEqual({ ok: true });
    await until(() => got.includes("kite:Yes, go ahead"));
  });
});

describe("a bot's own choices", () => {
  test("every plugin's bot-scoped settings for one bot, from bot.pluginSettings, drawn from their schema", async () => {
    const { engine } = await setup();
    const rows = await engine.botSettings("juniper");
    if ("waiting" in rows) throw new Error("waiting");
    expect(rows.map((r) => `${r.pluginId}/${r.key}:${r.type}`)).toEqual(["moss/voice/voice:enum", "moss/voice/silent:boolean"]);
    expect(rows[0]?.options?.[0]).toEqual({ value: "fish:river", title: "River (Fish Audio)" });
  });
});

describe("presence and the router's placement", () => {
  test("in front showing Juniper: Juniper's card in the conversation, Kite's in the strip", async () => {
    const { client, engine } = await setup();
    const presence = new PresenceReporter(() => {}, 60_000);
    closers.push(() => presence.stop());
    presence.connected(client);
    presence.update({ focused: true, visible: true, showing: { kind: "bot", id: "juniper" } });
    await until(() => engine.view().cards.length === 2);
    const cards = new Map(engine.view().cards.map((c) => [c.id, c.place]));
    expect(cards.get("card_juniper_book")).toBe("conversation");
    expect(cards.get("card_kite_delete")).toBe("strip");
    // Not in front: both go to the island, and the window draws neither.
    presence.update({ focused: false, visible: true, showing: { kind: "bot", id: "juniper" } });
    await until(() => engine.view().cards.length === 0);
    expect(engine.placementOf("card_kite_delete")).toEqual({ kind: "island" });
  });

  test("a reconnect reads the placements again", async () => {
    const { e, client, engine } = await setup();
    const presence = new PresenceReporter(() => {}, 60_000);
    closers.push(() => presence.stop());
    presence.connected(client);
    presence.update({ focused: true, visible: true, showing: { kind: "bot", id: "kite" } });
    await until(() => engine.view().cards.length === 2);
    // A second connection (MOSS restarted, or the engine did): no `card_placed` comes for what is already placed.
    const again = (await dial(daemonEndpoint(e.home)))!;
    closers.push(() => again.close());
    await again.request("protocol.prove", { nonce: "n" });
    await again.request("protocol.hello", mossHello(e.token, "0.124.0", 1));
    const fresh = new MossEngine(new SealedFrames("moss"));
    fresh.setConnection("connected");
    await fresh.attach(again);
    expect(fresh.placementOf("card_kite_delete")).toEqual({ kind: "conversation", program: "moss", window: "main" });
  });

  test("presence goes on every change and on the beat", async () => {
    const { e, client } = await setup();
    const presence = new PresenceReporter(() => {}, 40);
    closers.push(() => presence.stop());
    presence.update({ focused: true, visible: true, showing: null });
    presence.connected(client);
    const count = () => e.calls().filter((x) => x.method === "presence.report").length;
    await until(() => count() >= 3, 1_000);
    presence.update({ focused: false, visible: true, showing: null });
    const reports = e.calls().filter((x) => x.method === "presence.report").map((x) => x.params as { windows: { focused: boolean }[] });
    await until(() => e.calls().filter((x) => x.method === "presence.report").some((x) => (x.params as { windows: { focused: boolean }[] }).windows[0]?.focused === false));
    expect(reports[0]?.windows[0]).toMatchObject({ window: "main", focused: true, visible: true, showing: null });
  });
});
