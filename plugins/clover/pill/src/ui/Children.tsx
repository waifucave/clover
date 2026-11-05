// The child row above the main pill (Winter's `ChildSessionPillsView`): one small pill per agent working for
// the pill's bot. A working child wears its own plume colour, nozzle on its stop circle and dimmed so the
// title stays readable; one that needs the user is ringed in amber; a finished or failed one shows its glyph.
// One child takes the row's whole width, more split it, and past the minimum a "+n" circle stands for the rest.

import type { ReactElement } from "react";
import { usePillStyles } from "./styles";
import { childLayout, entrance, stoppable, type ChildItem } from "../model/children";
import { childPalette, cssRgb, type PlumePalette } from "../model/plume";
import { t } from "../strings";
import { Glyph } from "./glyphs";

/** How strongly a working child's plume shows under its title (whose scrim keeps the words readable over it). */
export const CHILD_PLUME_OPACITY = 0.8;
import { Plume, type FrameTimers, type ScheduledThrow } from "./Plume";

export interface ChildrenProps {
  items: readonly ChildItem[];
  /** The row's width: the main pill's current width, so the row resizes with it. */
  width: number;
  /** Each child's colour slot (`assignPaletteSlots`); a child without one takes its place in the row's. */
  slots?: Readonly<Record<string, number>>;
  /** 0…1 per child id while it rises out of the main pill; absent once in. */
  entering?: Readonly<Record<string, number>>;
  animates?: boolean;
  /** Still plumes at this moment (gallery). */
  stillAt?: number;
  timers?: FrameTimers;
  onOpen?: (id: string) => void;
  onStop?: (id: string) => void;
}

export function Children({ items, width, slots = {}, entering = {}, animates = true, stillAt, timers, onOpen, onStop }: ChildrenProps): ReactElement | null {
  usePillStyles();
  if (items.length === 0) return null;
  const layout = childLayout(items.length, width);
  const visible = items.slice(0, layout.visible);
  return (
    <div className="clp-children" style={{ width }} role="list" aria-label="Agents">
      {visible.map((child, i) => {
        const palette = childPalette(slots[child.id] ?? i);
        const rise = entering[child.id];
        const look = rise === undefined ? null : entrance(rise);
        return (
          <div
            key={child.id}
            role="listitem"
            className="clp-child"
            data-status={child.status}
            style={{
              width: layout.pillWidth,
              ...(look ? { opacity: look.opacity, transform: `translateY(${look.offsetY}px) scale(${look.scale})`, filter: look.blur > 0.25 ? `blur(${look.blur.toFixed(2)}px)` : undefined } : {}),
            }}
            title={child.title}
          >
            {child.status === "working" ? (
              <div className="clp-child-plume" style={{ opacity: CHILD_PLUME_OPACITY }}>
                <Plume
                  width={layout.pillWidth}
                  height={44}
                  palette={palette}
                  seed={hash(child.id)}
                  animates={animates}
                  still={stillAt === undefined ? undefined : { at: stillAt + i * 0.37, throws: NO_THROWS }}
                  timers={timers}
                />
              </div>
            ) : null}
            <button type="button" className="clp-child-open" aria-label={t("clover.pill.childOpen", { name: child.title || t("clover.pill.untitled") })} onClick={() => onOpen?.(child.id)}>
              <StatusGlyph status={child.status} />
              <span className="clp-child-title">{child.title || t("clover.pill.untitled")}</span>
            </button>
            {stoppable(child.status) ? (
              <button
                type="button"
                className="clp-child-stop"
                style={{ background: cssRgb(palette.body) }}
                aria-label={t("clover.pill.childStop", { name: child.title || t("clover.pill.untitled") })}
                title={t("clover.pill.childStop", { name: child.title || t("clover.pill.untitled") })}
                onClick={() => onStop?.(child.id)}
              >
                <Glyph name="stop" />
              </button>
            ) : null}
          </div>
        );
      })}
      {layout.overflow > 0 ? (
        <span className="clp-child-more" role="listitem" aria-label={t("clover.pill.childMore", { count: layout.overflow })}>
          +{layout.overflow}
        </span>
      ) : null}
    </div>
  );
}

const NO_THROWS: readonly ScheduledThrow[] = [];

function StatusGlyph({ status }: { status: ChildItem["status"] }): ReactElement | null {
  if (status === "working") return null;
  const name = status === "needsYou" ? "hand" : status === "failed" ? "warning" : "check";
  return (
    <span className="clp-child-glyph" data-status={status}>
      <Glyph name={name} />
    </span>
  );
}

/** A child's plume seed from its id, so each child's plume is its own and stays the same across renders. */
export function hash(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

export type { PlumePalette };
