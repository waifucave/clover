// Lane D's session-area methods (../rpc.ts), called as lane C's server will call them: params checked by each method's
// schema, results that parse with its result schema, callers checked again where it matters, and the error codes a
// client branches on.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLOVER_ERR, ERR, SENT_AT_WINDOW_MS, SESSIONS_METHODS as M, type Caller, type MethodSpec } from "@waifucave/clover-protocol";
import type { z } from "zod";
import type { Unsubscribe } from "../../contracts/common";
import { FakeClock, flush } from "../../contracts/fakes/clock";
import { FakeSessionDriver } from "../../contracts/fakes/session-host";
import type { WireEvent } from "../../sessions/wire";
import { botPaths } from "../paths";
import { MethodError, sessionsMethods, type MethodContext } from "../rpc";
import { ALPHA_FOLDER, boot, pluginFromFolder, removeTemps, tempDir } from "./fixtures";

afterEach(removeTemps);

const theUser: Caller = { kind: "user", client: "app" };
const thePhone: Caller = { kind: "user", client: "ios", device: "phone00000000000000" };
const aBot: Caller = { kind: "session", sessionId: "b_alpha", sessionKind: "bot", bot: "alpha" };
const aPlugin: Caller = { kind: "plugin", pluginId: "weather" };
const theCli: Caller = { kind: "user", client: "cli" };

async function setup() {
  const home = tempDir();
  const clock = new FakeClock();
  const b = await boot({ home, clock, plugins: (await pluginFromFolder(ALPHA_FOLDER, { bundled: true })).inputs });
  const methods = sessionsMethods({ home, bots: b.bots, host: b.host, clock, localDevice: "studio0000000000000" });
  const call = async <S extends MethodSpec>(spec: S, params: unknown, caller: Caller = theUser, ctx: Partial<MethodContext> = {}): Promise<z.output<S["result"]>> =>
    spec.result.parse(await methods[spec.name]!(params, { caller, ...ctx })) as z.output<S["result"]>;
  const fails = async (spec: MethodSpec, params: unknown, caller: Caller = theUser): Promise<MethodError> => {
    const err = await methods[spec.name]!(params, { caller }).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(MethodError);
    return err as MethodError;
  };
  return { home, clock, b, methods, call, fails };
}

describe("the sessions area's methods", () => {
  test("bot.list and bot.get show each bot with its state; an unknown bot is not found", async () => {
    const { b, call, fails } = await setup();
    expect(await call(M.botList, {})).toEqual({ bots: [b.bots.get("alpha")!] });
    expect(await call(M.botGet, { id: "alpha" })).toMatchObject({ bot: { id: "alpha", state: "idle", mainSession: "b_alpha" } });
    expect((await fails(M.botGet, { id: "nobody" })).code).toBe(ERR.NOT_FOUND);
    expect((await fails(M.botGet, { id: "Not An Id" })).code).toBe(ERR.INVALID_PARAMS);
    await b.shutdown();
  });

  test("bot.setUserLayer changes the layer for the user only", async () => {
    const { b, call, fails } = await setup();
    expect(await call(M.botSetUserLayer, { id: "alpha", patch: { name: "Ally", effort: "high" } })).toEqual({ applied: true });
    expect((await call(M.botGet, { id: "alpha" })).bot).toMatchObject({ name: "Ally", effort: "high", userLayer: ["name", "effort"] });
    expect((await fails(M.botSetUserLayer, { id: "alpha", patch: { name: "Evil" } }, aBot)).code).toBe(CLOVER_ERR.NOT_THE_USER);
    expect((await fails(M.botSetUserLayer, { id: "alpha", patch: { model: "not-a-model" } })).code).toBe(ERR.INVALID_PARAMS);
    await b.shutdown();
  });

  test("session.send is the user's message: stamped with its device, deduplicated, refused to bots and side threads", async () => {
    const { b, call, fails } = await setup();
    const message = { text: "hi", clientMessageId: "c-1" };
    const sent = await call(M.sessionSend, { id: "b_alpha", message }, thePhone);
    expect(await call(M.sessionSend, { id: "b_alpha", message }, thePhone)).toEqual(sent);
    await flush();
    expect(b.drivers.for("b_alpha").turns[0]!.input).toMatchObject({ from: "user", text: "hi", device: "phone00000000000000", sentAt: b.clock.now() });
    expect((await fails(M.sessionSend, { id: "b_alpha", message: { text: "  ", clientMessageId: "c-2" } })).code).toBe(ERR.INVALID_PARAMS);
    expect((await fails(M.sessionSend, { id: "b_alpha", message: { text: "x", clientMessageId: "c-3" } }, aBot)).code).toBe(CLOVER_ERR.NOT_THE_USER);
    expect((await fails(M.sessionSend, { id: "b_nobody", message: { text: "x", clientMessageId: "c-4" } })).code).toBe(ERR.NOT_FOUND);
    b.host.setAsleep("b_alpha", true);
    expect((await fails(M.sessionSend, { id: "b_alpha", message: { text: "x", clientMessageId: "c-5" } })).code).toBe(CLOVER_ERR.BOT_ASLEEP);
    b.host.setAsleep("b_alpha", false);
    const run = b.bots.runSideThread("alpha", { routine: "r_1", name: "Check", text: "Check." });
    await flush();
    const side = b.drivers.made.at(-1)!;
    expect((await fails(M.sessionSend, { id: side.ctx.sessionId, message: { text: "x", clientMessageId: "c-6" } })).code).toBe(ERR.INVALID_REQUEST);
    side.driver.end({ text: "ok" });
    await run;
    await b.shutdown();
  });

  test("session.send keeps the client's own send stamp inside the window, holds one outside it to the edge, and stamps a message without one as it arrives", async () => {
    // (Waiting messages then run in `(sentAt, device)` order: lane B's conformance suite, run on the durable host.)
    const { b, call } = await setup();
    const sent = b.clock.now() - 30_000;
    await call(M.sessionSend, { id: "b_alpha", message: { text: "from the phone", clientMessageId: "p", sentAt: sent } }, thePhone);
    await flush();
    expect(b.drivers.for("b_alpha").turns[0]!.input).toMatchObject({ sentAt: sent, device: "phone00000000000000" });
    b.drivers.for("b_alpha").end();
    await flush();
    await call(M.sessionSend, { id: "b_alpha", message: { text: "no clock", clientMessageId: "n" } });
    await flush();
    expect(b.drivers.for("b_alpha").turns[1]!.input).toMatchObject({ sentAt: b.clock.now() });
    b.drivers.for("b_alpha").end();
    await flush();
    await call(M.sessionSend, { id: "b_alpha", message: { text: "from 2023", clientMessageId: "o", sentAt: 1_700_000_000_000 } }, thePhone);
    await flush();
    expect(b.drivers.for("b_alpha").turns[2]!.input).toMatchObject({ sentAt: b.clock.now() - SENT_AT_WINDOW_MS });
    await b.shutdown();
  });

  test("session.post is a plugin's note or message; the turn a message starts is the plugin's", async () => {
    const { b, call, fails } = await setup();
    await call(M.sessionPost, { id: "b_alpha", kind: "note", text: "Rain after 4", label: "Forecast" }, aPlugin);
    await call(M.sessionPost, { id: "b_alpha", kind: "message", text: "Storm alert" }, aPlugin);
    await flush();
    expect(b.drivers.for("b_alpha").turns.map((t) => [t.origin, t.input.from])).toEqual([["plugin", "plugin"]]);
    expect(b.drivers.for("b_alpha").turns[0]!.folded).toMatchObject([{ from: "note", label: "Forecast" }]);
    const { events } = await call(M.sessionHistory, { id: "b_alpha", limit: 10 });
    expect(events.filter((e) => e.type === "note" || e.type === "plugin_message")).toMatchObject([
      { type: "note", from: { kind: "plugin", pluginId: "weather" }, label: "Forecast", text: "Rain after 4" },
      { type: "plugin_message", from: { kind: "plugin", pluginId: "weather" }, text: "Storm alert" },
    ]);
    expect((await fails(M.sessionPost, { id: "b_alpha", kind: "note", text: "x" }, theUser)).code).toBe(ERR.INVALID_REQUEST);
    await b.shutdown();
  });

  test("session.history pages back from the newest events; a plugin never reads a card's sealed parts", async () => {
    const { b, call } = await setup();
    for (const text of ["one", "two", "three"]) {
      await call(M.sessionSend, { id: "b_alpha", message: { text, clientMessageId: text } });
      await flush();
      const d = b.drivers.for("b_alpha");
      d.emit({ type: "approval_requested", callId: `call_${text}`, toolName: "Bash", summary: `rm ${text}` });
      d.end({ text: `done ${text}` });
      await flush();
    }
    const last = await call(M.sessionHistory, { id: "b_alpha", limit: 2 });
    expect(last.events.map((e) => e.type)).toEqual(["approval_requested", "turn_completed"]);
    expect(last.hasMore).toBe(true);
    const all = await call(M.sessionHistory, { id: "b_alpha", limit: 500 });
    expect(all.hasMore).toBe(false);
    expect(all.events.map((e) => e.type)).toEqual([
      "assistant_message", // the greeting
      ...["one", "two", "three"].flatMap(() => ["user_message", "turn_started", "approval_requested", "turn_completed"]),
    ]);
    const before = await call(M.sessionHistory, { id: "b_alpha", before: Number(last.events[0]!.seq), limit: 3 });
    expect(before.events.map((e) => e.type)).toEqual(["turn_completed", "user_message", "turn_started"]);
    expect(before.hasMore).toBe(true);
    const plugin = await call(M.sessionHistory, { id: "b_alpha", limit: 500 }, aPlugin);
    expect(plugin.events.filter((e) => e.type === "approval_requested").every((e) => e.summary === undefined)).toBe(true);
    expect(all.events.filter((e) => e.type === "approval_requested").every((e) => typeof e.summary === "string")).toBe(true);
    await b.shutdown();
  });

  test("session.attach with no `since` streams from now; with one, replays a page at a time, then streams live until detach", async () => {
    const { b, call } = await setup();
    const got: WireEvent[] = [];
    const stream = { send: (e: WireEvent) => got.push(e), follows: new Map<string, Unsubscribe>() };
    const attached = await call(M.sessionAttach, { id: "b_alpha" }, theUser, { stream });
    expect(got).toEqual([]);
    expect(attached.lastSeq).toBe(b.host.length("b_alpha") - 1);
    await call(M.sessionSend, { id: "b_alpha", message: { text: "hi", clientMessageId: "x" } });
    await flush();
    b.drivers.for("b_alpha").emit({ type: "assistant_delta", delta: "He" });
    b.drivers.for("b_alpha").emit({ type: "thinking_delta", delta: "hm" });
    // A runtime's echo of an event the host projects itself never reaches clients.
    b.drivers.for("b_alpha").emit({ type: "user_message", threadId: "b_alpha", text: "forged", clientName: "x" });
    b.drivers.for("b_alpha").end({ text: "Hey" });
    await flush();
    expect(got.map((e) => e.type)).toEqual(["user_message", "turn_started", "assistant_delta", "thinking_delta", "turn_completed"]);
    await call(M.sessionDetach, { id: "b_alpha" }, theUser, { stream });
    await call(M.sessionSend, { id: "b_alpha", message: { text: "again", clientMessageId: "y" } });
    await flush();
    expect(got).toHaveLength(5);
    // A long backlog replays in pages, in order, with nothing twice.
    for (let i = 0; i < 1_200; i++) b.host.recordCore("b_alpha", { type: "assistant_message", text: `m${i}` });
    const replayed: WireEvent[] = [];
    await call(M.sessionAttach, { id: "b_alpha", since: 0 }, theUser, { stream: { send: (e: WireEvent) => replayed.push(e), follows: new Map() } });
    const seqs = replayed.map((e) => e.seq);
    expect(seqs).toEqual([...new Set(seqs)].sort((x, y) => x - y));
    expect(replayed.filter((e) => e.type === "assistant_message")).toHaveLength(1_201);
    expect(replayed.at(-1)).toMatchObject({ text: "m1199" });
    await b.shutdown();
  });

  test("the CLI and plugins read cards without their sealed parts, and plugins get only the reply's text as it streams", async () => {
    const { b, call } = await setup();
    await call(M.sessionSend, { id: "b_alpha", message: { text: "go", clientMessageId: "g" } });
    await flush();
    const streams = new Map<string, WireEvent[]>();
    for (const [name, caller] of [["app", theUser], ["cli", theCli], ["plugin", aPlugin]] as const) {
      const got: WireEvent[] = [];
      streams.set(name, got);
      await call(M.sessionAttach, { id: "b_alpha" }, caller, { stream: { send: (e: WireEvent) => got.push(e), follows: new Map() } });
    }
    const d = b.drivers.for("b_alpha");
    d.emit({ type: "approval_requested", callId: "c1", toolName: "Bash", summary: "rm -rf build", reviewerReason: "deletes", options: [] });
    d.emit({ type: "assistant_delta", delta: "Do" });
    d.emit({ type: "thinking_delta", delta: "hm" });
    await flush();
    const card = (name: string) => streams.get(name)!.find((e) => e.type === "approval_requested")!;
    expect(card("app")).toMatchObject({ summary: "rm -rf build" });
    for (const name of ["cli", "plugin"]) expect(card(name).summary).toBeUndefined();
    expect(streams.get("app")!.map((e) => e.type)).toContain("thinking_delta");
    expect(streams.get("plugin")!.map((e) => e.type)).toEqual(["approval_requested", "assistant_delta"]);
    await b.shutdown();
  });

  test("only a client on this computer sends images, and only files it may", async () => {
    const { b, fails, home } = await setup();
    const message = { text: "look [Image #1]", clientMessageId: "i1", images: [{ n: 1, path: join(home, "user-layers", "alpha.json") }] };
    const remote = await fails(M.sessionSend, { id: "b_alpha", message }, thePhone);
    expect(remote.code).toBe(ERR.INVALID_PARAMS);
    expect(remote.message).toContain("isn't an image this device staged for this session");
    // Here, a file inside the Clover home is no image of the user's.
    expect((await fails(M.sessionSend, { id: "b_alpha", message })).code).toBe(ERR.INVALID_PARAMS);
    expect(b.host.history("b_alpha").some((r) => r.type === "input")).toBe(false);
    await b.shutdown();
  });

  test("session.stageImage is the user's; a phone names exactly the images it staged in that session, never its own files", async () => {
    const { b, call, fails } = await setup();
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    const stage = { id: "b_alpha", mediaType: "image/png", dataBase64: png };
    expect((await fails(M.sessionStageImage, stage, aPlugin)).code).toBe(CLOVER_ERR.NOT_THE_USER);
    expect((await fails(M.sessionStageImage, stage, aBot)).code).toBe(CLOVER_ERR.NOT_THE_USER);
    // The bytes must be the type they say.
    expect((await fails(M.sessionStageImage, { ...stage, mediaType: "image/jpeg" }, thePhone)).code).toBe(ERR.INVALID_PARAMS);
    const { path } = await call(M.sessionStageImage, stage, thePhone);
    expect(path).toMatch(/\/images\/image_\d+\.png$/);
    const send = (n: number, p: string, clientMessageId: string) => ({ id: "b_alpha", message: { text: `look [Image #${n}]`, clientMessageId, images: [{ n, path: p }] } });
    // Another device, or the app on another computer, can't name the phone's image; nor can the phone name another's.
    const otherPhone: Caller = { kind: "user", client: "ios", device: "phone11111111111111" };
    expect((await fails(M.sessionSend, send(1, path, "p0"), otherPhone)).message).toContain("this device staged");
    const { path: appPath } = await call(M.sessionStageImage, stage);
    expect((await fails(M.sessionSend, send(1, appPath, "p1"), thePhone)).message).toContain("this device staged");
    // Its own image goes.
    await call(M.sessionSend, send(1, path, "p2"), thePhone);
    await flush();
    const input = b.host.history("b_alpha").find((r) => r.type === "input");
    expect(input?.type === "input" && input.input.from === "user" && input.input.images).toEqual([{ n: 1, path }]);
    // The app here names any staged copy for this session, as before.
    await call(M.sessionSend, send(1, appPath, "p3"));
    // A session this computer doesn't hold isn't staged for.
    expect((await fails(M.sessionStageImage, { ...stage, id: "s_nosuch" }, thePhone)).code).toBe(ERR.NOT_FOUND);
    b.host.open({ id: "s_box", kind: "agent", bot: "alpha", parent: "b_alpha", computer: "Box", backend: "codex" }, new FakeSessionDriver({ canFold: false }));
    const here = sessionsMethods({ home: tempDir(), computer: "Studio", bots: b.bots, host: b.host, clock: new FakeClock(), localDevice: "studio0000000000000" });
    const elsewhere = await here[M.sessionStageImage.name]!({ ...stage, id: "s_box" }, { caller: thePhone }).catch((e: unknown) => e);
    expect(elsewhere instanceof MethodError && elsewhere.message).toContain("runs on Box");
    await b.shutdown();
  });

  test("session.interrupt and session.stop are the user's; a bot's conversation is interrupted, never stopped", async () => {
    const { b, call, fails } = await setup();
    await call(M.sessionSend, { id: "b_alpha", message: { text: "go", clientMessageId: "g" } });
    await flush();
    expect((await fails(M.sessionInterrupt, { id: "b_alpha" }, aPlugin)).code).toBe(CLOVER_ERR.NOT_THE_USER);
    await call(M.sessionInterrupt, { id: "b_alpha" });
    await flush();
    expect(b.drivers.for("b_alpha").interrupts).toBe(1);
    expect((await fails(M.sessionStop, { id: "b_alpha" })).code).toBe(ERR.INVALID_REQUEST);
    const run = b.bots.runSideThread("alpha", { routine: "r_1", name: "Long", text: "Long job." });
    await flush();
    const side = b.drivers.made.at(-1)!;
    await call(M.sessionStop, { id: side.ctx.sessionId });
    expect(await run).toMatchObject({ outcome: "failed", summary: "The run was stopped." });
    expect((await call(M.sessionGet, { id: side.ctx.sessionId })).session.status).toBe("stopped");
    expect((await call(M.sessionList, { bot: "alpha", kinds: ["side-thread"] })).sessions.map((s) => s.id)).toEqual([side.ctx.sessionId]);
    await b.shutdown();
  });

  test("memory.list shows MEMORY.md first; memory.read stays inside the bot's memory", async () => {
    const { home, b, call, fails } = await setup();
    const dir = botPaths(home, "alpha").memory;
    mkdirSync(join(dir, "people"), { recursive: true });
    writeFileSync(join(dir, "people", "sam.md"), "Sam likes trains.");
    writeFileSync(join(dir, "a-note.md"), "A note.");
    symlinkSync(join(home, "transcripts"), join(dir, "escape"));
    const { entries } = await call(M.memoryList, { bot: "alpha" });
    expect(entries.map((e) => e.path)).toEqual(["MEMORY.md", "a-note.md", "people/sam.md"]);
    expect(await call(M.memoryRead, { bot: "alpha", path: "people/sam.md" })).toEqual({ text: "Sam likes trains." });
    expect((await fails(M.memoryRead, { bot: "alpha", path: "../user-layers/alpha.json" })).code).toBe(ERR.INVALID_PARAMS);
    expect((await fails(M.memoryRead, { bot: "alpha", path: "escape/alpha/bot.json" })).code).toBe(ERR.INVALID_PARAMS);
    expect((await fails(M.memoryRead, { bot: "alpha", path: "missing.md" })).code).toBe(ERR.NOT_FOUND);
    expect((await fails(M.memoryList, { bot: "nobody" })).code).toBe(ERR.NOT_FOUND);
    await b.shutdown();
  });
});
