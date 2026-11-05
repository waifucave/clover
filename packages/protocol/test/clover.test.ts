// Clover's protocol tables (spec revision 17): names, fixtures, owners, and the allow lists' safety properties.
// These pin the contract every lane builds against; a change here is a contract change (plan §3, via the controller).
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  AREA_EVENTS, AREA_METHODS, CLOVER_AREAS, CLOVER_EVENTS, CLOVER_METHODS, CloverCoreEvent,
  allowedEvents, allowedMethods, daemonRequestsTo, pluginMayCall,
} from "../src/clover";
import { CloverSessionEvent } from "../src/sessions";
import {
  AnyPluginId, Caller, ComputerName, LANES, LEVELS, TopPluginId, TreePath, isAnyPluginId, isPluginId, levelAbove,
  pluginIdFromSegment, pluginIdToSegment, topPluginIdOf,
} from "../src/common";
import { CLOVER_ROLES, PLUGIN_ROLES, REMOTE_ROLES, USER_ROLES, type CloverRole } from "../src/roles";
import { METHODS, SessionEvent } from "../src/index";
import { canonicalJson, cardAnswerSigningInput, cardHashInput } from "../src/approvals";
import { isCdpMethodAllowed } from "../src/browser";

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

  test("a card's hash input leaves out the hash, and a signed answer covers id, hash, option and time", () => {
    const card = { id: "card_0a1b2c3d", hash: "f".repeat(64), kind: "tool" } as never;
    expect(cardHashInput(card)).toBe('{"id":"card_0a1b2c3d","kind":"tool"}');
    expect(cardAnswerSigningInput({ id: "card_0a1b2c3d", hash: "a".repeat(64), option: "deny", at: 5 }))
      .toBe(`clover/card-answer/1\ncard_0a1b2c3d\n${"a".repeat(64)}\ndeny\n5`);
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
});
