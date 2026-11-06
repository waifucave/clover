// The pill's stylesheet, injected once per document the first time a part mounts. A plugin's component
// code owns its own styles inside its layer (spec §5.5); themes reach it through tokens.

import { useInsertionEffect } from "react";
import css from "./pill.css" with { type: "text" };

export const PILL_CSS: string = css;
const ID = "clover-pill-styles";

export function ensurePillStyles(doc: Document | undefined = globalThis.document): void {
  if (!doc || doc.getElementById(ID)) return;
  const style = doc.createElement("style");
  style.id = ID;
  style.textContent = css;
  doc.head.appendChild(style);
}

export function usePillStyles(): void {
  useInsertionEffect(() => ensurePillStyles(), []);
}
