// The fixture's own part: the sdk's real Card (the sealed path's legal place), its buttons only (a card's field is
// its own display; a clean UI shows the two buttons and nothing else, §5.5), at fixed places on screen so the test's
// clicks land. The SDK's sealed frames come as URLs the runtime minted; the iframe's html is the app's own.
import { useRef, useState, createElement as h } from "react";
import { Card, useApprovals } from "@waifucave/moss-plugin-sdk/ui";

export function CardEntry({ props, tokens, entry }) {
  void props;
  void tokens;
  void entry;
  const approve = useRef(null);
  const deny = useRef(null);
  return h("div", { style: { position: "fixed", inset: 0 } },
    h(Card, { id: props.cardId ?? "card_0a1b2c3d", className: "fc-card" },
      h("div", { ref: approve, "data-cl-fc": "approve", style: { position: "fixed", left: 20, top: 20, width: 240, height: 50 } },
        h(Card.Approve, { option: "allow_once" })),
      // Inside the part's frame (the layer's frame keeps an iframe's default 150 px here: the part fills it, so it reports no taller
      // height): at top 120 Deny's 34 px ran past the frame's bottom, read 90% visible and never reported itself showing.
      h("div", { ref: deny, "data-cl-fc": "deny", style: { position: "fixed", left: 20, top: 70, width: 240, height: 60 } },
        h(Card.Deny, { option: "deny" }))));
}
