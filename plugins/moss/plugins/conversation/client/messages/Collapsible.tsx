import { useId, useState, type ReactNode } from "react";
import { S } from "../strings";

/** Text past this many lines or characters starts folded. Measured from the text, not the layout,
 *  so the decision is the same everywhere it renders. */
export const FOLD_LINES = 12;
export const FOLD_CHARACTERS = 900;

export function isLong(text: string): boolean {
  return text.length > FOLD_CHARACTERS || text.split("\n").length > FOLD_LINES;
}

/** A long body, folded to a few lines with "Show more" under it. */
export function Collapsible({ text, children }: { text: string; children: ReactNode }) {
  const long = isLong(text);
  const [open, setOpen] = useState(false);
  const id = useId();
  if (!long) return <>{children}</>;
  return (
    <div className="cl-conv-fold" data-open={open || undefined}>
      <div className="cl-conv-fold__body" id={id}>
        {children}
      </div>
      <button type="button" className="cl-conv-fold__toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
        {open ? S.showLess : S.showMore}
      </button>
    </div>
  );
}
