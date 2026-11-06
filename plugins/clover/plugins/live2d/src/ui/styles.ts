// The Live2D renderer's stylesheet, injected once per document the first time an avatar mounts.

import { useInsertionEffect } from "react";
import css from "./avatar.css" with { type: "text" };

export const LIVE2D_CSS: string = css;
const ID = "clover-live2d-styles";

export function ensureLive2dStyles(doc: Document | undefined = globalThis.document): void {
  if (!doc || doc.getElementById(ID)) return;
  const style = doc.createElement("style");
  style.id = ID;
  style.textContent = css;
  doc.head.appendChild(style);
}

export function useLive2dStyles(): void {
  useInsertionEffect(() => ensureLive2dStyles(), []);
}
