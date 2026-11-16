// The island tab's scroller and empty line, this plugin's copy (F2b: no plugin imports another's folder; the class names
// are the island's, whose stylesheet draws them in its window).
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { Glyph } from "./glyphs";

/**
 * A tab's body inside the open island's fixed size: it scrolls (or, in the gallery, lies flat and cut), and
 * where more of the list lies beyond an edge the island says so OUTSIDE the list — a hairline on the
 * list's own top border when more lies above, a chevron in a band of its own below it when more lies
 * below (the Swift reference's `IslandScrollEdges` faded the edges with a mask instead, which here would hide the
 * sealed parts inside). Judged on scroll and on a change of size, never on a timer.
 */
export function TabScroll({ scrolls = true, children }: { scrolls?: boolean; children: ReactNode }): ReactElement {
  const ref = useRef<HTMLDivElement | null>(null);
  const [edges, setEdges] = useState({ top: false, bottom: false });
  const judge = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const next = scrollEdges(el.scrollTop, el.clientHeight, el.scrollHeight);
    setEdges((e) => (e.top === next.top && e.bottom === next.bottom ? e : next));
  }, []);
  useLayoutEffect(judge);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(judge);
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    return () => observer.disconnect();
  }, [judge]);
  return (
    <>
      <div ref={ref} className={scrolls ? "clv-tab-scroll" : "clv-tab-flat"} data-scrolls="" data-more-above={edges.top || undefined} onScroll={judge}>
        {children}
      </div>
      <div className="clv-more" aria-hidden="true" data-more-below={edges.bottom || undefined}>
        {edges.bottom ? <Glyph name="chevronDown" size={9} /> : null}
      </div>
    </>
  );
}

/** Where a scrolled list has more beyond its edges (half a pixel's grace). */
export function scrollEdges(scrollTop: number, clientHeight: number, scrollHeight: number): { top: boolean; bottom: boolean } {
  return { top: scrollTop > 0.5, bottom: scrollTop + clientHeight < scrollHeight - 0.5 };
}

export function EmptyTab({ line }: { line: string }): ReactElement {
  return (
    <div className="clv-empty">
      <Glyph name="checkCircle" />
      <span>{line}</span>
    </div>
  );
}
