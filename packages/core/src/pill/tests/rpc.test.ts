// `pill.send` (../rpc.ts), called as the server calls it: the user's words from the Dispatch pill reach a bot's
// conversation or a session through lane D's session.send, a pill.target entry's handler as the plugin's own call, and
// only the user may send them.
import { afterEach, describe, expect, test } from "bun:test";
import { APP_METHODS, CLOVER_ERR, ERR, allowedMethods, type Caller, type MethodSpec } from "@waifucave/clover-protocol";
import type { z } from "zod";
import { flush } from "../../contracts/fakes/clock";
import type { Contribution } from "../../contracts/plugin-registry";
import type { InvokeRequest } from "../../contracts/plugin-host";
import { MethodError, sessionsMethods, type MethodContext } from "../../bots/rpc";
import { ALPHA_FOLDER, boot, pluginFromFolder, removeTemps, tempDir } from "../../bots/tests/fixtures";
import { FakeClock } from "../../contracts/fakes/clock";
import { pillMethods, withImageMarks } from "../rpc";

afterEach(removeTemps);

const M = APP_METHODS;
const theUser: Caller = { kind: "user", client: "app", device: "studio0000000000000" };
const aBot: Caller = { kind: "session", sessionId: "b_alpha", sessionKind: "bot", bot: "alpha" };
const aPlugin: Caller = { kind: "plugin", pluginId: "weather" };
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const LIGHTS: Contribution = { point: "ui", pluginId: "home", ref: "ui/0", entryId: "lights", value: { spot: "pill.target", component: "Lights", title: "Lights", handler: "lights" }, state: "active" };
const OFF: Contribution = { ...LIGHTS, entryId: "fan", value: { ...(LIGHTS.value as object), handler: "fan" }, state: "waiting" };

async function setup(withTargets = true) {
  const home = tempDir();
  const clock = new FakeClock();
  const b = await boot({ home, clock, plugins: (await pluginFromFolder(ALPHA_FOLDER, { bundled: true })).inputs });
  const sessions = sessionsMethods({ home, computer: "Studio", bots: b.bots, host: b.host, clock, localDevice: "studio0000000000000" });
  const invoked: InvokeRequest[] = [];
  const staged: string[] = [];
  const methods = pillMethods({
    bots: b.bots,
    sessions: { ...sessions, "session.stageImage": async (params, ctx) => (staged.push((params as { id: string }).id), sessions["session.stageImage"]!(params, ctx)) },
    sentAs: (id, clientMessageId) => b.host.sentAs(id, clientMessageId),
    ...(withTargets ? { targets: { registry: { entries: (point: string) => (point === "ui" ? [LIGHTS, OFF] : []) }, host: { invoke: async <R,>(r: InvokeRequest): Promise<R> => (invoked.push(r), undefined as R) } } } : {}),
  });
  const call = async <S extends MethodSpec>(spec: S, params: unknown, caller: Caller = theUser): Promise<z.output<S["result"]>> =>
    spec.result.parse(await methods[spec.name]!(params, { caller } as MethodContext)) as z.output<S["result"]>;
  const fails = async (params: unknown, caller: Caller = theUser): Promise<MethodError> => {
    const err = await methods[M.pillSend.name]!(params, { caller } as MethodContext).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(MethodError);
    return err as MethodError;
  };
  return { b, call, fails, invoked, staged };
}

describe("pill.send", () => {
  test("is the app's, as the user: the protocol keeps it from layers, and the handler refuses a bot or a plugin", async () => {
    expect(M.pillSend.roles).toEqual(["app"]);
    expect(M.pillSend.userOnly).toBe(true);
    expect(allowedMethods("layer").has("pill.send")).toBe(false);
    const { b, fails } = await setup();
    const words = { to: { bot: "alpha" }, text: "dim the lights", clientMessageId: "c-1" };
    expect((await fails(words, aBot)).code).toBe(CLOVER_ERR.NOT_THE_USER);
    expect((await fails(words, aPlugin)).code).toBe(CLOVER_ERR.NOT_THE_USER);
    await b.shutdown();
  });

  test("to a bot: the user's message in its one conversation, as the composer's session.send, deduplicated by the client's id", async () => {
    const { b, call, fails } = await setup();
    const words = { to: { bot: "alpha" }, text: "dim the lights", clientMessageId: "c-1" };
    const sent = await call(M.pillSend, words);
    expect(typeof sent.seq).toBe("number");
    expect(await call(M.pillSend, words)).toEqual(sent);
    await flush();
    expect(b.drivers.for("b_alpha").turns[0]!).toMatchObject({ origin: "user", input: { from: "user", text: "dim the lights", device: "studio0000000000000" } });
    expect(b.drivers.for("b_alpha").turns).toHaveLength(1);
    expect((await fails({ to: { bot: "nobody" }, text: "x", clientMessageId: "c-2" })).code).toBe(ERR.NOT_FOUND);
    // A bot asleep refuses as the composer's send does.
    b.drivers.for("b_alpha").end();
    await flush();
    b.host.setAsleep("b_alpha", true);
    expect((await fails({ to: { bot: "alpha" }, text: "x", clientMessageId: "c-3" })).code).toBe(CLOVER_ERR.BOT_ASLEEP);
    b.host.setAsleep("b_alpha", false);
    await b.shutdown();
  });

  test("to a session by id, and with pictures: staged first, each named in the text", async () => {
    const { b, call } = await setup();
    await call(M.pillSend, { to: { session: "b_alpha" }, text: "what's this?", images: [{ mediaType: "image/png", data: PNG }], clientMessageId: "c-4" });
    await flush();
    const input = b.drivers.for("b_alpha").turns[0]!.input as { text: string; images?: { n: number; path: string }[] };
    expect(input.text).toBe("what's this? [Image #1]");
    expect(input.images).toHaveLength(1);
    expect(input.images![0]!.path).toMatch(/\/images\/image_\d+\.png$/);
    expect(withImageMarks("see [Image #1] and", 2)).toBe("see [Image #1] and [Image #2]");
    expect(withImageMarks("", 1)).toBe("[Image #1]");
    await b.shutdown();
  });

  test("a resend with pictures is the first message: nothing staged again, the same seq, one turn", async () => {
    const { b, call, staged } = await setup();
    const words = { to: { bot: "alpha" }, text: "what's this?", images: [{ mediaType: "image/png", data: PNG }, { mediaType: "image/png", data: PNG }], clientMessageId: "c-11" };
    expect(b.host.sentAs("b_alpha", "c-11")).toBeUndefined();
    const first = await call(M.pillSend, words);
    expect(staged).toEqual(["b_alpha", "b_alpha"]);
    expect(b.host.sentAs("b_alpha", "c-11")).toEqual({ seq: first.seq! });
    expect(await call(M.pillSend, words)).toEqual(first);
    expect(staged).toHaveLength(2);
    // A new message stages its own; an id the host doesn't know answers nothing.
    await call(M.pillSend, { ...words, clientMessageId: "c-12" });
    expect(staged).toHaveLength(4);
    expect(b.host.sentAs("b_nobody", "c-11")).toBeUndefined();
    await flush();
    expect(b.drivers.for("b_alpha").turns.filter((t) => (t.input as { text?: string }).text === "what's this? [Image #1] [Image #2]").length).toBeGreaterThanOrEqual(1);
    await b.shutdown();
  });

  test("to a pill.target entry: its handler's send, as the plugin's own call; an entry not active or not there is not installed", async () => {
    const { b, call, fails, invoked } = await setup();
    expect(await call(M.pillSend, { to: { target: "home#lights" }, text: "dim to 30%", clientMessageId: "c-5" })).toEqual({});
    expect(invoked).toEqual([{ pluginId: "home", handler: "lights", method: "send", args: { text: "dim to 30%", device: "studio0000000000000" }, caller: { kind: "plugin", pluginId: "home" } }]);
    expect((await fails({ to: { target: "home#fan" }, text: "x", clientMessageId: "c-6" })).code).toBe(CLOVER_ERR.NOT_INSTALLED);
    expect((await fails({ to: { target: "home#nothing" }, text: "x", clientMessageId: "c-7" })).code).toBe(CLOVER_ERR.NOT_INSTALLED);
    expect((await fails({ to: { target: "home#lights" }, text: "x", images: [{ mediaType: "image/png", data: PNG }], clientMessageId: "c-8" })).code).toBe(ERR.INVALID_PARAMS);
    // Nothing reached a bot.
    await flush();
    expect(b.drivers.for("b_alpha").turns).toHaveLength(0);
    await b.shutdown();
  });

  test("without a plugin host, an entry is not installed and bots still get the user's words", async () => {
    const { b, call, fails } = await setup(false);
    expect((await fails({ to: { target: "home#lights" }, text: "x", clientMessageId: "c-9" })).code).toBe(CLOVER_ERR.NOT_INSTALLED);
    expect(typeof (await call(M.pillSend, { to: { bot: "alpha" }, text: "hi", clientMessageId: "c-10" })).seq).toBe("number");
    await b.shutdown();
  });
});
