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
import { sealedCard } from "./fake-engine/fixtures";

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

async function setup(drop: FakePiece[] = [], still?: { frameMs: number; picturePng: Uint8Array }, more: { running?: Record<string, { name: string; argsJson: string; displayTitle?: string }> } = {}): Promise<{ e: FakeEngine; client: DaemonClient; engine: MossEngine; sealed: SealedFrames }> {
  const h = mkdtempSync(join(tmpdir(), "ma-"));
  homes.push(h);
  const e = await startFakeEngine({ home: h, drop, ...(still ?? {}), ...more });
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

  test("a turn that ended in an error is the conversation's failed note; one that ended well is no message", () => {
    expect(messageOf({ type: "turn_completed", seq: 7, sessionId: "s", ts: 1, stopReason: "error" })).toMatchObject({ from: "note", failed: true });
    // A routine's result in the conversation: a note naming it, its failure said.
    expect(messageOf({ type: "routine_result", seq: 8, sessionId: "s", ts: 1, routine: "r_x", name: "Brief", sideThread: "t_1", text: "Done: 3 mails.", failed: false })).toMatchObject({ from: "note", text: 'Routine "Brief": Done: 3 mails.' });
    expect(messageOf({ type: "routine_result", seq: 9, sessionId: "s", ts: 1, routine: "r_x", name: "Brief", sideThread: "t_1", text: "No inbox.", failed: true })?.text).toBe('Routine "Brief" failed: No inbox.');
    // The engine's own words for a failure carry its why; with no words at all it still says it failed.
    expect(messageOf({ type: "routine_result", seq: 10, sessionId: "s", ts: 1, routine: "r_x", name: "Brief", sideThread: "t_1", text: "The run failed (provider): the model refused the key.", failed: true })).toMatchObject({ from: "note", routineFailed: true, text: 'Routine "Brief": The run failed (provider): the model refused the key.' });
    expect(messageOf({ type: "routine_result", seq: 11, sessionId: "s", ts: 1, routine: "r_x", name: "Brief", sideThread: "t_1", text: "  ", failed: true })?.text).toBe('Routine "Brief" failed, and said nothing about why.');
    expect(messageOf({ type: "turn_completed", seq: 8, sessionId: "s", ts: 1, stopReason: "end_turn" })).toBeUndefined();
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

describe("a bot's live picture", () => {
  test("a still picture's one frame, sent before picture.open's answer, is drawn (the moss unit's empty screen)", async () => {
    // One frame, published once, and no other for an hour.
    const { engine } = await setup([], { frameMs: 3_600_000, picturePng: Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64")) });
    const pics = await engine.pictures("juniper");
    if ("waiting" in pics || pics[0] === undefined) throw new Error(`no picture: ${JSON.stringify(pics)}`);
    const got: string[] = [];
    engine.onPictureFrame((f) => got.push(f.id));
    expect(await engine.openPicture(pics[0].id)).toBe(true);
    await new Promise((r) => setTimeout(r, 100));
    expect(got).toEqual([pics[0].id]);
  });
});

describe("the pages' data (Plugins, Settings, a bot's Edit view)", () => {
  test("Settings' sign-ins name each plugin in words, never the engine's table of languages (it took the window down once)", async () => {
    const { engine } = await setup();
    const s = await engine.settings();
    if (s.signIns === "waiting") throw new Error("sign-ins waiting");
    expect(s.signIns.length).toBeGreaterThan(0);
    for (const r of s.signIns) expect(typeof r.name).toBe("string");
    expect(s.signIns.map((r) => r.name)).toContain("Fish Audio");
  });

  test("tools with their declared default, the person's value and permission; models; a bot's record; edits", async () => {
    const { engine } = await setup();
    const plugins = await engine.plugins();
    if ("waiting" in plugins) throw new Error("waiting");
    const fill = plugins.find((p) => p.id === "moss/browser")?.tools.find((t) => t.tool === "Fill");
    expect(fill).toMatchObject({ availability: "off", declared: "on-demand", permission: "ask" });
    expect(plugins.find((p) => p.id === "opensky")?.tools.find((t) => t.tool === "Type")?.permission).toBe("deny");
    expect(await engine.setPermission("opensky", "Type", "ask")).toBe(true);
    const models = await engine.models();
    expect(Array.isArray(models) ? models.map((m) => m.ready) : models).toEqual([true, true, false]);
    expect(await engine.botRecord("juniper")).toMatchObject({ id: "juniper", name: "Juniper", model: "anthropic/claude-sonnet" });
    expect(await engine.editBot("juniper", { model: "anthropic/claude-haiku" })).toBe(true);
    expect(await engine.botRecord("juniper")).toMatchObject({ model: "anthropic/claude-haiku" });
    expect(await engine.signIn("fish-audio", 0, "dummy-key")).toEqual({ state: "signed-in" });
    expect(await engine.pictures("juniper")).toEqual([]);
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

  test("a connection follows the events BEFORE it lists the cards: one raised in between, and one waiting at connect, are both placed and drawn, once", async () => {
    const { e, client } = await setup();
    const presence = new PresenceReporter(() => {}, 60_000);
    closers.push(() => presence.stop());
    presence.connected(client);
    presence.update({ focused: true, visible: true, showing: { kind: "bot", id: "juniper" } });
    // A new connection (a first connect or a reconnect): a card raised after its subscribe, before its list is answered.
    const raced = sealedCard({ id: "card_juniper_raced", kind: "tool", computer: "Studio", session: "bot:juniper", bot: "juniper", origin: "user", issuedAt: Date.now(), expiresAt: null, fields: { title: { type: "text", text: "Raced" } }, options: [{ id: "allow_once", kind: "approve", label: "Approve" }, { id: "deny", kind: "deny", label: "Deny" }] } as never);
    e.beforeCardList(() => e.raise(raced));
    for (const round of ["first", "again"]) {
      const conn = (await dial(daemonEndpoint(e.home)))!;
      closers.push(() => conn.close());
      await conn.request("protocol.prove", { nonce: "n" });
      await conn.request("protocol.hello", mossHello(e.token, "0.124.0", 1));
      const fresh = new MossEngine(new SealedFrames("moss"));
      conn.onNotification((m, p) => fresh.notification(m, p));
      fresh.setConnection("connected");
      const from = e.calls().length;
      await fresh.attach(conn);
      const mine = e.calls().slice(from).map((c) => c.method);
      expect({ round, order: mine.indexOf("events.subscribe") < mine.indexOf("card.list") && mine.indexOf("events.subscribe") >= 0 }).toEqual({ round, order: true });
      await until(() => fresh.view().cards.some((c) => c.id === "card_juniper_raced"));
      const ids = fresh.view().cards.map((c) => c.id);
      // The one that was waiting at connect (the fixtures' Juniper card) and the raced one, each placed and drawn once.
      expect(ids.filter((id) => id === "card_juniper_book")).toHaveLength(1);
      expect(ids.filter((id) => id === "card_juniper_raced")).toHaveLength(1);
      expect(fresh.placementOf("card_juniper_raced")).toEqual({ kind: "conversation", program: "moss", window: "main" });
    }
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

describe("placements: an event always wins over a snapshot", () => {
  /** A client whose `card.placement` answers wait until the test lets each go; everything else answers at once. */
  function heldClient(card: unknown) {
    const answers: ((v: unknown) => void)[] = [];
    const client = {
      request: async <T,>(method: string): Promise<T> => {
        const plain: Record<string, unknown> = {
          "events.subscribe": { ok: true }, "bot.records": { bots: [] }, "bot.summaries": { summaries: [] }, "activity.list": { activity: [] },
          "card.list": { cards: [card] }, "point.active.list": { points: [] }, "command.list": { commands: [] },
        };
        if (method === "card.placement") return new Promise<T>((r) => answers.push(r as (v: unknown) => void));
        return (plain[method] ?? {}) as T;
      },
    };
    return { client, answers };
  }
  const card = sealedCard({ id: "card_snap", kind: "tool", computer: "Studio", session: "bot:juniper", bot: "juniper", origin: "user", issuedAt: Date.now(), expiresAt: null, fields: { title: { type: "text", text: "Snap" } }, options: [{ id: "allow_once", kind: "approve", label: "Approve" }] } as never);
  const conversation = { kind: "conversation", program: "moss", window: "main" } as const;
  const strip = { kind: "strip", program: "moss", window: "main" } as const;

  test("a card_placed that comes before an older card.placement answer keeps its place", async () => {
    const { client, answers } = heldClient(card);
    const engine = new MossEngine(new SealedFrames("moss"));
    const attached = engine.attach(client);
    await until(() => answers.length === 1);
    // The router moves the card (an event), then the snapshot it took before arrives.
    engine.notification("core.event", { type: "card_placed", card: "card_snap", place: strip });
    answers[0]!({ placements: [{ card: "card_snap", place: conversation }] });
    await attached;
    expect(engine.placementOf("card_snap")).toEqual(strip);
  });

  test("a snapshot fills in a card no event placed, never one already resolved, and a reconnect starts fresh", async () => {
    const { client, answers } = heldClient(card);
    const engine = new MossEngine(new SealedFrames("moss"));
    const attached = engine.attach(client);
    await until(() => answers.length === 1);
    answers[0]!({ placements: [{ card: "card_snap", place: conversation }, { card: "card_gone", place: strip }] });
    await attached;
    expect(engine.placementOf("card_snap")).toEqual(conversation);
    // Resolved, then a late snapshot names it: it stays gone.
    engine.notification("core.event", { type: "card_resolved", id: "card_snap", outcome: "approved" });
    engine.notification("core.event", { type: "card_requested", card: { ...card, id: "card_other" } });
    await until(() => answers.length === 2);
    answers[1]!({ placements: [{ card: "card_snap", place: conversation }] });
    await new Promise((r) => setTimeout(r, 20));
    expect(engine.placementOf("card_snap")).toBeUndefined();
    // A reconnect: what the last connection's events said is forgotten; the new snapshot places it.
    engine.notification("core.event", { type: "card_placed", card: "card_gone", place: { kind: "island" } });
    const again = heldClient(card);
    const reattached = engine.attach(again.client);
    await until(() => again.answers.length === 1);
    again.answers[0]!({ placements: [{ card: "card_gone", place: strip }] });
    await reattached;
    expect(engine.placementOf("card_gone")).toEqual(strip);
  });
});

describe("a bot's record: an event always wins over an answer taken before it", () => {
  function heldRecords() {
    const answers: ((v: unknown) => void)[] = [];
    const nova = { id: "nova", name: "Nova", mainSession: "b_nova", madeBy: { kind: "user" }, createdAt: 1, instructionsBytes: 0 };
    let holding = false;
    const client = {
      request: async <T,>(method: string): Promise<T> => {
        if (method === "bot.records" && holding) return new Promise<T>((r) => answers.push(r as (v: unknown) => void));
        const plain: Record<string, unknown> = { "events.subscribe": { ok: true }, "bot.records": { bots: [nova] }, "bot.summaries": { summaries: [] }, "activity.list": { activity: [] }, "card.list": { cards: [] }, "card.placement": { placements: [] }, "point.active.list": { points: [] }, "command.list": { commands: [] } };
        return (plain[method] ?? {}) as T;
      },
    };
    return { client, answers, nova, hold: () => { holding = true; } };
  }

  test("a Settings read answered after the bot was archived doesn't bring it back to the list (the archive row's flake)", async () => {
    const { client, answers, nova, hold } = heldRecords();
    const engine = new MossEngine(new SealedFrames("moss"));
    await engine.attach(client);
    expect(engine.view().bots.map((b) => b.id)).toEqual(["nova"]);
    hold();
    const page = engine.botRecord("nova");
    await until(() => answers.length === 1);
    // Archived while the page's read is on its way; then the read's answer, taken before, arrives.
    engine.notification("core.event", { type: "bot_record_removed", id: "nova" });
    answers[0]!({ bots: [nova] });
    expect(await page).toEqual({ waiting: true });
    expect(engine.view().bots).toEqual([]);
  });

  test("a read that fails (an engine too busy to answer in time) shows the record the events keep (the editor row's flake)", async () => {
    const { client, nova } = heldRecords();
    const engine = new MossEngine(new SealedFrames("moss"));
    await engine.attach(client);
    const failing = { request: async <T,>(method: string): Promise<T> => { if (method === "bot.records") throw new Error("timed out"); return client.request<T>(method); } };
    (engine as unknown as { client: unknown }).client = failing;
    expect(await engine.botRecord("nova")).toMatchObject({ id: "nova", name: nova.name });
  });
});

describe("MOSS with the background host (lane HS)", () => {
  test("Quit tells the engine pair.quit with no hand-over; a quit the engine asked for, or a closed window on macOS, tells nothing", async () => {
    const { tellQuit, windowsClosedQuits } = await import("../src/main/quit");
    const { e, client } = await setup();
    const lines: string[] = [];
    expect(await tellQuit({ client, engineAsked: false, log: (l) => lines.push(l) })).toBe("told");
    expect(e.calls().filter((c) => c.method === "pair.quit").map((c) => c.params)).toEqual([{ handOver: false }]);
    expect(await tellQuit({ client, engineAsked: true, log: (l) => lines.push(l) })).toBe("not-told");
    expect(await tellQuit({ client: undefined, engineAsked: false, log: (l) => lines.push(l) })).toBe("not-told");
    expect(e.calls().filter((c) => c.method === "pair.quit")).toHaveLength(1);
    // Closing MOSS's last window on macOS keeps MOSS running: no quit, so nothing is told.
    expect(windowsClosedQuits("darwin", false)).toBe(false);
    expect(windowsClosedQuits("linux", false)).toBe(true);
    expect(windowsClosedQuits("darwin", true)).toBe(true);
  });

  test("a host the engine gave up on is one plain notice in the window, from host.status at connect and from host_changed", async () => {
    const { HOST_DOWN_NOTICE } = await import("../src/main/engine");
    const { engine } = await setup();
    expect(engine.view().notice).toBeUndefined();
    engine.notification("core.event", { type: "host_changed", state: "absent", crashes: 3, since: 1, gaveUp: true });
    expect(engine.view().notice).toBe(HOST_DOWN_NOTICE);
    engine.notification("core.event", { type: "host_changed", state: "running", crashes: 0, since: 2 });
    expect(engine.view().notice).toBeUndefined();
    const h = mkdtempSync(join(tmpdir(), "ma-host-"));
    homes.push(h);
    const e2 = await startFakeEngine({ home: h, host: { state: "absent", crashes: 3, since: 1, gaveUp: true } });
    closers.push(() => e2.close());
    const c2 = (await dial(daemonEndpoint(h)))!;
    closers.push(() => c2.close());
    await c2.request("protocol.prove", { nonce: "n" });
    await c2.request("protocol.hello", mossHello(e2.token, "0.124.0", 1));
    const fresh = new MossEngine(new SealedFrames("moss"));
    await fresh.attach(c2);
    expect(fresh.view().notice).toBe(HOST_DOWN_NOTICE);
  });

  test("a card placed elsewhere (no window in front, no host) is told once; drawn again then elsewhere again, told again", async () => {
    const { engine } = await setup();
    const told: { id: string; botName?: string }[] = [];
    engine.onElsewhere((c) => told.push(c));
    engine.notification("core.event", { type: "card_placed", card: "card_juniper_book", place: { kind: "elsewhere" } });
    engine.notification("core.event", { type: "card_placed", card: "card_juniper_book", place: { kind: "elsewhere" } });
    expect(told).toEqual([{ id: "card_juniper_book", bot: "juniper", botName: "Juniper" }]);
    engine.notification("core.event", { type: "card_placed", card: "card_juniper_book", place: { kind: "conversation", program: "moss", window: "main" } });
    engine.notification("core.event", { type: "card_placed", card: "card_juniper_book", place: { kind: "elsewhere" } });
    expect(told).toHaveLength(2);
    // An unknown or answered card is never told.
    engine.notification("core.event", { type: "card_placed", card: "card_nobody", place: { kind: "elsewhere" } });
    expect(told).toHaveLength(2);
  });
});

describe("the status line's inputs", () => {
  test("the open bot's running call gives its safe detail only; its result clears it; no message is made of either", async () => {
    const { engine } = await setup([], undefined, { running: { juniper: { name: "mcp__moss__Browser", argsJson: JSON.stringify({ url: "https://www.example.com/a?secret=1" }), displayTitle: "Page reader" } } });
    const messages: string[] = [];
    engine.onMessage((_b, m) => messages.push(m.text));
    expect(engine.view().bots.find((b) => b.id === "juniper")?.detail).toBeUndefined();
    await engine.conversation("juniper");
    // The browser tool has no safe detail, only its title.
    await until(() => engine.view().bots.find((b) => b.id === "juniper")?.title === "Page reader");
    expect(engine.view().bots.find((b) => b.id === "juniper")).not.toHaveProperty("detail");
    expect(JSON.stringify(engine.view())).not.toContain("secret");
    expect(messages).toEqual([]);
  });
});
