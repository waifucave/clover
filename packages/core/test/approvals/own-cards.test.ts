// What plain `approvals` means now that no plugin has a bot (the owner's ruling of 2026-11-17): a plugin's own cards are the
// cards raised by calls to THAT PLUGIN'S OWN TOOLS, in any session or bot's turn, and the cards of a bot whose record says it
// was moved from that plugin. `approvals.all` stays every card. The core writes a card's owners (`ownedBy`) from the router's
// binding of the call and the bot's record; the events (`card_pending`, `card_resolved`) and `card.pending` read them.
import { afterEach, describe, expect, test } from "bun:test";
import type { Caller, Card, MossRole } from "@waifucave/moss-protocol";
import { MossApprovalBroker, ownedByOf } from "../../src/approvals/broker";
import { botApprovalCheck } from "../../src/approvals/bot-check";
import { approvalCoreEvents, cardAudience } from "../../src/approvals/core-events";
import { cardMethods } from "../../src/approvals/card-methods";
import type { ApprovalRequest } from "../../src/contracts/approval-broker";
import { FakeClock } from "../../src/contracts/fakes/clock";
import { sendCoreEvent } from "../../src/ipc/core-events";
import type { MossConn } from "../../src/ipc/moss";
import type { BotSessionContext } from "../../src/bots/service";
import { registerBotOwnership } from "../../src/runtime-sdk/turn-loop/only-backends";

let seq = 0;
function layer(pluginId: string) {
  const got: [string, { type: string; card?: { id: string } }][] = [];
  const c = {
    connId: ++seq, role: "layer" as MossRole, caller: { kind: "plugin", pluginId } as Caller, features: [], clientName: "layer",
    areas: new Set(["approvals"]), follows: new Map(), send: () => "x",
    notify: (method: string, params: unknown) => { got.push([method, params as { type: string }]); },
  } as unknown as MossConn;
  return { c, got, types: () => got.map(([, e]) => e.type) };
}

/** A tool card's request as the approval check makes it: a code session's (no bot) or a bot's, of `toolPlugin`'s tool or none. */
const toolCard = (o: { session?: string; bot?: string; toolPlugin?: string } = {}): ApprovalRequest => ({
  kind: "tool", session: o.session ?? "agent_s1", origin: "user", computers: ["Studio"], effect: "execute",
  ...(o.bot === undefined ? {} : { bot: o.bot }), ...(o.toolPlugin === undefined ? {} : { toolPlugin: o.toolPlugin }),
  fields: { title: { type: "text", text: "Run a tool" } },
});

async function shown(broker: MossApprovalBroker, req: ApprovalRequest): Promise<Card> {
  const card = new Promise<Card>((resolve) => { const off = broker.watch((e) => { if (e.type === "requested") { off(); resolve(e.card); } }); });
  void broker.request(req);
  return card;
}

const offs: (() => void)[] = [];
afterEach(() => { for (const off of offs.splice(0)) off(); });

describe("a card's owners, as the core writes them", () => {
  test("a call to a plugin's tool names that plugin (its top-level id), in a code session or a bot's turn; a core tool's card names none", () => {
    expect(ownedByOf({ toolPlugin: "acme" })).toEqual({ ownedBy: ["acme"] });
    expect(ownedByOf({ toolPlugin: "acme/tools" })).toEqual({ ownedBy: ["acme"] });
    expect(ownedByOf({})).toEqual({});
    expect(ownedByOf({ toolPlugin: "not a plugin id!" })).toEqual({});
  });

  test("with bots as records: a bot moved from a plugin names it; a bot no plugin moved names none, whatever its id", () => {
    offs.push(registerBotOwnership((bot) => (bot === "alpha" ? { known: true } : bot === "luna" ? { known: true, plugin: "luna-plugin" } : { known: false })));
    expect(ownedByOf({ bot: "alpha" })).toEqual({});
    expect(ownedByOf({ bot: "luna" })).toEqual({ ownedBy: ["luna-plugin"] });
    expect(ownedByOf({ bot: "alpha", toolPlugin: "acme" })).toEqual({ ownedBy: ["acme"] });
    expect(ownedByOf({ bot: "luna", toolPlugin: "luna-plugin" })).toEqual({ ownedBy: ["luna-plugin"] });
    expect(ownedByOf({ bot: "stranger" })).toEqual({});
  });

  test("the broker's card carries them, and a requester's own words never do", async () => {
    const broker = new MossApprovalBroker({ clock: new FakeClock(), levels: () => "ask" });
    expect((await shown(broker, toolCard({ toolPlugin: "acme" }))).ownedBy).toEqual(["acme"]);
    expect((await shown(broker, toolCard())).ownedBy).toBeUndefined();
    // A field named like it on the request is not read: only `toolPlugin` (the check's) and the bot's record are.
    expect((await shown(broker, { ...toolCard(), ownedBy: ["sol"] } as unknown as ApprovalRequest)).ownedBy).toBeUndefined();
  });
});

describe("the approval check names the plugin the router binds a call to", () => {
  const ctx = { botId: undefined, sessionId: "agent_s1", kind: "coding", computer: "Studio", paths: { scratch: "/tmp/x", root: "/tmp/x" }, caller: { kind: "session", sessionId: "agent_s1" } } as unknown as BotSessionContext;
  async function requestOf(tool: string): Promise<ApprovalRequest> {
    const got: ApprovalRequest[] = [];
    const check = botApprovalCheck({ request: async (r) => { got.push(r); return { allowed: true, by: "user" } as never; } }, {
      hostTools: () => ["Glossary", "SendMessage"],
      toolPlugin: (_c, t) => (t === "mcp__acme-tools__Export" ? "acme" : t === "Glossary" ? "acme" : undefined),
    });
    await check(ctx, () => "user")(tool, {}, { signal: new AbortController().signal, toolUseID: "t", requestId: "r" } as never);
    return got[0]!;
  }
  test("a plugin tool's call: its plugin; a core tool's: none, whatever the router says; a call it binds to nothing: none", async () => {
    expect((await requestOf("mcp__acme-tools__Export")).toolPlugin).toBe("acme");
    expect((await requestOf("Glossary")).toolPlugin).toBeUndefined();
    expect((await requestOf("mcp__other__Thing")).toolPlugin).toBeUndefined();
  });
});

describe("who is told of a card, and lists it, with plain approvals", () => {
  function setup() {
    const clock = new FakeClock();
    const broker = new MossApprovalBroker({ clock, levels: () => "ask" });
    const acme = layer("acme"), acmePart = layer("acme/panel"), sol = layer("sol"), island = layer("moss/island"), noCap = layer("plain");
    const holds: Record<string, string[]> = { "moss/island": ["approvals", "approvals.all"], plain: [] };
    const caps = (id: string) => holds[id] ?? ["approvals"];
    const r = { connections: () => [acme.c, acmePart.c, sol.c, island.c, noCap.c], pluginCapabilities: caps };
    offs.push(approvalCoreEvents(broker, (e, o) => sendCoreEvent(r, e, o), () => clock.now()));
    return { broker, acme, acmePart, sol, island, noCap, caps };
  }

  test("a call to acme's tool in a code session: acme's parts hear it pending and resolved, and list it; sol never does", async () => {
    const w = setup();
    const p = w.broker.request(toolCard({ toolPlugin: "acme" }));
    await Bun.sleep(0);
    expect(w.acme.types()).toEqual(["card_pending"]);
    expect(w.acmePart.types()).toEqual(["card_pending"]);
    expect(w.island.types()).toEqual(["card_pending"]);
    expect(w.sol.types()).toEqual([]);
    const m = cardMethods(() => w.broker, w.caps);
    const list = async (id: string) => ((await m["card.pending"]!({ role: "layer", caller: { kind: "plugin", pluginId: id } } as never, {})) as { cards: { id: string }[] }).cards.map((c) => c.id);
    const id = w.acme.got[0]![1].card!.id;
    expect(await list("acme")).toEqual([id]);
    expect(await list("sol")).toEqual([]);
    expect(await list("moss/island")).toEqual([id]);
    w.broker.cancelSession("agent_s1");
    await p;
    expect(w.acme.types()).toEqual(["card_pending", "card_resolved"]);
    expect(w.sol.types()).toEqual([]);
  });

  test("a bot's call to acme's tool is acme's too; another plugin's tool's card, a core tool's card and a session's card of no tool are not", async () => {
    const w = setup();
    offs.push(registerBotOwnership(() => ({ known: true })));
    void w.broker.request(toolCard({ session: "b_alpha", bot: "alpha", toolPlugin: "acme" }));
    void w.broker.request(toolCard({ session: "agent_s2", toolPlugin: "sol" }));
    void w.broker.request(toolCard({ session: "agent_s3" }));
    void w.broker.request(toolCard({ session: "b_alpha", bot: "alpha" }));
    await Bun.sleep(0);
    expect(w.acme.got.map(([, e]) => e.type)).toEqual(["card_pending"]);
    expect(w.sol.got.map(([, e]) => e.type)).toEqual(["card_pending"]);
    expect(w.acme.got[0]![1].card!.id).not.toBe(w.sol.got[0]![1].card!.id);
    expect(w.island.types()).toEqual(["card_pending", "card_pending", "card_pending", "card_pending"]);
  });

  test("a plugin named in a card's owners but without `approvals` hears nothing; `approvals.all` alone hears nothing", () => {
    expect(cardAudience({ ownedBy: ["plain"] })("plain", [])).toBe(false);
    expect(cardAudience({ ownedBy: ["acme"] })("acme", ["approvals"])).toBe(true);
    expect(cardAudience({})("acme", ["approvals"])).toBe(false);
    expect(cardAudience({})("island", ["approvals.all"])).toBe(false);
    expect(cardAudience({})("island", ["approvals", "approvals.all"])).toBe(true);
  });
});
