// The fixture's own part: the sdk's real Card (the sealed path's legal place), its buttons only (a card's field is
// its own display; a clean UI shows the two buttons and nothing else, §5.5), at fixed places on screen so the test's
// clicks land. The SDK's sealed frames come as URLs the runtime minted; the iframe's html is the app's own.
import { useRef, useState, createElement as h } from "react";
import { Card, useApprovals } from "@waifucave/clover-plugin-sdk/ui";

export function CardEntry({ props, tokens, entry }) {
  void props;
  void tokens;
  void entry;
  const [cards] = useState(useApprovals()[0] ? [] : []);
  const approve = useRef(null);
  const deny = useRef(null);
  return h("div", { style: { position: "fixed", inset: 0 } },
    h(Card, { id: `card_${props.cardId ?? "fixture_1"}`, className: "fc-card" },
      h("div", { ref: approve, "data-cl-fc": "approve", style: { position: "fixed", left: 20, top: 20, width: 240, height: 80 } },
        h(Card.Approve, {})),
      h("div", { ref: deny, "data-cl-fc": "deny", style: { position: "fixed", left: 20, top: 120, width: 240, height: 80 } },
        h(Card.Deny, {}))));
}
