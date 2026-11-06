// The island's stylesheet, injected once per document the first time a part mounts. A plugin's
// component code owns its own styles inside its layer (spec §5.5); themes reach it through tokens.

import { useInsertionEffect } from "react";
import css from "./island.css" with { type: "text" };

export const ISLAND_CSS: string = css;
const ID = "clover-island-styles";

export function ensureIslandStyles(doc: Document | undefined = globalThis.document): void {
  if (!doc || doc.getElementById(ID)) return;
  const style = doc.createElement("style");
  style.id = ID;
  style.textContent = css;
  doc.head.appendChild(style);
}

export function useIslandStyles(): void {
  useInsertionEffect(() => ensureIslandStyles(), []);
}
