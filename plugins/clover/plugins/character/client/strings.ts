// The avatar section's words (the bot editor's `bot.editor.section` entry this part fills).
const or = (xs: readonly string[]) => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} or ${xs[xs.length - 1]}`);

export const S = {
  avatar: "Avatar",
  avatarDetail: "Avatar packs are plugins. Each adds avatar files with their portraits.",
  noAvatars: "No avatar packs are installed yet. Find one in the plugin index.",
  /** No renderer is installed and on: nothing here can draw an avatar, so no pack and no import is offered. */
  noRenderer: "Nothing installed can draw avatars yet. Install or turn on a renderer plugin (VRM, Live2D or another) and this section offers avatars again.",
  chooseAvatar: "Choose avatar…",
  chooseFolder: "Choose a folder instead",
  chosen: (name: string) => `Picked: ${name}`,
  importAvatar: "Import and use",
  replaces: "This replaces the avatar you imported before.",
  importing: "Importing…",
  pickCancelled: "Nothing picked.",
  imported: (format: string, files: number, size: string) => `Imported a ${format} model (${files} ${files === 1 ? "file" : "files"}, ${size}). It is the avatar now.`,
  failed: (why: string) => `That didn't work: ${why}`,
  credit: "From the model's own notes",
  creditEdit: "Credit note",
  creditSave: "Save note",
  creditClear: "Clear",
  reset: "Reset",
  resetAvatar: "Reset the avatar",
  waiting: "Waiting for your answer on the card.",
  /** What the installed renderers import (`avatar.formats`), each format's ways in its own words. */
  avatarOwnDetail: (takes: readonly string[]) => `Your own model: ${takes.join("; ")}. It is copied into Clover; the original stays where it is.`,
  /** One format's ways in: "a folder or .zip with a .model3.json (Live2D (Cubism))", "a .vrm or .glb file (VRM)". */
  avatarTakes: (name: string, held: readonly string[], files: readonly string[]) => [
    ...(held.length > 0 ? [`a folder or .zip with a ${or(held)}`] : []),
    ...(files.length > 0 ? [`a ${or(files)} file`] : []),
  ].join(", or ") + ` (${name})`,
  avatarFrom: (pack: string) => `From ${pack}`,
} as const;
