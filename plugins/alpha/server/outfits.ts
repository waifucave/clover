// Her outfits: the three her own model wears, one at a time (its nodes carry the renderer's outfit mark, `extras.clover.outfit`,
// plugins/clover/plugins/vrm/src/placeholder/model.ts `OUTFITS`), and her `outfit` setting, which picks one. The setting is the
// one place her outfit lives: the Edit page's picker, her `toggle_outfit` tool and `/outfit` all write it, and her stage dresses
// her in it. With another avatar picked for her (the user layer's), the setting is ignored and that model's own parts switch as
// they are. Pure: her server's store and her tab's room read it (the tab keeps its own copy, client/outfits.ts; a test holds
// the two, her manifest's options and the model's marks together).
import type { AvatarCue } from "../../../packages/plugin-sdk/src/catalogs/avatar-cues";

/** The setting's key in her manifest. */
export const OUTFIT_SETTING = "outfit";

/** Her outfits, as her model names its parts and her setting's options say them, with their English titles. */
export const OUTFITS = [
  { value: "lilac-dress", title: "Lilac dress" },
  { value: "navy-uniform", title: "Navy uniform" },
  { value: "yellow-raincoat", title: "Yellow raincoat" },
] as const;

export type Outfit = (typeof OUTFITS)[number]["value"];
export const OUTFIT_VALUES: readonly Outfit[] = OUTFITS.map((o) => o.value);
/** What she wears when nothing is set: her look of before the setting. */
export const DEFAULT_OUTFIT: Outfit = "lilac-dress";

export const isOutfit = (v: unknown): v is Outfit => typeof v === "string" && (OUTFIT_VALUES as readonly string[]).includes(v);
/** The outfit a setting's value says; anything else (unset, a value from an older build) is the default. */
export const outfitOf = (value: unknown): Outfit => (isOutfit(value) ? value : DEFAULT_OUTFIT);
export const outfitTitle = (o: Outfit): string => OUTFITS.find((x) => x.value === o)!.title;

/** Whether a model's outfit parts are hers: every one of her outfits is a part of it (her own model's marks). */
export const wearsHerOutfits = (parts: readonly string[]): boolean => OUTFIT_VALUES.every((v) => parts.includes(v));

/** What turning one of her outfits on or off picks: on, that one; off, back to the default if it was the one she wore (an
 *  outfit she doesn't wear stays off); with no `on`, it flips. */
export function pickOutfit(current: Outfit, part: Outfit, on?: boolean): Outfit {
  const want = on ?? part !== current;
  if (want) return part;
  return part === current ? DEFAULT_OUTFIT : current;
}

/** The cues that dress her in `outfit`: the others off first, then it on, so two never show at once. */
export const outfitCues = (outfit: Outfit): AvatarCue[] => [
  ...OUTFIT_VALUES.filter((v) => v !== outfit).map((part) => ({ type: "outfit" as const, part, on: false })),
  { type: "outfit" as const, part: outfit, on: true },
];
