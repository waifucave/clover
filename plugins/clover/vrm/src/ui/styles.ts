// The avatar's stylesheet, injected once per document the first time it mounts. Themes reach it through tokens.

import { useInsertionEffect } from "react";
import css from "./avatar.css" with { type: "text" };

export const AVATAR_CSS: string = css;
const ID = "clover-vrm-styles";

export function ensureAvatarStyles(doc: Document | undefined = globalThis.document): void {
  if (!doc || doc.getElementById(ID)) return;
  const style = doc.createElement("style");
  style.id = ID;
  style.textContent = css;
  doc.head.appendChild(style);
}

export function useAvatarStyles(): void {
  useInsertionEffect(() => ensureAvatarStyles(), []);
}
