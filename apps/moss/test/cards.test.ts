// The cards MOSS draws show what they approve in full: a bot making a bot (lane BT's MakeBot, a `confirm` card) puts the new
// bot's whole instructions in its `command` field, and MOSS's own card page (sealed-pages.ts `ownCardPage`) carries every
// character of it, never a shortened copy.
import { describe, expect, test } from "bun:test";
import { ownCardPage } from "../src/main/sealed-pages";

describe("a MakeBot card in MOSS's window", () => {
  test("shows the new bot's instructions in full", () => {
    const instructions = Array.from({ length: 120 }, (_, i) => `Line ${i + 1}: Nova answers kindly and checks the weather twice.`).join("\n");
    const html = ownCardPage({
      cardId: "card_makebot01", token: "se_x", origin: "bot", issuedAt: 1, expiresAt: null, computer: null,
      fields: {
        title: { type: "text", text: "Make a new bot?" },
        what: { type: "text", text: "A bot of yours wants to make a new bot." },
        detail: { type: "rows", rows: [{ label: "Name", value: "Nova" }, { label: "Made by", value: "Juniper" }] },
        command: { type: "code", code: instructions },
      },
      options: [{ id: "deny", kind: "deny", label: "Don't make it" }, { id: "allow_once", kind: "approve", label: "Make Nova" }],
    });
    for (const line of instructions.split("\n")) expect(html).toContain(line);
    expect(html).toContain("Line 120:");
  });
});
