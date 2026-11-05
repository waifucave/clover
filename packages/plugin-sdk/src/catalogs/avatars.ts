// The avatar formats (the owner's decision of November 5, amending §5.5 and §6's "VRM by default"): avatars are VRM or
// Live2D Cubism models. The bot stage's `avatar` spot is keyed by format, so a plugin may bring another; these two are
// the app's own. Live2D is drawn by Mochi2D (`waifucave/Mochi2D`), the owner's clean-room Cubism runtime, and Alpha's
// avatar is a Live2D model.

export interface AvatarFormatInfo {
  readonly format: string;
  /** What `file` names. */
  readonly entry: string;
  readonly renderer: string;
}

export const AVATAR_FORMATS: readonly AvatarFormatInfo[] = [
  { format: "vrm", entry: "a `.vrm` file", renderer: "the bundled VRM renderer (three-vrm)" },
  {
    format: "live2d",
    entry: "a Cubism `.model3.json` file, with the files it names beside it, or a `.zip` holding one",
    renderer: "Mochi2D (`waifucave/Mochi2D`), the owner's clean-room Cubism runtime",
  },
];

/** What's wrong with an avatar's `file` for its format, or undefined. A format the app doesn't draw itself isn't
 *  checked here: its renderer plugin knows its files. */
export function avatarFileProblem(format: string, file: string): string | undefined {
  const f = file.toLowerCase();
  if (format === "vrm" && !f.endsWith(".vrm")) return "a `vrm` avatar's file is a `.vrm` file";
  if (format === "live2d" && !f.endsWith(".model3.json") && !f.endsWith(".zip")) {
    return "a `live2d` avatar's file is a Cubism `.model3.json` file or a `.zip` holding one";
  }
  return undefined;
}

/** The files a Cubism `model3.json` names, relative to it (`FileReferences`): the moc, textures, physics, pose, display
 *  info, expressions and motions with their sounds. Null when it isn't a `model3.json`. */
export function live2dReferences(model3: unknown): string[] | null {
  if (typeof model3 !== "object" || model3 === null) return null;
  const refs = (model3 as { FileReferences?: unknown }).FileReferences;
  if (typeof refs !== "object" || refs === null) return null;
  const r = refs as Record<string, unknown>;
  if (typeof r.Moc !== "string" || !Array.isArray(r.Textures) || !r.Textures.every((t) => typeof t === "string")) return null;
  const out: string[] = [r.Moc, ...(r.Textures as string[])];
  for (const key of ["Physics", "Pose", "DisplayInfo", "UserData"]) if (typeof r[key] === "string") out.push(r[key] as string);
  if (Array.isArray(r.Expressions)) for (const e of r.Expressions) if (typeof (e as { File?: unknown })?.File === "string") out.push((e as { File: string }).File);
  if (typeof r.Motions === "object" && r.Motions !== null) {
    for (const group of Object.values(r.Motions as Record<string, unknown>)) {
      if (!Array.isArray(group)) continue;
      for (const m of group) {
        const motion = m as { File?: unknown; Sound?: unknown };
        if (typeof motion?.File === "string") out.push(motion.File);
        if (typeof motion?.Sound === "string") out.push(motion.Sound);
      }
    }
  }
  return out;
}
