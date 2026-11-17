// A tool's live picture through the plugin API (spec revision 19, §3.6, G5), on the real stream hub, the real pictures and
// the real router gate: keyed to the tool call's session, whatever the publisher says; only the call's own declaring
// server; inert images no larger than declared; readers by kind; every way it ends.
import { describe, expect, test } from "bun:test";
import { PICTURE_FRAME_MAX_BYTES, type DataKind } from "@waifucave/moss-protocol";
import { createApiRouter } from "../../plugin-host/api/router";
import { StreamHub, type StreamEvent } from "../../streams/hub";
import { FrameCutter, lengthPrefixed, picturesApi } from "../api";
import { EngineLivePictures } from "../live-pictures";

const jpeg = (width = 1280, height = 800, n = 64) => {
  const b = new Uint8Array(n);
  b.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03]);
  return b;
};
const META = { format: "jpeg", width: 1280, height: 800 };
const SESSIONS: Record<string, { kind: DataKind; bot?: string }> = { s_alpha: { kind: "bots", bot: "alpha" }, s_code: { kind: "sessions" } };

const manifest = { contributes: { mcpServers: { cu: { type: "host", tools: { Click: "preload" }, picture: true }, plain: { type: "host", tools: { Look: "preload" } } } } };
const record = (id: string, granted: string[]) => ({ id, enabled: true, state: "running", granted, manifest });

function world() {
  const hub = new StreamHub();
  const pictures = new EngineLivePictures({ clock: { now: () => 1 } });
  const records = new Map<string, ReturnType<typeof record>>();
  const handlers = picturesApi({ pictures, hub, sessions: { get: (id) => SESSIONS[id] }, now: () => 1 });
  const router = createApiRouter({ registry: { get: (id: string) => records.get(id) as never }, handlers: [handlers], pictureKind: (id) => pictures.kindOf(id) });
  const plugin = (id: string, granted: string[] = []) => (records.set(id, record(id, granted)), id);
  const publish = async (over: { pluginId?: string; session?: string; server?: string; meta?: unknown; call?: string } = {}) => {
    const pluginId = over.pluginId ?? "acme-cu";
    if (!records.has(pluginId)) plugin(pluginId);
    const events: StreamEvent[] = [];
    const sessionId = over.session ?? "s_alpha";
    const stop = (await router({
      pluginId, process: "shared", path: "pictures.publish", args: [over.meta ?? META, (e: StreamEvent) => events.push(e)],
      caller: { kind: "session", sessionId, sessionKind: SESSIONS[sessionId]?.kind === "sessions" ? "coding" : "bot", ...(SESSIONS[sessionId]?.bot !== undefined ? { bot: SESSIONS[sessionId]!.bot } : {}) } as never,
      invocation: { id: over.call ?? "call_1", server: over.server ?? "cu", tool: "Click" },
    })) as () => void;
    const open = events.find((e) => e.type === "open") as { id: string } | undefined;
    const write = (frame: Uint8Array, raw = false) => hub.write(open!.id, { pluginId, side: "shared" }, raw ? frame : lengthPrefixed(frame));
    return { stop, events, streamId: open?.id, write };
  };
  const reader = (granted: string[], id = "reader") => {
    plugin(id, granted);
    const call = (path: string, args: unknown[]) => router({ pluginId: id, process: "shared", path, args, caller: { kind: "plugin", pluginId: id } });
    return { id, call };
  };
  return { hub, pictures, publish, reader, plugin };
}
const either = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e as { code?: string; message: string });

describe("a picture is the tool call's, whatever its publisher says", () => {
  test("it lands on the call's session with the engine's id and the publisher's plugin id; a meta that names a session is refused", async () => {
    const w = world();
    expect((await either(w.publish({ meta: { ...META, session: "s_other" } })))?.code).toBe("invalid");
    expect((await either(w.publish({ meta: { ...META, id: "pic_mine01" } })))?.code).toBe("invalid");
    expect(w.pictures.size).toBe(0);
    const p = await w.publish();
    const shown = w.pictures.list("bots", { kind: "user" });
    expect(shown).toEqual([expect.objectContaining({ session: "s_alpha", bot: "alpha", publisher: "acme-cu", tool: "Click", kind: "bots", screen: false })]);
    expect(shown[0]!.id).toMatch(/^pic_/);
    expect(p.streamId).toBeDefined();
    // Another session's tool call lands on that session, and a code session's picture is of the code kind.
    await w.publish({ pluginId: "other-cu", session: "s_code", call: "call_2" });
    expect(w.pictures.list("sessions", { kind: "user" }).map((v) => v.session)).toEqual(["s_code"]);
  });

  test("only the call's own server that declares a picture, only inside a tool call a session made", async () => {
    const w = world();
    expect((await either(w.publish({ server: "plain" })))?.message).toContain("declare");
    expect((await either(w.publish({ server: "missing" })))?.message).toContain("declare");
    // Outside any tool call (no invocation), or acting as the plugin, or for a session the engine doesn't know.
    w.plugin("acme-cu");
    const bare = { pluginId: "acme-cu", process: "shared" as const, path: "pictures.publish", args: [META, () => {}] };
    expect((await either(createApiRouter({ registry: { get: () => record("acme-cu", []) as never }, handlers: [picturesApi({ pictures: w.pictures, hub: w.hub, sessions: { get: (id) => SESSIONS[id] }, now: () => 1 })] })({ ...bare, caller: { kind: "plugin", pluginId: "acme-cu" } })))?.code).toBe("refused");
    expect((await either(w.publish({ session: "s_unknown" })))?.code).toBe("refused");
    expect(w.pictures.size).toBe(0);
  });
});

describe("frames are inert images no larger than declared", () => {
  test("whole frames are kept; a frame whose header claims more pixels, or that isn't an image, ends the picture", async () => {
    const w = world();
    const heard: unknown[] = [];
    w.pictures.watch("bots", { kind: "user" }, (e) => heard.push(e));
    const p = await w.publish();
    await p.write(jpeg(1280, 800, 100));
    const id = w.pictures.list("bots", { kind: "user" })[0]!.id;
    expect(w.pictures.open(id, { kind: "user" }).latest()?.length).toBe(100);
    await p.write(jpeg(9000, 9000));
    expect(heard.at(-1)).toEqual({ ended: id, why: "publisher" });
    // Not an image at all.
    const q = await w.publish({ call: "call_2" });
    await q.write(new TextEncoder().encode("<svg onload=alert(1)>"));
    expect(w.pictures.size).toBe(0);
  });

  test("a frame announced bigger than there is ends it too-large and cancels the stream; a frame split across pieces is whole", async () => {
    const w = world();
    const heard: unknown[] = [];
    w.pictures.watch("bots", { kind: "user" }, (e) => heard.push(e));
    const p = await w.publish();
    const frame = lengthPrefixed(jpeg(1280, 800, 300));
    await p.write(frame.subarray(0, 3), true);
    await p.write(frame.subarray(3, 150), true);
    await p.write(frame.subarray(150), true);
    const id = w.pictures.list("bots", { kind: "user" })[0]!.id;
    expect(w.pictures.open(id, { kind: "user" }).latest()?.length).toBe(300);
    const big = new Uint8Array(4);
    new DataView(big.buffer).setUint32(0, PICTURE_FRAME_MAX_BYTES + 1);
    await p.write(big, true);
    expect(heard.at(-1)).toEqual({ ended: id, why: "too-large" });
    expect(p.events.some((e) => e.type === "aborted")).toBe(true);
    expect(w.hub.size).toBe(0);
  });

  test("the cutter: no frame of no length, none over the most", () => {
    const c = new FrameCutter();
    expect(c.push(new Uint8Array([0, 0, 0, 0]), () => {})).toBe("bad");
    expect(new FrameCutter().push(lengthPrefixed(new Uint8Array(5)), () => {})).toBe("ok");
  });
});

describe("readers by kind", () => {
  test("a plugin reads only the kind it holds: list, watch and open are refused for the other", async () => {
    const w = world();
    await w.publish();
    await w.publish({ pluginId: "other-cu", session: "s_code", call: "call_2" });
    const botPic = w.pictures.list("bots", { kind: "user" })[0]!.id;
    const codePic = w.pictures.list("sessions", { kind: "user" })[0]!.id;
    const botsOnly = w.reader(["picture.read.bots"], "bots-reader");
    const codeOnly = w.reader(["picture.read.sessions"], "code-reader");
    const none = w.reader(["conversation.read", "sessions.read"], "no-pictures");
    expect(((await botsOnly.call("pictures.list", ["bots"])) as unknown[]).length).toBe(1);
    expect((await either(botsOnly.call("pictures.list", ["sessions"])))?.message).toContain("picture.read.sessions");
    expect((await either(botsOnly.call("pictures.list", [])))?.message).toContain("picture.read");
    expect((await either(botsOnly.call("pictures.watch", ["sessions", () => {}])))?.code).toBe("refused");
    expect((await either(botsOnly.call("pictures.open", [codePic, {}, () => {}])))?.code).toBe("refused");
    expect((await either(codeOnly.call("pictures.open", [botPic, {}, () => {}])))?.code).toBe("refused");
    expect((await either(none.call("pictures.list", ["bots"])))?.code).toBe("refused");
    expect((await either(none.call("pictures.list", ["sessions"])))?.code).toBe("refused");
    expect((await either(botsOnly.call("pictures.open", ["pic_nothere", {}, () => {}])))?.code).toBe("not_found");
    expect(((await codeOnly.call("pictures.list", ["sessions"])) as unknown[]).length).toBe(1);
  });

  test("a reader's stream carries the latest frames, each a length and an image, and ends with the picture", async () => {
    const w = world();
    const p = await w.publish();
    await p.write(jpeg(1280, 800, 200));
    const id = w.pictures.list("bots", { kind: "user" })[0]!.id;
    const r = w.reader(["picture.read.bots"]);
    const events: StreamEvent[] = [];
    const stop = (await r.call("pictures.open", [id, { maxFps: 30 }, (e: StreamEvent) => events.push(e)])) as () => void;
    await new Promise((resolve) => setTimeout(resolve, 5));
    const opened = events.find((e) => e.type === "opened") as { id: string };
    const frames: Uint8Array[] = [];
    const cutter = new FrameCutter();
    for (const e of events) if (e.type === "chunk") cutter.push(e.data, (f) => frames.push(f));
    expect(frames.map((f) => f.length)).toEqual([200]);
    expect(w.hub.ack(opened.id, { pluginId: "reader", side: "shared" }, 200)).toBeUndefined();
    // A later frame arrives; the picture ends; the reader hears the end.
    await p.write(jpeg(1280, 800, 300));
    await new Promise((resolve) => setTimeout(resolve, 40));
    p.stop();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(events.at(-1)?.type).toBe("end");
    stop();
  });
});

describe("every way a picture ends", () => {
  test("its publisher's end or stream going, its session ending, its plugin stopping, and the call it was tied to", async () => {
    const w = world();
    const ends: { ended: string; why: string }[] = [];
    w.pictures.watch("bots", { kind: "user" }, (e) => { if ("ended" in e) ends.push(e as never); });
    const a = await w.publish({ pluginId: "pub-a", call: "c_a" });
    const b = await w.publish({ pluginId: "pub-b", call: "c_b" });
    const c = await w.publish({ pluginId: "pub-c", call: "c_c", meta: { ...META, endsWithCall: true } });
    const d = await w.publish({ pluginId: "pub-d", call: "c_d" });
    const ids = Object.fromEntries(w.pictures.list("bots", { kind: "user" }).map((v) => [v.publisher, v.id]));
    // The call a picture isn't tied to ending leaves it up; the tied one ends.
    w.pictures.callEnded("c_a");
    w.pictures.callEnded("c_c");
    expect(ends).toEqual([{ ended: ids["pub-c"]!, why: "call-ended" }]);
    // The publisher's stream ending (its watch gone) ends it.
    a.stop();
    expect(ends.at(-1)).toEqual({ ended: ids["pub-a"]!, why: "publisher" });
    // The plugin stopping ends its picture and its stream.
    w.pictures.pluginStopped("pub-b");
    w.hub.endPlugin("pub-b", "stopped");
    expect(ends.at(-1)).toEqual({ ended: ids["pub-b"]!, why: "plugin-stopped" });
    // The session ending ends what is left of it.
    w.pictures.sessionEnded("s_alpha");
    expect(ends.at(-1)).toEqual({ ended: ids["pub-d"]!, why: "session" });
    expect(w.pictures.size).toBe(0);
    void b; void c; void d;
  });

  test("a second publisher (any plugin whose server declares one) is the same path, and its picture replaces only its own", async () => {
    const w = world();
    await w.publish({ pluginId: "moss/browser", call: "c_1" });
    await w.publish({ pluginId: "fixture-cu", call: "c_2" });
    await w.publish({ pluginId: "fixture-cu", call: "c_3" });
    expect(w.pictures.list("bots", { kind: "user" }).map((v) => v.publisher).sort()).toEqual(["fixture-cu", "moss/browser"]);
  });
});
