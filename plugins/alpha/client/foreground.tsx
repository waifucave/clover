// Alpha's foreground: the grass and clovers in front of her figure, along the bottom of the frame her tab gives it (the
// layout stacks it over the stage and under the conversation), so she stands IN the meadow and the figure's cut-off
// bottom is hidden, whatever its size. Drawn to the frame's own size (meadow-art.ts `grassMarkup`), redrawn when that
// changes or the scheme does; it never moves and never takes a pointer. In study, starry and rain (no meadow floor) it
// draws nothing.
import { useEffect, useRef, useState } from "react";
import { useStageState } from "./stage-store";
import { drawsMeadow, grassMarkup } from "./meadow-art";

const darkNow = () => typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;

export function AlphaForeground(_: { props: { bot: { id: string; name: string } } }) {
  const stage = useStageState();
  const host = useRef<HTMLDivElement>(null);
  const [dark, setDark] = useState(darkNow);
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const shown = drawsMeadow(stage.scene);

  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const q = matchMedia("(prefers-color-scheme: dark)");
    const on = () => setDark(q.matches);
    q.addEventListener("change", on);
    return () => q.removeEventListener("change", on);
  }, []);

  // The frame's size, settled (a drag of the window redraws once, at its end).
  useEffect(() => {
    const el = document.documentElement;
    let settle: ReturnType<typeof setTimeout> | undefined;
    const take = () => setSize((s) => (s.w === el.clientWidth && s.h === el.clientHeight ? s : { w: el.clientWidth, h: el.clientHeight }));
    take();
    const ro = new ResizeObserver(() => { if (settle) clearTimeout(settle); settle = setTimeout(take, 120); });
    ro.observe(el);
    return () => { if (settle) clearTimeout(settle); ro.disconnect(); };
  }, []);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    el.innerHTML = shown && size.w > 0 && size.h > 0 ? grassMarkup(size.w, size.h, dark) : "";
  }, [shown, size.w, size.h, dark]);

  return (
    <>
      <div ref={host} className="af" aria-hidden="true" data-art={shown ? (dark ? "night-grass" : "day-grass") : "none"} />
      <style>{`html, body { background: transparent !important; margin: 0; height: 100%; overflow: hidden; pointer-events: none; } .af, .af * { pointer-events: none !important; } .af { position: fixed; inset: 0; contain: strict; }`}</style>
    </>
  );
}
