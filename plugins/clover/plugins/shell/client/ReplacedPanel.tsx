// A bot's own replacement for a stock panel (its Browser, its agent's tab) on that bot's tab, and the way back: a
// replacement that has not drawn two seconds after it was placed (its frame reported no size), or whose layer stopped,
// gives way to the stock panel the shell places in its stead (`<Spot entry="stock">`), and the panel's header says so and
// offers to try the bot's again. The replacement is given the stock panel's props without `header` (it draws its own
// head in its body, the host's title stays above it).
import { useEffect, useRef } from "react";
import { Spot } from "./sdk";
import type { ReactNode } from "react";

/** How long a replacement has to report its first size (the frame drew) before the stock panel takes its place. */
export const DRAW_WAIT_MS = 2000;

export interface ReplacedPanelProps {
  id: string;
  /** The stock panel's props (`app`, `session`, `bot`, ...); `header` is added only for the stock panel. */
  props: Record<string, unknown>;
  header: HTMLElement | null;
  usedLast: boolean;
  /** The replacement did not draw (or stopped): show the stock panel. */
  fell: boolean;
  onFell: (id: string) => void;
  empty: ReactNode;
  /** The bot whose tab shows: a plugin's own panel for it is found in that bot's context (the shell's document is the whole window's). */
  bot: string;
}

export function ReplacedPanel({ id, props, header, usedLast, fell, onFell, empty, bot }: ReplacedPanelProps) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (fell) return;
    const el = root.current;
    if (el === null) return;
    let drawn = false;
    const state = () => {
      if (el.querySelector("[data-clover-gone], .clover-part-stopped") !== null) return "stopped";
      const frames = [...el.querySelectorAll("iframe[data-clover-entry]")];
      if (frames.length > 0 && frames.every((f) => f.hasAttribute("data-clover-drawn"))) return "drawn";
      // An inline part (not a frame) draws as it mounts.
      if (frames.length === 0 && el.querySelector("[data-clover-spot] > *") !== null) return "drawn";
      return "waiting";
    };
    const look = () => {
      const s = state();
      if (s === "stopped") onFell(id);
      else if (s === "drawn") drawn = true;
    };
    const timer = window.setTimeout(() => {
      if (!drawn && state() !== "drawn") onFell(id);
    }, DRAW_WAIT_MS);
    const watch = new MutationObserver(look);
    watch.observe(el, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-clover-drawn", "data-clover-gone"] });
    look();
    return () => {
      window.clearTimeout(timer);
      watch.disconnect();
    };
  }, [fell, id]);
  return (
    <div ref={root} className="cl-panel__replaced" data-replaced-panel={id} data-fell={fell || undefined} style={{ display: "contents" }}>
      {fell ? (
        <Spot name="panel" spotKey={id} entry="stock" forBot={bot} props={{ ...props, header, usedLast }} fallback={empty} />
      ) : (
        <Spot name="panel" spotKey={id} forBot={bot} props={{ ...props, usedLast }} fallback={empty} />
      )}
    </div>
  );
}
