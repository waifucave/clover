// The island's strip from the pending cards' metas (its host maps them; the island draws them).
import { describe, expect, test } from "bun:test";
import { islandCards, type CardMeta } from "../src/model/strip-cards";

describe("the island's strip", () => {
  test("reads the pending cards' metas: elicitation draws as a link, the rest as approvals", () => {
    expect(islandCards([])).toEqual([]);
    const meta: CardMeta = {
      id: "card_1", kind: "tool", computer: "Laptop", issuedAt: 7, 
      options: [{ id: "allow_once", kind: "approve" }, { id: "deny", kind: "deny" }],
    };
    expect(islandCards([meta])).toEqual([{
      id: "card_1", kind: "approval", tool: true, computer: "Laptop", issuedAt: 7,
      options: [{ id: "allow_once", kind: "approve" }, { id: "deny", kind: "deny" }],
    }]);
    // A link request draws as a link; no computer and no options fall back to the island's own defaults.
    const link: CardMeta = { ...meta, id: "card_2", kind: "elicitation", computer: null, options: [] };
    expect(islandCards([link])).toEqual([
      { id: "card_2", kind: "link", issuedAt: 7 },
    ]);
  });
});
