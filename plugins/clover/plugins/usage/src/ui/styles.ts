// The usage plugin's stylesheet, injected once per document the first time one of its parts mounts. A plugin's
// component code owns its own styles inside its layer (spec §5.5); themes reach it through tokens.

import { useInsertionEffect } from "react";
import css from "./usage.css" with { type: "text" };

export const USAGE_CSS: string = css;
const ID = "clover-usage-styles";

export function ensureUsageStyles(doc: Document | undefined = globalThis.document): void {
  if (!doc || doc.getElementById(ID)) return;
  const style = doc.createElement("style");
  style.id = ID;
  style.textContent = css;
  doc.head.appendChild(style);
}

export function useUsageStyles(): void {
  useInsertionEffect(() => ensureUsageStyles(), []);
}
