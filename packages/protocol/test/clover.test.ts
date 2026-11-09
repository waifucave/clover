// Clover's protocol tables (spec revision 17): names, fixtures, owners, and the allow lists' safety properties.
// These pin the contract every lane builds against; a change here is a contract change (plan §3, via the controller).
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  AREA_EVENTS, AREA_METHODS, CLOVER_AREAS, CLOVER_EVENTS, CLOVER_METHODS, CloverCoreEvent, daemonProofInput,
  PEER_CALL_ROLES, allowedEvents, allowedMethods, daemonRequestsTo, decodeCloverCoreEvent, peerCallVerdict, pluginMayCall,
} from "../src/clover";
import { CloverSessionEvent, SENT_AT_WINDOW_MS, SessionView, clampSentAt, userMessageHashInput, userMessageSigningInput } from "../src/sessions";
import { Caller as CallerSchema, DeviceOs, Os, isComputerOs } from "../src/common";
import { DeviceView, LeaseView, PEER_STREAM_GRANTS } from "../src/devices";
import { NeedsAnswer } from "../src/computers";
import { CallBinding, TREE_TRANSFER, TreeTransferParams } from "../src/approvals";
import { paramsFor } from "../src/rpc";
import {
  AnyPluginId, Caller, ComputerName, LANES, LEVELS, TopPluginId, TreePath, isAnyPluginId, isPluginId, fenceVerdict, levelAbove,
  pluginIdFromSegment, pluginIdToSegment, topPluginIdOf,
} from "../src/common";
import { CLOVER_ROLES, CloverHelloParams, PLUGIN_ROLES, REMOTE_ROLES, USER_ROLES, helloVersionServed, type CloverRole } from "../src/roles";
import { CLOVER_ERR, CLOVER_PROTOCOL_MIN_VERSION, CLOVER_PROTOCOL_VERSION, HOST_PROCESSES } from "../src/common";
import { METHODS, STAGE_IMAGE_B64_MAX_LENGTH, SessionEvent } from "../src/index";
import { CARD_ANSWER_SKEW_MS, SealedValue, answerTimeOk, canonicalJson, cardAnswerSigningInput, cardContentInput, cardHashInput } from "../src/approvals";
import { buildCloverArtifacts } from "../scripts/clover-artifacts";
import { isBrowserUrlAllowed, isCdpMethodAllowed } from "../src/browser";

const methods = [...CLOVER_METHODS.values()];
const events = [...CLOVER_EVENTS.values()];
const calls = (role: CloverRole) => allowedMethods(role);

describe("ids", () => {
  test("plugin ids follow §5.1: lowercase letters, digits, single hyphens, a letter first, 2–40", () => {
    for (const ok of ["ab", "alpha", "mcp-blender", "a1", "x".repeat(40), "skill-pdf-2"]) expect(isPluginId(ok)).toBe(true);
    for (const bad of ["a", "Alpha", "1abc", "a_b", "a.b", "a--b", "-ab", "ab-", "x".repeat(41), "", "ab/cd"]) expect(isPluginId(bad)).toBe(false);
  });

  test("a child is <parent>/<folder>, one level deep, and its / is written -- in paths and origins", () => {
    expect(isAnyPluginId("luna/tarot-panel")).toBe(true);
    expect(isAnyPluginId("luna/tarot-panel/deeper")).toBe(false);
    expect(isAnyPluginId("luna/T")).toBe(false);
    expect(pluginIdToSegment("luna/tarot-panel")).toBe("luna--tarot-panel");
    expect(pluginIdFromSegment("luna--tarot-panel")).toBe("luna/tarot-panel");
    expect(pluginIdToSegment("alpha")).toBe("alpha");
    expect(topPluginIdOf("pack/luna")).toBe("pack");
    expect(AnyPluginId.safeParse("pack/luna").success).toBe(true);
    expect(AnyPluginId.safeParse("pack/l").success).toBe(false);
    expect(TopPluginId.safeParse("pack/luna").success).toBe(false);
  });

  test("computer names are letters, digits and hyphens; tree paths start with home/ or bots/", () => {
    expect(ComputerName.safeParse("Desktop1").success).toBe(true);
    expect(ComputerName.safeParse("my-mac").success).toBe(true);
    expect(ComputerName.safeParse("my mac").success).toBe(false);
    expect(ComputerName.safeParse("my_mac").success).toBe(false);
    expect(TreePath.safeParse("home/Desktop1/project1").success).toBe(true);
    expect(TreePath.safeParse("bots/alpha/memory/MEMORY.md").success).toBe(true);
    expect(TreePath.safeParse("/Users/me").success).toBe(false);
    expect(TreePath.safeParse("homes/x").success).toBe(false);
  });

  test("levels are ordered lowest first, and raising one is detectable", () => {
    expect(LEVELS).toEqual(["read-only", "ask", "ask-risky", "accept-edits", "automatic"]);
    expect(levelAbove("automatic", "ask-risky")).toBe(true);
    expect(levelAbove("ask", "ask-risky")).toBe(false);
  });

  test("a caller is the user and the client, a session, a plugin, or the core", () => {
    expect(Caller.safeParse({ kind: "user", client: "app" }).success).toBe(true);
    expect(Caller.safeParse({ kind: "session", sessionId: "s_1", sessionKind: "agent", bot: "alpha" }).success).toBe(true);
    expect(Caller.safeParse({ kind: "plugin", pluginId: "luna/tarot-panel" }).success).toBe(true);
    expect(Caller.safeParse({ kind: "bot", id: "alpha" }).success).toBe(false);
  });
});

describe("the method table", () => {
  test("every method has a dotted name, an owner lane, at least one role and a doc", () => {
    for (const m of methods) {
      expect(m.name).toMatch(/^[a-z][A-Za-z]*(\.[a-z][A-Za-z]*)+$/);
      expect(LANES).toContain(m.owner);
      expect(m.roles.length).toBeGreaterThan(0);
      for (const r of m.roles) expect(CLOVER_ROLES).toContain(r);
      expect(m.doc.length).toBeGreaterThan(10);
    }
  });

  test("names are unique (the table would not build otherwise) and every area file contributes", () => {
    const total = Object.values(AREA_METHODS).reduce((n, area) => n + Object.keys(area).length, 0);
    expect(CLOVER_METHODS.size).toBe(total + 4); // + protocol.hello, protocol.prove, events.subscribe, events.unsubscribe
    for (const area of CLOVER_AREAS) expect(Object.keys(AREA_METHODS[area]).length).toBeGreaterThan(0);
  });

  test("these Clover methods reuse an inherited method's name; C1 replaces the inherited ones with them, never both", () => {
    const inherited = new Set<string>(Object.values(METHODS));
    const reused = methods.map((m) => m.name).filter((n) => inherited.has(n)).sort();
    expect(reused).toEqual([
      "plugin.install", "plugin.list", "plugin.restart", "plugin.update", "protocol.hello",
      "session.attach", "session.compact", "session.history", "session.interrupt", "session.list",
      "session.send", "session.setModel", "session.stageImage", "sync.heads", "sync.pull", "sync.push", "usage.summary",
      "memory.list", "memory.read",
    ].sort());
  });

  test("every params and result schema converts to JSON Schema", () => {
    for (const m of methods) {
      expect(() => z.toJSONSchema(m.params, { unrepresentable: "any" })).not.toThrow();
      expect(() => z.toJSONSchema(m.result, { unrepresentable: "any" })).not.toThrow();
    }
  });

  test("requests the daemon sends go only to roles that serve them: the app, the plugin host and peers", () => {
    for (const m of methods.filter((x) => x.direction === "from-daemon")) {
      for (const r of m.roles) expect(["app", "plugin-host", "peer"]).toContain(r);
    }
    expect([...daemonRequestsTo("app")]).toContain("app.tab.command");
    expect([...daemonRequestsTo("plugin-host")]).toContain("pluginHost.invoke");
    expect(daemonRequestsTo("web").size).toBe(0);
  });
});

describe("the event table", () => {
  test("every fixture parses with its own schema, and its type matches", () => {
    for (const e of events) {
      const parsed = e.schema.safeParse(e.fixture);
      if (!parsed.success) throw new Error(`${e.type}: ${JSON.stringify(parsed.error.issues)}`);
      expect((e.fixture as { type: string }).type).toBe(e.type);
    }
  });

  test("Clover's event types never repeat one of the inherited SessionEvent types", () => {
    const inherited = new Set(SessionEvent.options.map((o) => (o.shape.type as z.ZodLiteral<string>).value));
    for (const e of events) expect(inherited.has(e.type)).toBe(false);
  });

  test("core events decode as one union; session events as Clover's session union", () => {
    for (const e of events) {
      if (e.scope === "core") expect(CloverCoreEvent.safeParse(e.fixture).success).toBe(true);
      else expect(CloverSessionEvent.safeParse(e.fixture).success).toBe(true);
    }
    const sessionTypes = events.filter((e) => e.scope === "session").map((e) => e.type).sort();
    expect(sessionTypes).toEqual(["agent_finished", "agent_message", "bot_message", "note", "plugin_message", "routine_result"]);
  });

  test("every area has events, and each event names an owner and roles", () => {
    for (const area of CLOVER_AREAS) expect(Object.keys(AREA_EVENTS[area]).length).toBeGreaterThan(0);
    for (const e of events) {
      expect(LANES).toContain(e.owner);
      expect(e.roles.length).toBeGreaterThan(0);
    }
  });
});

describe("the allow lists", () => {
  test("the bridge reaches only its own tools, SendMessage and Glossary (§9.3)", () => {
    expect([...calls("bridge")].sort()).toEqual(["bridge.call", "bridge.sendMessage", "bridge.tools", "glossary.query", "protocol.hello"]);
    expect(allowedEvents("bridge").size).toBe(0);
  });

  test("the web page's list is a strict subset of the iOS app's (§10)", () => {
    const remote = calls("remote");
    const web = calls("web");
    for (const m of web) expect(remote.has(m)).toBe(true);
    expect(web.size).toBeLessThan(remote.size);
  });

  test("the web page answers no card and changes no device, plugin or permission (§14.2 item 5)", () => {
    for (const name of calls("web")) {
      const m = CLOVER_METHODS.get(name)!;
      expect(m.change).toBeUndefined();
      expect(name.startsWith("card.")).toBe(false);
      expect(name.startsWith("device.")).toBe(false);
      expect(name.startsWith("plugin.")).toBe(false);
    }
  });

  test("only sealed frames and paired devices' apps answer cards: never a layer, the plugin host, the CLI or the web (§5.5)", () => {
    const answerers = CLOVER_METHODS.get("card.answer")!.roles;
    expect([...answerers].sort()).toEqual(["app", "peer", "remote"]);
    expect(CLOVER_METHODS.get("card.list")!.roles).not.toContain("layer");
    expect(CLOVER_METHODS.get("card.list")!.roles).not.toContain("plugin-host");
  });

  test("a plugin's calls never make a sensitive change, mint a token, or install a plugin as its own OK (§5.5)", () => {
    for (const role of PLUGIN_ROLES) {
      for (const name of calls(role)) {
        const m = CLOVER_METHODS.get(name)!;
        expect(m.change).not.toBe("sensitive");
        expect(["layer.token", "plugin.dev.add", "card.answer", "card.list"]).not.toContain(name);
      }
    }
    // A layer installs only with the bundled-only `plugins.install` (the plugin index browser), and what it installs
    // lands found with its sealed OK card (F-M2's review, S1); the plugin host never installs.
    expect(calls("plugin-host")).not.toContain("plugin.install");
    expect(CLOVER_METHODS.get("plugin.install")!.capability).toBe("plugins.install");
  });

  test("a plugin's call needs a capability unless it becomes a card, is its own confirm, or is the host channel", () => {
    const free = new Set(["protocol.hello", "events.subscribe", "events.unsubscribe", "card.confirm"]);
    for (const role of PLUGIN_ROLES) {
      for (const name of calls(role)) {
        const m = CLOVER_METHODS.get(name)!;
        const ok = m.capability !== undefined || m.change !== undefined || free.has(name) || name.startsWith("pluginHost.");
        if (!ok) throw new Error(`${role} may call ${name} with no capability`);
      }
    }
  });

  test("the plugin host speaks only its channel, and hears nothing else (review S3)", () => {
    for (const name of calls("plugin-host")) expect(name === "protocol.hello" || name.startsWith("pluginHost.")).toBe(true);
    for (const name of daemonRequestsTo("plugin-host")) expect(name.startsWith("pluginHost.")).toBe(true);
    for (const e of CLOVER_EVENTS.values()) expect(e.roles).not.toContain("plugin-host");
    // Each plugin-host connection is bound to its process, which the core decided (the owner's answer to S4).
    expect(CloverHelloParams.safeParse({ protocolVersion: 1, role: "plugin-host", token: "t", clientName: "host", hostProcess: "clover" }).success).toBe(true);
    expect(CloverHelloParams.safeParse({ protocolVersion: 1, role: "plugin-host", token: "t", clientName: "host", hostProcess: "mine" }).success).toBe(false);
    expect([...HOST_PROCESSES]).toEqual(["clover", "shared", "own"]);
    expect(Object.keys((CLOVER_METHODS.get("pluginHost.start")!.params as z.ZodObject).shape)).toContain("process");
    expect(CLOVER_ERR.PROCESS_REFUSED).toBe(-32020);
    // Every call it makes for a plugin names the plugin, which the host stamps from its worker table.
    for (const name of ["pluginHost.api", "pluginHost.unwatch", "pluginHost.state", "pluginHost.log"]) {
      expect(Object.keys((CLOVER_METHODS.get(name)!.params as z.ZodObject).shape)).toContain("pluginId");
    }
  });

  test("what M1 needs: a plugin's settings and sign-ins, the archive, and devices for layers (review S16)", () => {
    for (const name of ["plugin.settings.get", "plugin.settings.set", "plugin.auth.list", "plugin.auth.signIn", "plugin.auth.signOut", "archive.list", "archive.history"]) {
      expect(CLOVER_METHODS.has(name)).toBe(true);
    }
    // A key goes in and never comes back; only the user signs in, and a layer's setting is a card.
    expect(Object.keys((CLOVER_METHODS.get("plugin.auth.signIn")!.result as z.ZodObject).shape).sort()).toEqual(["authorizeUrl", "state"]);
    expect(CLOVER_METHODS.get("plugin.auth.signIn")!.roles).not.toContain("layer");
    expect(CLOVER_METHODS.get("plugin.settings.set")).toMatchObject({ userOnly: true, change: "core" });
    for (const name of ["archive.list", "archive.history"]) expect([...CLOVER_METHODS.get(name)!.roles].sort()).toEqual(["app", "cli"]);
    expect(CLOVER_METHODS.get("device.list")).toMatchObject({ capability: "devices.read" });
    expect(CLOVER_METHODS.get("device.list")!.roles).toContain("layer");
    expect(CLOVER_EVENTS.get("device_changed")).toMatchObject({ capability: "devices.read" });
  });

  test("lane D's asks: usage by bot and session, and the client's send stamp on a user's message", () => {
    const rows = CLOVER_METHODS.get("usage.rows")!.params;
    expect(rows.safeParse({ since: 0, bot: "alpha", session: "s_alpha" }).success).toBe(true);
    const summary = CLOVER_METHODS.get("usage.summary")!.params;
    expect(summary.safeParse({ from: 0, to: 1, groupBy: "session", bot: "alpha" }).success).toBe(true);
    const send = CLOVER_METHODS.get("session.send")!.params;
    expect(send.safeParse({ id: "s_alpha", message: { text: "hi", clientMessageId: "c1", sentAt: 1781270000000 } }).success).toBe(true);
    expect(send.safeParse({ id: "s_alpha", message: { text: "hi", clientMessageId: "c1" } }).success).toBe(true);
  });

  test("a method only the user may call is open to user roles, or to a layer when it becomes a card", () => {
    for (const m of methods.filter((x) => x.userOnly)) {
      for (const r of m.roles) {
        // plugin.install raises its own card, the plugin's OK, instead of a change's (F-M2's review, S1).
        if (r === "layer") expect([m.name, m.change !== undefined || m.name === "plugin.install"]).toEqual([m.name, true]);
        else expect([...USER_ROLES, "peer"]).toContain(r);
      }
    }
  });

  test("remote roles never reach the plugin host's channel, layer tokens or development folders", () => {
    for (const role of REMOTE_ROLES) {
      for (const name of calls(role)) {
        expect(name.startsWith("pluginHost.")).toBe(false);
        expect(name.startsWith("plugin.dev.")).toBe(false);
        expect(name).not.toBe("layer.token");
      }
    }
  });

  test("peer.call reaches only a remote client's list, and a user-only or change method only with a signed answer", () => {
    const reach = new Set<string>();
    for (const role of PEER_CALL_ROLES) {
      for (const name of allowedMethods(role)) {
        const verdict = peerCallVerdict(name, role, { kind: "user" });
        const m = CLOVER_METHODS.get(name)!;
        // What only the user may read (`noSessions`) runs for the calling computer's user alone.
        if (m.noSessions) for (const kind of ["session", "plugin", "core", "peer"]) expect(peerCallVerdict(name, role, { kind })).toBe("refused");
        if (m.noSessions) expect(peerCallVerdict(name, role)).toBe("refused");
        if (name.startsWith("peer.")) expect(verdict).toBe("refused");
        else expect(verdict).toBe(m.userOnly || m.change !== undefined ? "needs-answer" : "allowed");
        if (verdict !== "refused") reach.add(name);
      }
    }
    for (const name of reach) {
      expect(name.startsWith("pluginHost.")).toBe(false);
      expect(name.startsWith("plugin.dev.")).toBe(false);
      expect(name).not.toBe("layer.token");
      expect(name).not.toBe("card.frame");
      // Nothing only the app, the CLI or the plugin host may call.
      const m = CLOVER_METHODS.get(name)!;
      expect(m.roles.some((r) => r === "remote" || r === "web")).toBe(true);
    }
    for (const role of ["app", "cli", "plugin-host", "layer", "peer"]) expect(peerCallVerdict("protocol.hello", role)).toBe("refused");
    expect(peerCallVerdict("plugin.dev.add", "remote")).toBe("refused");
    expect(peerCallVerdict("peer.call", "remote")).toBe("refused");
    expect(peerCallVerdict("no.such", "remote")).toBe("refused");
    // The schema itself refuses any other role.
    const call = (role: string) => CLOVER_METHODS.get("peer.call")!.params.safeParse({ method: "session.send", params: {}, as: { kind: "core" }, role }).success;
    expect(call("remote")).toBe(true);
    expect(call("app")).toBe(false);
    expect(call("plugin-host")).toBe(false);
  });

  test("a hello older than the minimum is refused with its own code; a client skips an event type it doesn't know (review minor)", () => {
    expect(helloVersionServed(CLOVER_PROTOCOL_VERSION)).toBe(true);
    expect(helloVersionServed(CLOVER_PROTOCOL_MIN_VERSION - 1)).toBe(false);
    expect(helloVersionServed(CLOVER_PROTOCOL_VERSION + 1)).toBe(true);
    expect(helloVersionServed(1.5)).toBe(false);
    expect(CLOVER_ERR.VERSION_REFUSED).toBe(-32019);
    expect(new Set(Object.values(CLOVER_ERR)).size).toBe(Object.values(CLOVER_ERR).length);
    const known = { type: "plugin_removed", ts: 1781270000000, id: "luna" };
    expect(decodeCloverCoreEvent(known)).toMatchObject({ kind: "event", event: known });
    expect(decodeCloverCoreEvent({ type: "from_the_future", ts: 1 })).toEqual({ kind: "skip", type: "from_the_future" });
    expect(decodeCloverCoreEvent({ type: "plugin_removed", ts: 1 })).toMatchObject({ kind: "invalid", type: "plugin_removed" });
    expect(decodeCloverCoreEvent(null)).toMatchObject({ kind: "invalid" });
    expect(CloverCoreEvent.safeParse({ type: "from_the_future", ts: 1 }).success).toBe(false);
  });

  test("every role says hello", () => {
    for (const role of CLOVER_ROLES) expect(calls(role).has("protocol.hello")).toBe(true);
  });

  test("capability checks: call:* needs call:<the target's top-level id>", () => {
    const run = CLOVER_METHODS.get("command.run")!;
    expect(pluginMayCall(run, ["call:luna"], "luna/tarot-panel")).toBe(true);
    expect(pluginMayCall(run, ["call:luna"], "weather")).toBe(false);
    expect(pluginMayCall(run, ["call:luna"])).toBe(false);
    const read = CLOVER_METHODS.get("session.history")!;
    expect(pluginMayCall(read, ["conversation.read"])).toBe(true);
    expect(pluginMayCall(read, ["conversation.post"])).toBe(false);
  });
});

describe("session.stageImage (lane D, for lane I's phone)", () => {
  test("the user's, for the app, the CLI and the remote role, with the app's caps", () => {
    const stage = CLOVER_METHODS.get("session.stageImage")!;
    expect(stage.userOnly).toBe(true);
    for (const role of ["app", "cli", "remote"] as const) expect([role, calls(role).has("session.stageImage")]).toEqual([role, true]);
    expect(calls("web").has("session.stageImage")).toBe(false);
    expect(stage.params.safeParse({ id: "s_luna", mediaType: "image/heic", dataBase64: "AAAA" }).success).toBe(true);
    expect(stage.params.safeParse({ id: "s_luna", mediaType: "image/svg+xml", dataBase64: "AAAA" }).success).toBe(false);
    expect(stage.params.safeParse({ id: "s_luna", mediaType: "image/png", dataBase64: "A".repeat(STAGE_IMAGE_B64_MAX_LENGTH + 4) }).success).toBe(false);
    expect(stage.result.safeParse({ path: "/tmp/clover-session-s_luna/images/image_1.png" }).success).toBe(true);
  });
});

describe("routine.webhookKey (lane D)", () => {
  test("the user's, on this computer's app and CLI only: never a remote, web or layer client", () => {
    const m = CLOVER_METHODS.get("routine.webhookKey")!;
    expect(m.userOnly).toBe(true);
    for (const role of ["app", "cli"] as const) expect([role, calls(role).has("routine.webhookKey")]).toEqual([role, true]);
    for (const role of ["remote", "web", "layer"] as const) expect([role, calls(role).has("routine.webhookKey")]).toEqual([role, false]);
    expect(m.params.safeParse({ id: "r_deploy01", rotate: true }).success).toBe(true);
  });
});

describe("cards", () => {
  test("canonical JSON sorts keys at every depth and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: undefined } })).toBe('{"a":{"d":[3,{"x":2,"y":1}]},"b":1}');
  });

  test("a card's hash input leaves out the hash, and a signed answer covers id, hash, option, time and children", () => {
    const card = { id: "card_0a1b2c3d", hash: "f".repeat(64), kind: "tool" } as never;
    expect(cardHashInput(card)).toBe('{"id":"card_0a1b2c3d","kind":"tool"}');
    expect(cardAnswerSigningInput({ id: "card_0a1b2c3d", hash: "a".repeat(64), option: "deny", at: 5 }))
      .toBe(`clover/card-answer/2\ncard_0a1b2c3d\n${"a".repeat(64)}\ndeny\n5\n`);
    expect(cardAnswerSigningInput({ id: "c", hash: "h", option: "approve", at: 7, children: ["luna/z", "luna/a"] }))
      .toBe("clover/card-answer/2\nc\nh\napprove\n7\nluna/a,luna/z");
  });

  test("an answer's time falls between the card's issue and the earlier of now and its expiry, give or take the skew", () => {
    const card = { issuedAt: 1_000_000, expiresAt: 1_600_000 };
    expect(answerTimeOk(card, 1_000_000, 1_000_000)).toBe(true);
    expect(answerTimeOk(card, 0, 1_000_000)).toBe(false);
    expect(answerTimeOk(card, 1_000_000 - CARD_ANSWER_SKEW_MS - 1, 1_000_000)).toBe(false);
    expect(answerTimeOk(card, 1_000_000 + CARD_ANSWER_SKEW_MS + 1, 1_000_000)).toBe(false);
    expect(answerTimeOk(card, 1_600_001, 2_000_000)).toBe(false);
    expect(answerTimeOk({ issuedAt: 1_000_000, expiresAt: null }, 1_900_000, 1_900_000)).toBe(true);
  });

  test("the card hash vectors hold: canonical JSON as RFC 8785 gives it, for nulls, /, non-ASCII, U+2028, emoji and numbers", () => {
    const file = JSON.parse(buildCloverArtifacts().get("fixtures/card-hash-vectors.json")!) as {
      vectors: { name: string; input: unknown; canonical: string }[]; card: { card: unknown; hashInput: string };
    };
    const byName = Object.fromEntries(file.vectors.map((v) => [v.name, v]));
    expect(byName.slash!.canonical).toBe('{"path":"a/b/c","url":"https://example.com/x?y=1"}');
    expect(byName.nulls!.canonical).toBe('{"a":[null,1,{"c":null}],"b":null}');
    expect(byName.emoji!.canonical.startsWith('{"e":"😀","z":')).toBe(true);
    expect(byName.numbers!.canonical).toContain('"big":1e+21');
    expect(byName["line-separators"]!.canonical).toBe('{"s":"a\u2028b\u2029c"}');
    expect(byName["lone-surrogate"]!.canonical).toBe('{"s":"a\uFFFDb","\uFFFD":1}');
    // Sealed text refuses one outright.
    expect(SealedValue.safeParse({ type: "text", text: "a\ud800b" }).success).toBe(false);
    expect(SealedValue.safeParse({ type: "text", text: "a😀b" }).success).toBe(true);
    // A card's content leaves out where and when it was shown, and nothing else (N1).
    const c = file.card.card as never as Parameters<typeof cardContentInput>[0] & { id: string; issuedAt: number };
    expect(cardContentInput({ ...c, id: "card_other", issuedAt: 1 } as never)).toBe(cardContentInput(c));
    expect(cardContentInput({ ...c, fields: { title: { type: "text", text: "Show the weather" } } })).not.toBe(cardContentInput(c));
    for (const v of file.vectors) expect([v.name, canonicalJson(v.input)]).toEqual([v.name, v.canonical]);
    expect(cardHashInput(file.card.card as never)).toBe(file.card.hashInput);
  });
});

describe("the browser's DevTools domains", () => {
  test("Target, Browser and Storage never pass (§12.1)", () => {
    expect(isCdpMethodAllowed("Page.navigate")).toBe(true);
    expect(isCdpMethodAllowed("Input.dispatchMouseEvent")).toBe(true);
    expect(isCdpMethodAllowed("Target.setAutoAttach")).toBe(false);
    expect(isCdpMethodAllowed("Browser.close")).toBe(false);
    expect(isCdpMethodAllowed("Storage.getCookies")).toBe(false);
    expect(isCdpMethodAllowed("Unknown.thing")).toBe(false);
  });

  test("a partition loads no local file, browser page or Clover scheme (review S17)", () => {
    for (const url of ["file:///etc/passwd", "File:///x", "filesystem:https://a.example/temporary/x", "chrome://settings", "chrome-untrusted://x/",
      "devtools://devtools/x", "view-source:https://a.example", "clover-plugin://luna/a.js", "clover-asset://x", "about:settings", "", "nope"]) {
      expect([url, isBrowserUrlAllowed(url)]).toEqual([url, false]);
    }
    for (const url of ["https://a.example/", "http://127.0.0.1:8080/", "about:blank", "about:srcdoc", "data:text/html,hi", "blob:https://a.example/1"]) {
      expect([url, isBrowserUrlAllowed(url)]).toEqual([url, true]);
    }
  });
});

describe("relayed messages and peer file calls (review N2, N3, N5)", () => {
  test("a send time is clamped to the receive time plus or minus the window", () => {
    const now = 1_781_270_000_000;
    expect(clampSentAt(undefined, now)).toBe(now);
    expect(clampSentAt(0, now)).toBe(now - SENT_AT_WINDOW_MS);
    expect(clampSentAt(8.64e15, now)).toBe(now + SENT_AT_WINDOW_MS);
    expect(clampSentAt(now - 1234, now)).toBe(now - 1234);
  });

  test("the user-message signing input is pinned, and the hash covers the words and attachments only", () => {
    expect(userMessageSigningInput({ session: "s_alpha", clientMessageId: "m-1", hash: "ab", sentAt: 5 })).toBe("clover/user-message/1\ns_alpha\nm-1\nab\n5");
    expect(userMessageHashInput({ text: "hi" })).toBe('{"files":[],"images":[],"text":"hi"}');
  });

  test("a peer's stream grants none of §5.5's sensitive changes by itself (N7)", () => {
    expect([...PEER_STREAM_GRANTS].sort()).toEqual([
      "adult-confirmation", "computer-level", "connector-permission", "dev-folder", "device-add", "device-revoke", "main-computer",
      "plugin-ok", "provider-credential", "repo-trust", "routine-level-raise", "saved-rule",
    ]);
  });

  test("a peer caller is its own kind, and tree calls carry the peer's session, level and answer", () => {
    expect(CallerSchema.safeParse({ kind: "peer", device: "desk0000000000000001", sessionId: "s_remote" }).success).toBe(true);
    const write = CLOVER_METHODS.get("tree.write")!;
    expect(write.params.safeParse({ path: "home/Studio/a.txt", data: { encoding: "utf8", text: "a" }, session: "s_remote", level: "ask" }).success).toBe(true);
    expect(write.params.safeParse({ path: "home/Studio/a.txt", data: { encoding: "utf8", text: "a" }, level: "everything" }).success).toBe(false);
  });
});

describe("B-M1's contract asks (lanes E, G, J, K, L)", () => {
  const params = (name: string) => CLOVER_METHODS.get(name)!.params;
  test("tabs: a session without a bot owns its own, and a tab says which view has it live (R8, R10)", () => {
    const tab = { id: "tab_1", computer: "Studio", owner: { kind: "session", session: "s_code" }, partition: "session-s_code", url: "https://a.example/", title: "A", place: "shown", viewport: { width: 800, height: 600 }, loading: false, heldByUser: false, view: "browser" };
    expect(CLOVER_EVENTS.get("tab_changed")!.schema.safeParse({ type: "tab_changed", ts: 1, tab }).success).toBe(true);
    expect(params("browser.open").safeParse({ owner: { kind: "bot", bot: "alpha" }, show: { view: "browser", viewport: { width: 800, height: 600 } } }).success).toBe(true);
    expect(params("browser.open").safeParse({ owner: { kind: "user" }, show: true }).success).toBe(false);
  });

  test("the tree serves lane J's methods to peers and layers, and its notices go to peers only", () => {
    for (const name of ["tree.mkdir", "tree.readlink", "tree.symlink", "tree.watch", "tree.unwatch"]) {
      expect([name, CLOVER_METHODS.get(name)?.roles]).toEqual([name, ["peer", "layer"]]);
    }
    expect(params("tree.write").safeParse({ path: "home/Studio/a.sh", data: { encoding: "utf8", text: "x" }, executable: true }).success).toBe(true);
    expect(params("tree.grep").safeParse({ pattern: "x", cwd: "home/Studio", ignoreCase: true }).success).toBe(true);
    for (const type of ["tree_changed", "computer_hello"]) expect([type, CLOVER_EVENTS.get(type)?.roles]).toEqual([type, ["peer"]]);
  });

  test("lane J's peer side: the direct path, holds, levels, Mirror, terminals, and the refusal an answer lifts", () => {
    for (const name of ["tree.judge", "tree.receive", "tree.sent", "computer.takeHold", "computer.releaseHold", "computer.releaseSession", "computer.holds", "mcp.mirror"]) {
      expect([name, CLOVER_METHODS.get(name)?.roles]).toEqual([name, ["peer"]]);
    }
    // One answer for a move or copy between computers (R15).
    expect(params("tree.receive").safeParse({ from: "home/Laptop1/p", to: "home/Studio/p", move: true, level: "ask-risky" }).success).toBe(true);
    // A peer sets the receiver's own level; the app names the computer.
    expect(params("computer.setLevel").safeParse({ level: "automatic" }).success).toBe(true);
    expect(params("computer.setLevel").safeParse({ name: "Studio", level: "ask" }).success).toBe(true);
    expect(CLOVER_METHODS.get("computer.setLevel")!.roles).toContain("peer");
    expect(params("terminal.open").safeParse({ cwd: "home/Studio/p", cols: 80, rows: 24, level: "ask-risky" }).success).toBe(true);
    expect(params("terminal.open").safeParse({ computer: "Studio", cols: 80, rows: 24 }).success).toBe(true);
    expect(params("tool.cancel").safeParse({ callId: "c1", session: "s_alpha" }).success).toBe(true);
    expect(NeedsAnswer.safeParse({ needsAnswer: true, computer: "Studio", method: "tree.write" }).success).toBe(true);
  });

  test("the plugin host carries the call an API call was made in (R7), and a layer's plugin view is complete (lane E)", () => {
    expect(params("pluginHost.api").safeParse({ pluginId: "clover/browser", callId: "c1", call: "browser.tabs", args: [], invocation: "inv_1" }).success).toBe(true);
    const view = CLOVER_METHODS.get("plugin.ui")?.result;
    expect(view).toBeDefined();
    expect(CLOVER_METHODS.get("app.notify")!.result.safeParse({ shown: false }).success).toBe(true);
    expect(CLOVER_METHODS.get("app.notify.close")?.direction).toBe("from-daemon");
  });
});

describe("#179's review and H-M1's asks", () => {
  const params = (name: string) => CLOVER_METHODS.get(name)!.params;

  test("R15's one binding names both computers, with lane J's params (F2)", () => {
    const call = { operation: "move", from: "home/Laptop1/p", to: "home/Studio/p", source: "Laptop1", destination: "Studio" };
    expect(TreeTransferParams.safeParse(call).success).toBe(true);
    expect(TreeTransferParams.safeParse({ ...call, operation: "rename" }).success).toBe(false);
    expect(TreeTransferParams.safeParse({ ...call, move: true }).success).toBe(false);
    expect(TREE_TRANSFER).toBe("tree.transfer");
    expect(CLOVER_METHODS.has(TREE_TRANSFER)).toBe(false); // a binding, never a method
    expect(CallBinding.safeParse({ computer: "Studio", source: "Laptop1", method: TREE_TRANSFER, params: "a".repeat(64) }).success).toBe(true);
  });

  test("a peer's computer.setLevel can't name a computer (S3)", () => {
    const spec = CLOVER_METHODS.get("computer.setLevel")!;
    expect(paramsFor(spec, "peer").safeParse({ level: "automatic" }).success).toBe(true);
    expect(paramsFor(spec, "peer").safeParse({ name: "Laptop1", level: "automatic" }).success).toBe(false);
    expect(paramsFor(spec, "app").safeParse({ name: "Laptop1", level: "automatic" }).success).toBe(true);
    expect(paramsFor(spec, "app").safeParse({ name: "Laptop1", level: "automatic", answer: undefined, extra: 1 }).success).toBe(false);
    // A method without a peer variant parses the same for every role.
    expect(paramsFor(CLOVER_METHODS.get("tree.read")!, "peer")).toBe(CLOVER_METHODS.get("tree.read")!.params);
  });

  test("the user's words from the pill reach the daemon only from the app (S2)", () => {
    const spec = CLOVER_METHODS.get("pill.send")!;
    expect(spec.roles).toEqual(["app"]);
    expect(spec.userOnly).toBe(true);
    expect(allowedMethods("layer").has("pill.send")).toBe(false);
    for (const to of [{ bot: "alpha" }, { session: "s_alpha" }, { target: "home#lights" }]) {
      expect([to, spec.params.safeParse({ to, text: "hi", clientMessageId: "m1" }).success]).toEqual([to, true]);
    }
    expect(spec.params.safeParse({ to: { bot: "alpha", session: "s_alpha" }, text: "hi", clientMessageId: "m1" }).success).toBe(false);
  });

  test("a plugin acting as itself has a partition of its own (S1)", () => {
    expect(params("browser.open").safeParse({ owner: { kind: "plugin", plugin: "clover/browser-tool" } }).success).toBe(true);
  });

  test("F-M2's review: installs and the switch go by the OK, and a session shows its branch and changes", () => {
    const install = CLOVER_METHODS.get("plugin.install")!;
    expect(install.roles).toEqual(["app", "cli", "layer"]);
    expect(install.result.safeParse({ id: "tarot", state: "found", treeHash: "sha256:" + "a".repeat(64), card: "card_ok000001" }).success).toBe(true);
    expect(params("plugin.setEnabled").safeParse({ id: "tarot", enabled: true, okHash: "sha256:" + "a".repeat(64) }).success).toBe(true);
    const session = { id: "s_code", kind: "coding", computer: "Studio", status: "idle", startedAt: 1, updatedAt: 2, branch: "feat/x", changes: 3 };
    expect(SessionView.safeParse(session).success).toBe(true);
    expect(SessionView.safeParse({ ...session, changes: -1 }).success).toBe(false);
  });

  test("H-M1: connSeq on the link's hello, and the app's answer key", () => {
    const hello = { protocolVersion: 1, device: "k3x9a7mq2c4d8e1f5g6h0j2k4m6n8p0r", epoch: 0, features: [] };
    expect(params("peer.hello").safeParse({ ...hello, connSeq: 3 }).success).toBe(true);
    expect(params("peer.hello").safeParse(hello).success).toBe(false);
    expect(CLOVER_METHODS.get("peer.hello")!.result.safeParse({ ...hello, connSeq: 4 }).success).toBe(true);
    const set = CLOVER_METHODS.get("device.answerKey.set")!;
    expect([set.roles, set.userOnly]).toEqual([["app"], true]);
    expect(set.params.safeParse({ publicKey: "A".repeat(43) + "=", held: "app-keychain", signature: "B".repeat(86) + "==" }).success).toBe(true);
    expect(set.params.safeParse({ publicKey: "not base64!", held: "app-keychain", signature: "B".repeat(86) + "==" }).success).toBe(false);
    // Only holders that never prompt (the owner's rule): no Windows Hello; DPAPI, the Secret Service and a plain
    // Keychain item instead.
    for (const held of ["keychain", "dpapi", "secret-service"]) {
      expect([held, set.params.safeParse({ publicKey: "A".repeat(43) + "=", held, signature: "B".repeat(86) + "==" }).success]).toEqual([held, true]);
    }
    expect(set.params.safeParse({ publicKey: "A".repeat(43) + "=", held: "hello", signature: "B".repeat(86) + "==" }).success).toBe(false);
  });

  test("the lease view names its holder for a client: this device, a computer it knows, or one it doesn't (lane H)", () => {
    const lease = { main: null, holder: "desk0000000000000001", epoch: 3, expiresAt: 1, refresher: null, state: "held" };
    for (const heldBy of [{ kind: "self" }, { kind: "computer", computer: "Studio" }, { kind: "unknown" }, null]) {
      expect(LeaseView.safeParse({ ...lease, heldBy }).success).toBe(true);
    }
    expect(LeaseView.safeParse(lease).success).toBe(true);
    expect(LeaseView.safeParse({ ...lease, heldBy: { kind: "unknown", computer: "Studio" } }).data?.heldBy).toEqual({ kind: "unknown" });
    expect(LeaseView.safeParse({ ...lease, heldBy: { kind: "stranger" } }).success).toBe(false);
  });
});

describe("the stacked asks (C, L, H, F, G, A, I)", () => {
  test("C: protocol.prove before the hello, with its nonce's bounds and its proof's input", () => {
    const prove = CLOVER_METHODS.get("protocol.prove")!;
    expect([prove.roles, prove.owner]).toEqual([["app"], "C"]);
    const nonce = (bytes: number) => Buffer.alloc(bytes, 7).toString("base64url");
    expect(prove.params.safeParse({ nonce: nonce(16) }).success).toBe(true);
    expect(prove.params.safeParse({ nonce: nonce(96) }).success).toBe(true);
    expect(prove.params.safeParse({ nonce: nonce(15) }).success).toBe(false);
    expect(prove.params.safeParse({ nonce: nonce(97) }).success).toBe(false);
    expect(prove.params.safeParse({ nonce: nonce(16) + "=" }).success).toBe(false);
    expect(prove.result.safeParse({ proof: Buffer.alloc(32, 1).toString("base64url"), pid: 4242 }).success).toBe(true);
    expect(daemonProofInput("abc", 12)).toBe("clover-daemon-proof\u0000abc\u000012");
  });

  test("L: a plugin's own tab owner names it as `plugin`", () => {
    expect(CLOVER_METHODS.get("browser.open")!.params.safeParse({ owner: { kind: "plugin", plugin: "tarot" } }).success).toBe(true);
    expect(CLOVER_METHODS.get("browser.open")!.params.safeParse({ owner: { kind: "plugin", pluginId: "tarot" } }).success).toBe(false);
  });

  test("H: link.session.deliver carries a bot's, an agent's or a routine's message, never the user's", () => {
    const spec = CLOVER_METHODS.get("link.session.deliver")!;
    expect(spec.roles).toEqual(["peer"]);
    const ok = (input: unknown) => spec.params.safeParse({ id: "s_alpha", computer: "Studio", input }).success;
    expect(ok({ from: "bot", bot: "luna", session: "s_luna", text: "hi" })).toBe(true);
    expect(ok({ from: "agent", agent: "a_1", text: "done" })).toBe(true);
    expect(ok({ from: "routine", routine: "daily", name: "Daily", sideThread: "s_side", text: "ran" })).toBe(true);
    expect(ok({ from: "user", text: "pretend" })).toBe(false);
    expect(ok({ from: "plugin", pluginId: "x", text: "x" })).toBe(false);
    expect(spec.params.safeParse({ id: "s_alpha", input: { from: "agent", agent: "a_1", text: "done" } }).success).toBe(false);
  });

  test("check 2 and D, H: a layer installs from an index or npm only; reports reach a bot; a replaced answer key is a card", () => {
    const install = CLOVER_METHODS.get("plugin.install")!;
    expect(paramsFor(install, "layer").safeParse({ source: { from: "index", id: "tarot" } }).success).toBe(true);
    expect(paramsFor(install, "layer").safeParse({ source: { from: "npm", name: "clover-tarot" } }).success).toBe(true);
    expect(paramsFor(install, "layer").safeParse({ source: { from: "folder", path: "/tmp/x" } }).success).toBe(false);
    expect(paramsFor(install, "layer").safeParse({ source: { from: "wrap", kind: "mcp-url", value: "https://x" } }).success).toBe(false);
    expect(paramsFor(install, "cli").safeParse({ source: { from: "folder", path: "/tmp/x" } }).success).toBe(true);
    const deliver = CLOVER_METHODS.get("link.session.deliver")!;
    expect(deliver.params.safeParse({ id: "s_luna", computer: "Studio", input: { from: "task-notification", agent: "a_1", backend: "claude-code", stopReason: "end_turn", text: "done", transcript: "home/Studio/.clover/agents/a_1.jsonl" } }).success).toBe(true);
    expect(deliver.params.safeParse({ id: "s_luna", computer: "Studio", input: { from: "note", label: "x", text: "x", by: { kind: "core" } } }).success).toBe(false);
    expect(CLOVER_METHODS.get("device.answerKey.set")!.result.safeParse({ applied: false, card: "card_key000001" }).success).toBe(true);
  });

  test("H and I: the answer key's algorithm, and a phone's ios", () => {
    const set = CLOVER_METHODS.get("device.answerKey.set")!;
    const key = { publicKey: "B" + "A".repeat(86) + "=", held: "secure-enclave", signature: "B".repeat(86) + "==" };
    expect(set.params.safeParse({ ...key, alg: "p256" }).success).toBe(true);
    expect(set.params.safeParse({ ...key, alg: "ed25519" }).success).toBe(true);
    expect(set.params.safeParse(key).success).toBe(true);
    expect(set.params.safeParse({ ...key, alg: "rsa" }).success).toBe(false);
    expect(DeviceOs.options).toEqual(["macos", "windows", "linux", "ios"]);
    expect(Os.options).toEqual(["macos", "windows", "linux"]);
    expect([isComputerOs("ios"), isComputerOs("linux")]).toEqual([false, true]);
    expect(DeviceView.shape.os.safeParse("ios").success).toBe(true);
    expect(DeviceView.shape.answers.safeParse({ held: "tpm", alg: "p256" }).success).toBe(true);
  });

  test("lane I's phone: models.list for the remote role, and no session.create", () => {
    const remote = calls("remote");
    for (const m of ["models.list", "session.setModel"]) expect([m, remote.has(m)]).toEqual([m, true]);
    expect(remote.has("session.create")).toBe(false);
    expect(CLOVER_METHODS.get("models.list")!.userOnly).toBeFalsy();
    const model = { id: "fireworks/kimi-k3", name: "Kimi K3", provider: "fireworks", providerName: "Fireworks", plugin: "clover/model-fireworks", efforts: ["low", "medium", "high"], images: true, signedIn: true };
    expect(CLOVER_METHODS.get("models.list")!.result.safeParse({ models: [model], default: "fireworks/kimi-k3" }).success).toBe(true);
    expect(CLOVER_METHODS.get("models.list")!.params.safeParse({}).success).toBe(true);
  });

  test("H-M2's review and check 2: a fencing token on acts between computers, judged against the receiver's own lease", () => {
    const fence = { scope: "acct_1", epoch: 3, holder: "desk0000000000000001" };
    expect(CLOVER_METHODS.get("peer.call")!.params.safeParse({ method: "session.send", params: {}, as: { kind: "core" }, role: "remote", fence }).success).toBe(true);
    expect(CLOVER_METHODS.get("tree.write")!.params.safeParse({ path: "home/Studio/a", data: { encoding: "utf8", text: "x" }, level: "automatic", fence }).success).toBe(true);
    expect(paramsFor(CLOVER_METHODS.get("computer.setLevel")!, "peer").safeParse({ level: "ask", fence }).success).toBe(true);
    expect(CLOVER_METHODS.get("peer.call")!.params.safeParse({ method: "session.send", params: {}, as: { kind: "core" }, role: "remote", fence: { scope: "acct_1", epoch: 3 } }).success).toBe(false);
    const own = { scope: "acct_1", epoch: 3, holder: "desk0000000000000001" };
    expect(fenceVerdict(own, fence, false)).toBe("ok");
    expect(fenceVerdict(own, { ...fence, epoch: 2 }, true)).toBe("stale");
    expect(fenceVerdict(own, { ...fence, epoch: 4 }, true)).toBe("stale"); // ahead of its own records, until they catch up
    expect(fenceVerdict(own, { ...fence, holder: "desk0000000000000002" }, true)).toBe("stale"); // a split takeover
    expect(fenceVerdict(own, { ...fence, scope: "group_9" }, false)).toBe("stale"); // not its own lease's scope
    expect(fenceVerdict(undefined, fence, false)).toBe("stale");
    expect(fenceVerdict(own, undefined, false)).toBe("ok");
    expect(fenceVerdict(own, undefined, true)).toBe("missing");
    // A lapsed lease (no holder): nobody acts, the old holder's token for the lapsed epoch included (#237's ruling).
    const lapsed = { ...own, holder: null };
    expect(fenceVerdict(lapsed, fence, true)).toBe("lapsed");
    expect(fenceVerdict(lapsed, undefined, false)).toBe("lapsed");
  });

  test("F: the plugin list says whether the user already confirmed they're 18 or older", () => {
    expect(CLOVER_METHODS.get("plugin.list")!.result.safeParse({ plugins: [], adultConfirmed: true }).success).toBe(true);
    expect(CLOVER_METHODS.get("plugin.list")!.result.safeParse({ plugins: [], adultConfirmed: "yes" }).success).toBe(false);
  });
});

describe("the tree protocol version (lane J's noFollow, #225)", () => {
  test("noFollow is a tree.stat and tree.read param, and needs tree 1.1 of the peer", async () => {
    const { CLOVER_METHODS: M, TREE_PROTOCOL, peerTakesTreeCall, treeFeature, treeProtocolOf } = await import("../src/index");
    expect(M.get("tree.stat")!.params.safeParse({ path: "home/Studio/a", noFollow: true }).success).toBe(true);
    expect(M.get("tree.read")!.params.safeParse({ path: "home/Studio/a", noFollow: true }).success).toBe(true);
    expect(M.get("tree.read")!.params.safeParse({ path: "home/Studio/a", noFollow: "yes" }).success).toBe(false);
    expect(TREE_PROTOCOL).toEqual({ major: 1, minor: 1 });
    expect(treeFeature()).toBe("tree/1.1");
    expect(treeProtocolOf(undefined)).toEqual({ major: 1, minor: 0 });
    expect(treeProtocolOf(["x", "tree/1.1", "tree/1.0"])).toEqual({ major: 1, minor: 1 });
    expect(treeProtocolOf(["tree/1.x", "tree/"])).toEqual({ major: 1, minor: 0 });
    expect(peerTakesTreeCall("tree.stat", { path: "a", noFollow: true }, [])).toBe(false);
    expect(peerTakesTreeCall("tree.read", { path: "a", noFollow: true }, ["tree/1.0"])).toBe(false);
    expect(peerTakesTreeCall("tree.read", { path: "a", noFollow: true }, ["tree/1.1"])).toBe(true);
    expect(peerTakesTreeCall("tree.read", { path: "a", noFollow: true }, ["tree/1.2"])).toBe(true);
    expect(peerTakesTreeCall("tree.read", { path: "a", noFollow: true }, ["tree/2.0"])).toBe(false);
    expect(peerTakesTreeCall("tree.read", { path: "a" }, [])).toBe(true);
    expect(peerTakesTreeCall("tree.list", { path: "a", noFollow: true }, [])).toBe(true);
  });
});

describe("lane F's F-M3 asks of B", () => {
  test("ui.set keeps appearance and textSize; a plugin's setting view carries options, min and max", async () => {
    const { CLOVER_METHODS: M, PluginSettingView, UiSettings } = await import("../src/index");
    const patch = M.get("ui.set")!.params.parse({ patch: { appearance: "dark", textSize: "large" } }) as { patch: Record<string, unknown> };
    expect(patch.patch).toEqual({ appearance: "dark", textSize: "large" });
    expect(UiSettings.partial().safeParse({ appearance: "dim" }).success).toBe(false);
    expect(UiSettings.partial().safeParse({ textSize: 14 }).success).toBe(false);
    const view = { key: "region", type: "enum", title: "Region", scope: "account", required: false, set: false };
    expect(PluginSettingView.parse({ ...view, options: ["eu", { value: "us", title: "United States" }] }).options).toEqual(["eu", { value: "us", title: "United States" }]);
    expect(PluginSettingView.parse({ ...view, type: "number", min: 1, max: 10 })).toMatchObject({ min: 1, max: 10 });
  });
});
