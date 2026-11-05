// Clover's protocol tables (spec revision 17): names, fixtures, owners, and the allow lists' safety properties.
// These pin the contract every lane builds against; a change here is a contract change (plan §3, via the controller).
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  AREA_EVENTS, AREA_METHODS, CLOVER_AREAS, CLOVER_EVENTS, CLOVER_METHODS, CloverCoreEvent,
  PEER_CALL_ROLES, allowedEvents, allowedMethods, daemonRequestsTo, peerCallVerdict, pluginMayCall,
} from "../src/clover";
import { CloverSessionEvent } from "../src/sessions";
import {
  AnyPluginId, Caller, ComputerName, LANES, LEVELS, TopPluginId, TreePath, isAnyPluginId, isPluginId, levelAbove,
  pluginIdFromSegment, pluginIdToSegment, topPluginIdOf,
} from "../src/common";
import { CLOVER_ROLES, PLUGIN_ROLES, REMOTE_ROLES, USER_ROLES, type CloverRole } from "../src/roles";
import { METHODS, SessionEvent } from "../src/index";
import { CARD_ANSWER_SKEW_MS, answerTimeOk, canonicalJson, cardAnswerSigningInput, cardHashInput } from "../src/approvals";
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
    expect(CLOVER_METHODS.size).toBe(total + 3); // + protocol.hello, events.subscribe, events.unsubscribe
    for (const area of CLOVER_AREAS) expect(Object.keys(AREA_METHODS[area]).length).toBeGreaterThan(0);
  });

  test("these Clover methods reuse an inherited method's name; C1 replaces the inherited ones with them, never both", () => {
    const inherited = new Set<string>(Object.values(METHODS));
    const reused = methods.map((m) => m.name).filter((n) => inherited.has(n)).sort();
    expect(reused).toEqual([
      "plugin.install", "plugin.list", "plugin.restart", "plugin.update", "protocol.hello",
      "session.attach", "session.compact", "session.history", "session.interrupt", "session.list",
      "session.send", "session.setModel", "sync.heads", "sync.pull", "sync.push", "usage.summary",
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

  test("a plugin's calls never make a sensitive change, mint a token or install a plugin (§5.5)", () => {
    for (const role of PLUGIN_ROLES) {
      for (const name of calls(role)) {
        const m = CLOVER_METHODS.get(name)!;
        expect(m.change).not.toBe("sensitive");
        expect(["layer.token", "plugin.install", "plugin.dev.add", "card.answer", "card.list"]).not.toContain(name);
      }
    }
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

  test("a method only the user may call is open to user roles, or to a layer when it becomes a card", () => {
    for (const m of methods.filter((x) => x.userOnly)) {
      for (const r of m.roles) {
        if (r === "layer") expect(m.change).toBeDefined();
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
        const verdict = peerCallVerdict(name, role);
        const m = CLOVER_METHODS.get(name)!;
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
