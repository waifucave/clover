// What a bundled avatar renderer takes from the app to be cued and to say what it has and where it stands: the shape of the
// plugin SDK's `useAvatarControl()` (`AvatarControl`), spelt out here so a renderer needs no SDK of its own (the app's
// host wrapper hands the SDK's hook value in as the `control` prop; the types are structurally the SDK's, and a test
// holds them together). Plain data both ways.

export type FigureCue =
  | { readonly type: "expression"; readonly name: string }
  | { readonly type: "motion"; readonly name: string }
  | { readonly type: "outfit"; readonly part: string; readonly on: boolean }
  | { readonly type: "pace"; readonly calm: boolean }
  | { readonly type: "lookAt"; readonly point: { readonly x: number; readonly y: number } | null };

export interface FigureNames {
  readonly expressions: readonly string[];
  readonly motions: readonly string[];
  readonly outfits: readonly { readonly name: string; readonly on: boolean }[];
}

export interface FigurePoint { readonly x: number; readonly y: number }
/** The figure on the stage, in the avatar element's own pixels from its top left. */
export interface FigureBox {
  readonly canvas: { readonly width: number; readonly height: number };
  readonly figure?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly anchors?: Readonly<Partial<Record<"headTop" | "face" | "mouth" | "chest", FigurePoint>>>;
}

export interface FigureControl {
  onCue(listener: (cue: FigureCue) => void): () => void;
  setCatalogue(names: FigureNames | undefined): void;
  setBox(box: FigureBox | undefined): void;
}

/** A figure's box from its bounding rectangle in the avatar element's pixels: the anchors at the proportions of a
 *  portrait (head top at the rectangle's top, face a fifth down, mouth a quarter, chest two fifths), an estimate that
 *  says where the face is, not an exact landmark. */
export function boxFromRect(canvas: { width: number; height: number }, r: { x: number; y: number; width: number; height: number }): FigureBox {
  const cx = r.x + r.width / 2;
  const at = (f: number): FigurePoint => ({ x: Math.round(cx), y: Math.round(r.y + r.height * f) });
  return {
    canvas: { width: Math.round(canvas.width), height: Math.round(canvas.height) },
    figure: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
    anchors: { headTop: at(0), face: at(0.2), mouth: at(0.26), chest: at(0.42) },
  };
}
