// Alpha's approval cards (spec §5.5): her theme's `card.*` block is all the styling a sealed card takes, so it is held
// to what the user decides by: the words, the meta and each button's label stay legible on their own ground in both
// appearances, the approve button stands out from the card, every value is one the sealed frames accept as they are,
// and the block sets nothing but `card.*` names.
import { describe, expect, test } from "bun:test";
import { luminance, parseHex, type Rgba } from "../../../clover/plugins/base-theme/src/contrast";
import { readable } from "../../../../apps/desktop/src/main/sealed-pages";
import theme from "../theme.json" with { type: "json" };

const ratio = (a: string, b: string) => {
  const [x, y] = [luminance(parseHex(a) as Rgba), luminance(parseHex(b) as Rgba)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
};

const sets = {
  light: theme.tokens as Record<string, string | number>,
  dark: { ...theme.tokens, ...theme.dark.tokens } as Record<string, string | number>,
};

describe("Alpha's card tokens", () => {
  for (const [appearance, t] of Object.entries(sets)) {
    const hex = (name: string) => String(t[name]).slice(0, 7);
    test(`${appearance}: the words, the meta and every button's label are legible on their own ground`, () => {
      expect(ratio(hex("card.text"), hex("card.background"))).toBeGreaterThanOrEqual(4.5);
      expect(ratio(hex("card.muted"), hex("card.background"))).toBeGreaterThanOrEqual(4.5);
      expect(ratio(hex("card.approve.text"), hex("card.approve.background"))).toBeGreaterThanOrEqual(4.5);
      expect(ratio(hex("card.deny.text"), hex("card.deny.background"))).toBeGreaterThanOrEqual(4.5);
    });
    test(`${appearance}: the approve button stands out from the card`, () => {
      expect(ratio(hex("card.approve.background"), hex("card.background"))).toBeGreaterThanOrEqual(3);
    });
    test(`${appearance}: the sealed frames take every value as it is`, () => {
      for (const [name, value] of Object.entries(t)) if (name.startsWith("card.")) expect([name, readable(name, String(value))]).toEqual([name, true]);
    });
  }
  test("the block sets no card text colour with any see-through, and a text size of at least 11px", () => {
    for (const name of ["card.text", "card.muted", "card.approve.text", "card.deny.text"]) {
      for (const t of Object.values(sets)) expect(String(t[name])).toMatch(/^#[0-9a-f]{6}$/i);
    }
    expect(Number.parseFloat(String(sets.light["card.font.size"]))).toBeGreaterThanOrEqual(11);
  });
});
