// Her outfits, as her tab reads them: the three her own model wears one at a time, and her `outfit` setting that picks one.
// The tab's copy of server/outfits.ts (her tab's bundle takes nothing from her server's folder); a test holds the two, her
// manifest's options and her model's marks together.

/** An outfit cue (the SDK's `AvatarCue` of type `outfit`, spelt out so her server's tests read this file with no SDK). */
export interface OutfitCue { readonly type: "outfit"; readonly part: string; readonly on: boolean }

export const OUTFIT_SETTING = "outfit";
export const OUTFITS = [
  { value: "lilac-dress", title: "Lilac dress" },
  { value: "navy-uniform", title: "Navy uniform" },
  { value: "yellow-raincoat", title: "Yellow raincoat" },
] as const;
export type Outfit = (typeof OUTFITS)[number]["value"];
export const OUTFIT_VALUES: readonly Outfit[] = OUTFITS.map((o) => o.value);
export const DEFAULT_OUTFIT: Outfit = "lilac-dress";

export const outfitOf = (value: unknown): Outfit => (typeof value === "string" && (OUTFIT_VALUES as readonly string[]).includes(value) ? (value as Outfit) : DEFAULT_OUTFIT);
export const outfitTitle = (o: Outfit): string => OUTFITS.find((x) => x.value === o)!.title;
export const wearsHerOutfits = (parts: readonly string[]): boolean => OUTFIT_VALUES.every((v) => parts.includes(v));
/** The next of her outfits after `o`, for her stage's Outfit button. */
export const nextOutfit = (o: Outfit): Outfit => OUTFIT_VALUES[(OUTFIT_VALUES.indexOf(o) + 1) % OUTFIT_VALUES.length]!;
/** Whether the figure is dressed in `o` and nothing else of hers. */
export const dressedIn = (outfits: readonly { name: string; on: boolean }[], o: Outfit): boolean =>
  OUTFIT_VALUES.every((v) => outfits.find((x) => x.name === v)?.on === (v === o));
/** The cues that dress her in `outfit`: the others off first, then it on. */
export const outfitCues = (outfit: Outfit): OutfitCue[] => [
  ...OUTFIT_VALUES.filter((v) => v !== outfit).map((part) => ({ type: "outfit" as const, part, on: false })),
  { type: "outfit" as const, part: outfit, on: true },
];
