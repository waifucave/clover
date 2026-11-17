// Reads by kind (spec revision 19, §3.6, G6), at the gates of the engine: a plugin reads a code session by `sessions.read`
// and a bot's conversation by `conversation.read`, never one for the other, whatever a call says about its own kind.
// The gates are the layer's per-request check (`capabilityRefusal`), the `core.event` sender (`sendCoreEvent`), and the
// list a plugin gets (cut to the kinds it reads).
import { describe, expect, test } from "bun:test";
import { MOSS_ERR, MOSS_EVENTS, type Caller, type MossRole } from "@waifucave/moss-protocol";
import { capabilityRefusal } from "../../src/auth/moss-caller";
import { sendCoreEvent } from "../../src/ipc/core-events";
import type { MossConn } from "../../src/ipc/moss";

const plugin = (pluginId: string): Caller => ({ kind: "plugin", pluginId });
const KINDS = { s_bot: "bots", s_side: "bots", s_code: "sessions", s_task: "sessions" } as const;
const targets = { sessionKind: (id: string) => (KINDS as Record<string, "bots" | "sessions">)[id] };

const CODE = ["sessions.read", "activity.read.sessions", "picture.read.sessions"];
const BOTS = ["conversation.read", "activity.read.bots", "picture.read.bots"];

describe("a session call is gated by the kind of the session it names", () => {
  const METHODS = ["session.get", "session.history", "session.attach", "session.diff", "session.outputs", "session.context", "session.connectors"] as const;

  test("conversation.read reads a bot's session and never a code session; sessions.read the reverse", () => {
    for (const m of METHODS) {
      expect([m, capabilityRefusal("layer", plugin("x"), m, ["conversation.read"], { id: "s_bot" }, targets)]).toEqual([m, null]);
      expect([m, capabilityRefusal("layer", plugin("x"), m, ["conversation.read"], { id: "s_code" }, targets)?.code]).toEqual([m, MOSS_ERR.CAPABILITY_REFUSED]);
      expect([m, capabilityRefusal("layer", plugin("x"), m, ["sessions.read"], { id: "s_code" }, targets)]).toEqual([m, null]);
      expect([m, capabilityRefusal("layer", plugin("x"), m, ["sessions.read"], { id: "s_bot" }, targets)?.code]).toEqual([m, MOSS_ERR.CAPABILITY_REFUSED]);
      // A bot's coding task is a code session; a bot's side thread is the bot's.
      expect([m, capabilityRefusal("layer", plugin("x"), m, ["sessions.read"], { id: "s_task" }, targets)]).toEqual([m, null]);
      expect([m, capabilityRefusal("layer", plugin("x"), m, ["sessions.read"], { id: "s_side" }, targets)?.code]).toEqual([m, MOSS_ERR.CAPABILITY_REFUSED]);
    }
  });

  test("what a call says about its kind is never believed: a `kind` param, a made-up id, no id", () => {
    // A `kind: "bots"` param doesn't turn a code session into a bot's.
    expect(capabilityRefusal("layer", plugin("x"), "session.history", ["conversation.read"], { id: "s_code", kind: "bots" }, targets)?.code).toBe(MOSS_ERR.CAPABILITY_REFUSED);
    // A session the engine doesn't know, or none named: refused (never read as "no kind, so anyone").
    expect(capabilityRefusal("layer", plugin("x"), "session.get", ["conversation.read", "sessions.read"], { id: "s_made_up" }, targets)?.code).toBe(MOSS_ERR.CAPABILITY_REFUSED);
    expect(capabilityRefusal("layer", plugin("x"), "session.get", ["conversation.read", "sessions.read"], {}, targets)?.code).toBe(MOSS_ERR.CAPABILITY_REFUSED);
    expect(capabilityRefusal("layer", plugin("x"), "session.get", ["conversation.read", "sessions.read"], { id: "s_bot" })?.code).toBe(MOSS_ERR.CAPABILITY_REFUSED);
  });

  test("a list passes for a plugin that reads either kind, and not for one that reads neither (an old grant)", () => {
    expect(capabilityRefusal("layer", plugin("x"), "session.list", ["conversation.read"], {}, targets)).toBeNull();
    expect(capabilityRefusal("layer", plugin("x"), "session.list", ["sessions.read"], {}, targets)).toBeNull();
    expect(capabilityRefusal("layer", plugin("x"), "session.list", ["notify"], {}, targets)?.code).toBe(MOSS_ERR.CAPABILITY_REFUSED);
    expect(capabilityRefusal("layer", plugin("x"), "session.list", [], {}, targets)?.code).toBe(MOSS_ERR.CAPABILITY_REFUSED);
  });

  test("the feed and the pictures are gated by the kind they name; the user's calls aren't a plugin's", () => {
    for (const [m, own, other] of [["activity.list", "activity.read.bots", "activity.read.sessions"], ["picture.list", "picture.read.sessions", "picture.read.bots"]] as const) {
      const kind = own.endsWith("bots") ? "bots" : "sessions";
      expect([m, capabilityRefusal("layer", plugin("x"), m, [own], { kind })]).toEqual([m, null]);
      expect([m, capabilityRefusal("layer", plugin("x"), m, [other], { kind })?.code]).toEqual([m, MOSS_ERR.CAPABILITY_REFUSED]);
      expect([m, capabilityRefusal("layer", plugin("x"), m, [own], {})?.code]).toEqual([m, MOSS_ERR.CAPABILITY_REFUSED]);
      expect([m, capabilityRefusal("layer", plugin("x"), m, [own], { kind: "everything" })?.code]).toEqual([m, MOSS_ERR.CAPABILITY_REFUSED]);
      expect([m, capabilityRefusal("app", { kind: "user", client: "app" }, m, [], { kind })]).toEqual([m, null]);
    }
  });
});

let seq = 0;
function layer(pluginId: string, areas: string[]) {
  const got: { type: string }[] = [];
  const c = {
    connId: ++seq, role: "layer" as MossRole, caller: plugin(pluginId), features: [], clientName: "layer", areas: new Set(areas), follows: new Map(),
    send: () => "x", notify: (_m: string, params: { type: string }) => void got.push(params),
  } as unknown as MossConn;
  return { c, got };
}

describe("a plugin never hears the other kind's events", () => {
  const session = (kind: string) => ({ ...(MOSS_EVENTS.get("session_changed")!.fixture as { session: object }).session, kind, id: `s_${kind}` });
  const event = {
    botSession: { type: "session_changed", ts: 1, session: session("bot") },
    sideThread: { type: "session_changed", ts: 1, session: session("side-thread") },
    codeSession: { type: "session_changed", ts: 1, session: session("coding") },
    task: { type: "session_changed", ts: 1, session: session("agent") },
    botActivity: { type: "activity_changed", ts: 1, activity: { subject: { kind: "bots", id: "alpha" }, state: "working", since: 1 } },
    codeActivity: { type: "activity_changed", ts: 1, activity: { subject: { kind: "sessions", id: "s_code" }, state: "thinking", since: 1 } },
    botPicture: { type: "picture_changed", ts: 1, picture: { id: "pic_abcdef", kind: "bots", session: "s_bot", publisher: "moss/browser", format: "jpeg", width: 10, height: 10, screen: false, startedAt: 1 } },
    codePicture: { type: "picture_changed", ts: 1, picture: { id: "pic_ghijkl", kind: "sessions", session: "s_code", publisher: "moss/browser", format: "jpeg", width: 10, height: 10, screen: false, startedAt: 1 } },
    botEnded: { type: "picture_ended", ts: 1, id: "pic_abcdef", kind: "bots", session: "s_bot", why: "publisher" },
    codeEnded: { type: "picture_ended", ts: 1, id: "pic_ghijkl", kind: "sessions", session: "s_code", why: "call-ended" },
  };

  test("a sessions.read-only plugin never receives a bot's events, and a conversation.read-only plugin never a code session's", () => {
    const code = layer("code-only", ["sessions", "activity"]);
    const bots = layer("bots-only", ["sessions", "activity"]);
    const old = layer("old-grant", ["sessions", "activity"]);
    const caps: Record<string, string[]> = { "code-only": CODE, "bots-only": BOTS, "old-grant": ["notify"] };
    const r = { connections: () => [code.c, bots.c, old.c], pluginCapabilities: (id: string) => caps[id] ?? [] };
    for (const e of Object.values(event)) sendCoreEvent(r, e);
    const names = (got: { type: string }[]) => got.map((e) => JSON.stringify(e).includes('"kind":"sessions"') || JSON.stringify(e).includes('"kind":"coding"') || JSON.stringify(e).includes('"kind":"agent"') ? "code" : "bot");
    expect(code.got.length).toBe(5);
    expect(new Set(names(code.got))).toEqual(new Set(["code"]));
    expect(bots.got.length).toBe(5);
    expect(new Set(names(bots.got))).toEqual(new Set(["bot"]));
    // A grant from before the split reads neither kind: it hears none of them.
    expect(old.got).toEqual([]);
  });

  test("an event of a family with no kind in its payload is heard by nobody (fails closed)", () => {
    const all = layer("everything", ["sessions", "activity"]);
    const r = { connections: () => [all.c], pluginCapabilities: () => [...CODE, ...BOTS] };
    expect(sendCoreEvent(r, { type: "activity_changed", ts: 1, activity: { subject: { kind: "bots", id: "alpha" }, state: "idle", since: 1 } })).toBe(1);
    // A malformed one doesn't parse, so it isn't sent at all.
    expect(sendCoreEvent(r, { type: "activity_changed", ts: 1, activity: { state: "idle" } })).toBe(0);
  });
});
