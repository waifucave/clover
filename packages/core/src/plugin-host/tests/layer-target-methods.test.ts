// What a plugin may reach on its own connections (§5.4), as a class: on its layer's connection, every method that names
// a capability runs only when its OK granted it, and every method that takes another plugin as its target is refused for
// a foreign target without `call:<that plugin>` (or ends in the user's card); on the plugin API, the calls that take a
// target are gated the same way. Each walk fails when a method of that kind is added without a row here.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { API_CALLS } from "@waifucave/clover-plugin-sdk";
import { allowedMethods, AnyPluginId, CLOVER_ERR, CLOVER_EVENTS, CLOVER_METHODS, TopPluginId, type Caller } from "@waifucave/clover-protocol";
import { PLUGIN_OWN_EVENTS } from "../../ipc/core-events";
import { pointsApi } from "../api/points";
import { capabilityRefusal } from "../../auth/clover-caller";
import { commandsApi } from "../../commands/views";
import { grantsInForce, type PluginRecord } from "../../contracts/plugin-registry";
import { mayRunCommand, runCommand, type RunnableCommand } from "../../registry/commands";
import { createApiRouter } from "../api/router";

const plugin = (pluginId: string): Caller => ({ kind: "plugin", pluginId });
const USER: Caller = { kind: "user", client: "app" };

/** The params keys of a method that name a plugin (an `AnyPluginId` or `TopPluginId`, optional or not). */
function pluginIdKeys(method: string): string[] {
  const shape = (CLOVER_METHODS.get(method)!.params as unknown as { shape?: Record<string, unknown> }).shape ?? {};
  const isId = (t: unknown): boolean => {
    let s = t as { _def?: { innerType?: unknown } } | undefined;
    for (let i = 0; i < 3 && s !== undefined; i++) {
      if (s === AnyPluginId || s === TopPluginId) return true;
      s = s._def?.innerType as typeof s;
    }
    return false;
  };
  return Object.keys(shape).filter((k) => isId(shape[k]));
}

describe("a layer's methods that need a capability", () => {
  const layer = [...allowedMethods("layer")];
  const gated = layer.filter((m) => CLOVER_METHODS.get(m)!.capability !== undefined && CLOVER_METHODS.get(m)!.capability !== "call:*");

  test("each is refused for a plugin whose OK doesn't grant it, and runs for one whose does; the user's call isn't a plugin's", () => {
    expect(gated.length).toBeGreaterThan(30);
    for (const m of gated) {
      const cap = CLOVER_METHODS.get(m)!.capability!;
      expect([m, capabilityRefusal("layer", plugin("x"), m, [])?.code]).toEqual([m, CLOVER_ERR.CAPABILITY_REFUSED]);
      expect([m, capabilityRefusal("layer", plugin("x"), m, undefined)?.code]).toEqual([m, CLOVER_ERR.CAPABILITY_REFUSED]);
      expect([m, capabilityRefusal("layer", plugin("x"), m, ["something.else"])?.code]).toEqual([m, CLOVER_ERR.CAPABILITY_REFUSED]);
      expect([m, capabilityRefusal("layer", plugin("x"), m, [cap])]).toEqual([m, null]);
      // The app's own connection, and a CLI's, are the user's or a session's: not this gate's.
      expect([m, capabilityRefusal("app", USER, m, [])]).toEqual([m, null]);
    }
  });

  test("the message names the method and the capability, never anything the call carried", () => {
    expect(capabilityRefusal("layer", plugin("vn"), "session.history", [])?.message).toBe("session.history needs the capability conversation.read, which vn's OK doesn't list");
  });
});

/** Every layer method that takes another plugin as its target, and how a foreign target is kept out. */
const LAYER_TARGETS: Record<string, string> = {
  // `call:*`: the handler checks the command's plugin against the caller (`mayRunCommand`, below).
  "command.run": "call:<target>",
  // A capability that covers every plugin by its own definition ("Read Clover's logs and every plugin's").
  "plugin.logs": "logs.read",
  // The user's changes: from a layer, each ends in the user's sealed card (layer-change-methods.test.ts).
  "plugin.setEnabled": "card",
  "plugin.setScope": "card",
  "plugin.setComputers": "card",
  "plugin.settings.set": "card",
  "plugin.pin": "card",
  "bot.setUserLayer": "card",
  // A bot's id is its plugin's (§6.1): reads of any bot, each behind the capability that covers every bot.
  "bot.get": "bots.read",
  "session.list": "conversation.read",
  "memory.list": "memory.read",
  "memory.read": "memory.read",
  "routine.list": "routines.read",
  "usage.rows": "usage.read",
  "usage.summary": "usage.read",
  // The hello names the plugin the layer token was minted for; another id is refused (clover-connections.test.ts).
  "protocol.hello": "token",
};

describe("what a plugin may use now (grantsInForce): exactly what its host process would get", () => {
  test("its grant while it is on and running (or waiting for a point); nothing while off, stopped, blocked, refused, invalid or awaiting its OK", () => {
    const granted = ["conversation.read", "call:tarot"];
    expect(grantsInForce({ enabled: true, state: "running", granted })).toEqual(granted);
    expect(grantsInForce({ enabled: true, state: "waiting", granted })).toEqual(granted);
    for (const state of ["off", "stopped", "blocked", "refused", "invalid", "found"] as const) expect([state, grantsInForce({ enabled: true, state, granted })]).toEqual([state, []]);
    // Turned off by the user: the OK still covers it (granted stays set), but it may use none of it.
    expect(grantsInForce({ enabled: false, state: "running", granted })).toEqual([]);
    // Awaiting a new OK while the old version runs on the old one (the registry keeps the old grant): the old grant.
    expect(grantsInForce({ enabled: true, state: "running", granted: ["conversation.read"] })).toEqual(["conversation.read"]);
    expect(grantsInForce(undefined)).toEqual([]);
  });
});

describe("a layer's methods that take another plugin as their target", () => {
  test("every one is in the table, and none is open to a foreign target", () => {
    const takes = [...allowedMethods("layer")].filter((m) => m === "command.run" || pluginIdKeys(m).length > 0).sort();
    expect(takes).toEqual(Object.keys(LAYER_TARGETS).sort());
    for (const [m, how] of Object.entries(LAYER_TARGETS)) {
      const spec = CLOVER_METHODS.get(m)!;
      if (how === "card") expect([m, spec.userOnly === true && spec.change !== undefined]).toEqual([m, true]);
      else if (how === "call:<target>") expect([m, spec.capability]).toEqual([m, "call:*"]);
      else if (how === "token") expect(m).toBe("protocol.hello");
      else expect([m, spec.capability]).toEqual([m, how]);
    }
  });
});

describe("command.run, from every route a plugin has", () => {
  const COMMANDS: Record<string, RunnableCommand> = {
    "tarot.draw": { name: "tarot.draw", pluginId: "tarot", handler: "draw" },
    "tarot.spread": { name: "tarot.spread", pluginId: "tarot/spreads", handler: "spread" },
  };
  const grants: Record<string, string[]> = { friend: ["call:tarot"], "friend/kid": ["call:tarot"], stranger: ["call:other"] };
  const ran: { handler: string; caller: Caller }[] = [];
  const o = {
    find: (name: string) => COMMANDS[name],
    host: { invoke: async <R>(r: { handler: string; caller: Caller }) => { ran.push({ handler: r.handler, caller: r.caller }); return "ok" as R; } },
    grantedOf: (id: string) => grants[id],
  };

  test("the rule: a plugin runs its own tree's commands; another's only with call:<its top-level id>; the user and sessions any", () => {
    expect(mayRunCommand(plugin("tarot"), "tarot", [])).toBe(true);
    expect(mayRunCommand(plugin("tarot/spreads"), "tarot", [])).toBe(true);
    expect(mayRunCommand(plugin("tarot"), "tarot/spreads", [])).toBe(true);
    expect(mayRunCommand(plugin("vn-composer"), "tarot", [])).toBe(false);
    expect(mayRunCommand(plugin("vn-composer"), "tarot", undefined)).toBe(false);
    expect(mayRunCommand(plugin("vn-composer"), "tarot", ["call:tarots", "call:tarot/spreads"])).toBe(false);
    expect(mayRunCommand(plugin("friend"), "tarot/spreads", ["call:tarot"])).toBe(true);
    expect(mayRunCommand(USER, "tarot", [])).toBe(true);
    expect(mayRunCommand({ kind: "session", sessionId: "s1", sessionKind: "bot" }, "tarot", [])).toBe(true);
  });

  test("the layer's connection (command.run's handler): a foreign plugin is refused before its args are looked at; own and granted run", async () => {
    ran.length = 0;
    for (const who of ["vn-composer", "stranger"]) {
      await expect(runCommand(o, { name: "tarot.draw", args: { not: "checked" } }, plugin(who))).rejects.toMatchObject({ code: "refused", message: expect.stringContaining("call:tarot") });
    }
    expect(ran).toEqual([]);
    await runCommand(o, { name: "tarot.draw" }, plugin("tarot"));
    await runCommand(o, { name: "tarot.spread" }, plugin("tarot"));
    await runCommand(o, { name: "tarot.spread" }, plugin("friend/kid"));
    await runCommand(o, { name: "tarot.draw" }, USER);
    expect(ran.map((r) => [r.handler, r.caller.kind === "plugin" ? r.caller.pluginId : r.caller.kind])).toEqual([["draw", "tarot"], ["spread", "tarot"], ["spread", "friend/kid"], ["draw", "user"]]);
    // With no record of what it was granted, a foreign plugin is refused.
    await expect(runCommand({ ...o, grantedOf: undefined }, { name: "tarot.draw" }, plugin("friend"))).rejects.toMatchObject({ code: "refused" });
  });

  const record = (id: string, granted: string[]): PluginRecord => ({ id, enabled: true, state: "running", granted } as unknown as PluginRecord);
  const records: Record<string, PluginRecord> = {
    tarot: record("tarot", []), friend: record("friend", ["call:tarot"]), "vn-composer": record("vn-composer", ["conversation.read"]),
  };
  const registry = {
    get: (id: string) => records[id],
    entries: (point: string) => (point !== "commands" ? [] : [
      { point: "commands", pluginId: "tarot", ref: "commands/0", entryId: "tarot.draw", state: "active", value: { name: "draw", description: "Draw", handler: "draw" } },
      { point: "commands", pluginId: "friend", ref: "commands/0", entryId: "friend.wave", state: "active", value: { name: "wave", description: "Wave", handler: "wave" } },
    ]),
  };
  const router = createApiRouter({
    registry: registry as never,
    handlers: [{ "commands.run": () => "ran", ...commandsApi(registry as never) }],
    commandOwner: (name) => (name.startsWith("tarot.") ? "tarot" : name.startsWith("friend.") ? "friend" : undefined),
  });
  const call = (pluginId: string, path: string, args: unknown[], caller: Caller = plugin(pluginId)) => router({ pluginId, process: "shared", path, args, caller } as never);

  test("the plugin API (a host half, a hook or tool handler, a component): commands.run isn't available yet, for any target, also inside the user's call", async () => {
    for (const [id, caller] of [["vn-composer", undefined], ["vn-composer", USER], ["tarot", undefined], ["friend", undefined]] as const) {
      await expect(call(id, "commands.run", ["tarot.draw"], caller ?? plugin(id))).rejects.toMatchObject({ code: "refused", message: expect.stringContaining("commands.run isn't available yet") });
    }
  });

  test("commands.list lists only what the calling plugin may run", async () => {
    const names = async (id: string) => ((await call(id, "commands.list", [])) as { name: string }[]).map((c) => c.name);
    expect(await names("tarot")).toEqual(["tarot.draw"]);
    expect(await names("friend")).toEqual(["tarot.draw", "friend.wave"]);
    expect(await names("vn-composer")).toEqual([]);
  });

  test("every plugin API call that takes a target is gated by it", () => {
    // The calls whose capability names a target: a command's plugin, a URL's host.
    const targeted = Object.entries(API_CALLS).filter(([, i]) => (i as { capability?: string }).capability?.endsWith(":*")).map(([p]) => p).sort();
    expect(targeted).toEqual(["commands.run", "net.fetch"]);
  });
});

describe("what a layer hears and reads of other plugins", () => {
  test("every core event a layer is sent with no capability is its own plugin's (PLUGIN_OWN_EVENTS): no page hears another plugin's state", () => {
    const open = [...CLOVER_EVENTS].filter(([, s]) => (s.roles as readonly string[]).includes("layer") && s.capability === undefined).map(([t]) => t).sort();
    expect(open.filter((t) => !PLUGIN_OWN_EVENTS.has(t))).toEqual([]);
    // The points watch is one of them: the point's name, to the declaring tree's own connections only.
    expect(open).toContain("plugin_point_changed");
  });

  test("points.entries from a page (the ui side, as its plugin): only the point's own declaring tree reads it", async () => {
    const decl = { name: "luna.cards", shape: "list", declaredBy: { pluginId: "luna", ref: "host" }, spot: false, active: true, decl: { shape: "list", fields: { type: "object", properties: { id: { type: "string" }, title: { type: "string" } } } } };
    const states = new Map<string, { enabled: boolean; state: string }>();
    const running = (id: string) => ({ id, enabled: true, state: "running", granted: [], ...states.get(id) });
    const registry = {
      get: (id: string) => running(id),
      points: () => [decl],
      entries: (p: string) => (p !== "luna.cards" ? [] : [{ point: "luna.cards", pluginId: "tarot", ref: "luna.cards/0", entryId: "fool", state: "active", value: { id: "fool", title: "The Fool", secret: "x" } }]),
      watch: () => () => {},
    };
    const api = pointsApi({ registry: registry as never, host: { invoke: async () => undefined } as never, assetUrl: (id, p) => `a://${id}/${p}` });
    const router = createApiRouter({ registry: registry as never, handlers: [api] });
    const read = (pluginId: string) => router({ pluginId, process: "ui", path: "points.entries", args: ["luna.cards"], caller: plugin(pluginId) } as never);
    expect(await read("luna")).toEqual([{ pluginId: "tarot", entryId: "fool", value: { id: "fool", title: "The Fool" } }]);
    expect(await read("luna/page")).toEqual([{ pluginId: "tarot", entryId: "fool", value: { id: "fool", title: "The Fool" } }]);
    // A contributor, or any other plugin's page, reads none of it.
    for (const other of ["tarot", "vn-composer", "clover/plugin-index"]) await expect(read(other)).rejects.toMatchObject({ code: "refused" });
    // The declarer stopped, or turned off, its page's connection still open: it reads nothing either. The router
    // refuses a plugin that isn't live before any handler; the points handler checks the reader again itself (a host's
    // `points.watch` re-reads long after the call that set it up).
    states.set("luna", { enabled: true, state: "stopped" });
    await expect(read("luna")).rejects.toMatchObject({ code: "plugin_stopped" });
    expect(() => api["points.entries"]!({ pluginId: "luna", process: "ui", caller: plugin("luna") } as never, ["luna.cards"])).toThrow("isn't running");
    states.set("luna", { enabled: false, state: "off" });
    await expect(read("luna")).rejects.toMatchObject({ code: "plugin_stopped" });
  });
});

/** Every call a layer makes to its own plugin (`plugin.layer.call`), and what holds it to that plugin. The plugin is
 *  the connection's in each (the method takes no plugin id at all); this table says what each reads or runs. */
const OWN_CALLS: Record<string, string> = {
  "host.call": "its host half's `ui` table, as the plugin, no session",
  "storage.synced.get": "its synced store, read only",
  "storage.synced.keys": "its synced store's keys, read only",
  "settings.get": "its settings while it runs, read only, a secret only as { set }, no bot value",
  "settings.set": "its plain settings while it runs, no card (never a secret, a bot value or a templated setting), 30 a minute",
  "points.entries": "the entries of a point its own tree declares, while it runs, each narrowed to the point's declared fields",
  "avatar.cue": "a cue to its own bot's figure, judged by the core against the renderer's capabilities and names (`avatar.control`)",
  "avatar.catalogue": "its own bot's figure's catalogue (`avatar.read`)",
  "avatar.box": "its own bot's figure's box (`avatar.read`)",
  "avatar.report": "the bundled stage's report of the renderer it drew for a bot (`avatar.report`, the `clover` tree only)",
};

describe("plugin.layer.call, as a class", () => {
  test("every call is in the table, and the method takes no plugin id, session or bot (the connection's plugin, never a parameter)", () => {
    const shape = (CLOVER_METHODS.get("plugin.layer.call")!.params as unknown as { shape: { call: { options: string[] } } }).shape;
    expect([...shape.call.options].sort()).toEqual(Object.keys(OWN_CALLS).sort());
    expect(Object.keys(shape).sort()).toEqual(["args", "call"]);
    expect(pluginIdKeys("plugin.layer.call")).toEqual([]);
    expect(CLOVER_METHODS.get("plugin.layer.call")!.capability).toBeUndefined();
  });

  test("every call the SDK's layer makes through it, and every layer-callable avatar call the catalog lists, is accepted by its params", () => {
    const params = CLOVER_METHODS.get("plugin.layer.call")!.params as unknown as { safeParse(v: unknown): { success: boolean } };
    // What the layer's own code sends: each `plugin.layer.call` with a literal `call`.
    const src = readFileSync(join(import.meta.dir, "../../../../plugin-sdk/src/ui/index.tsx"), "utf8");
    const sent = [...src.matchAll(/"plugin\.layer\.call",\s*\{\s*call:\s*"([^"]+)"/g)].map((m) => m[1]!);
    expect(sent.length).toBeGreaterThan(5);
    // The catalog's avatar calls a layer may make (a watch is the layer's event stream, not a call).
    const catalog = Object.entries(API_CALLS as Record<string, { where: string }>).filter(([n, c]) => n.startsWith("avatar.") && n !== "avatar.watch" && (c.where === "ui" || c.where === "both")).map(([n]) => n);
    expect(catalog.sort()).toEqual(["avatar.box", "avatar.catalogue", "avatar.cue", "avatar.report"]);
    for (const call of new Set([...sent, ...catalog])) expect([call, params.safeParse({ call, args: [] }).success]).toEqual([call, true]);
  });
});
