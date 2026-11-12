import { useEffect, useRef, useState } from "react";
import { drawsMeadow, grassMarkup } from "./meadow-art";

/** The grass and clovers in front of her figure (D's art, painted to this slot's own size), so she stands in the meadow and the figure's cut-off bottom is hidden. */
export function Grass({ scene, dark, className }: { scene: string; dark: boolean; className: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let settle: ReturnType<typeof setTimeout> | undefined;
    const take = () => setSize((s) => (s.w === el.clientWidth && s.h === el.clientHeight ? s : { w: el.clientWidth, h: el.clientHeight }));
    take();
    const ro = new ResizeObserver(() => { if (settle) clearTimeout(settle); settle = setTimeout(take, 120); });
    ro.observe(el);
    return () => { if (settle) clearTimeout(settle); ro.disconnect(); };
  }, []);
  const shown = drawsMeadow(scene);
  useEffect(() => {
    const el = host.current;
    if (el) el.innerHTML = shown && size.w > 0 && size.h > 0 ? grassMarkup(size.w, size.h, dark) : "";
  }, [shown, size.w, size.h, dark]);
  return <div ref={host} className={className} />;
}

