// The broker's cards to the router (lane RT, spec revision 19 §3.5): every pending card is placed, and leaves every place
// once it is answered, expires, or is withdrawn or cancelled. The router reads a card's session and bot only.
//
// The press gate on this computer's own app connections (`cardPressGate`): a card is answered from the place the router
// put it, by the program and window drawing it there, never forwarded from one program to another. The program is the
// connection's (`MossConn.program`, from the door), the window that connection's own presence report, the island the
// connection that draws it; nothing comes from the call's params. A paired device (`remote`, `peer`) and the test
// harness's own `cli` are not this computer's surfaces and are not gated here (item 91: every device still shows a
// pending card, and the first answer wins).
import type { Card } from "@waifucave/moss-protocol";
import type { ApprovalBroker } from "../contracts/approval-broker";
import type { CardRouter } from "../contracts/card-router";
import type { Unsubscribe } from "../contracts/common";
import type { EngineCardRouter } from "./card-router";
import type { EngineSurfaceDoor } from "./door";

const routed = (c: Card) => ({ id: c.id, ...(c.session !== undefined ? { session: c.session } : {}), ...(c.bot !== undefined ? { bot: c.bot } : {}) });

export function routeBrokerCards(broker: Pick<ApprovalBroker, "watch" | "cards">, router: Pick<CardRouter, "pending" | "resolved">): Unsubscribe {
  const off = broker.watch((e) => {
    if (e.type === "requested") router.pending(routed(e.card));
    else router.resolved(e.cardId);
  });
  // What waits already (a broker that came up before the routing, or a new broker after a swap).
  for (const c of broker.cards()) router.pending(routed(c));
  return off;
}

/** Why a press from this app connection may not answer the card now, or undefined when it may. */
export function cardPressGate(s: { door: Pick<EngineSurfaceDoor, "programOf" | "islandDrawer">; router: Pick<EngineCardRouter, "placementOf" | "windowsOf" | "mayPress"> }, connId: number, cardId: string): string | undefined {
  const program = s.door.programOf(connId);
  if (program === undefined) return "this connection draws no cards";
  const place = s.router.placementOf(cardId);
  // A card the router hasn't placed (it isn't pending here): the broker answers for it (unknown, or already answered).
  if (place === undefined) return undefined;
  if (place.kind === "elsewhere") {
    // lane HS (the reviewer's B2, never nowhere): nothing draws the island, so MOSS Code's window shows the card on its own
    // fallback card: a press from a window that connection reports is taken (the router's rule), never one from MOSS.
    const own = s.router.windowsOf(connId).find((w) => w.program === "code");
    return own !== undefined && s.router.mayPress(cardId, { kind: "window", program: "code", window: own.window }) ? undefined : "this card isn't drawn on this computer now";
  }
  if (place.kind === "island") {
    return s.door.islandDrawer(connId) && s.router.mayPress(cardId, { kind: "island" }) ? undefined : "this card is on the island now";
  }
  if (place.program !== program) return "this card is drawn in another program's window now";
  const mine = s.router.windowsOf(connId).some((w) => w.program === place.program && w.window === place.window);
  return mine && s.router.mayPress(cardId, { kind: "window", program: place.program, window: place.window }) ? undefined : "this card is drawn in another window now";
}
