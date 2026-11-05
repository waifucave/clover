// One frame of a floating card (the Swift reference's `CUIslandLiquidFrame`): the melt — the birth's blobs through a
// blur and an alpha threshold, an SVG goo filter here — while it shows anything the crisp shell does
// not, then the shell: black, a hairline rim, its shadow, the content laid out at its resting size,
// blurred and faded by how far the shape still has to go, and growing a few points under the pointer.
//
// At rest the shell and the content carry no filter, no opacity and no transform but the hover's
// enlargement: sealed approval parts inside must count as visible (spec §5.5).

import { useId, type CSSProperties, type ReactElement, type ReactNode } from "react";
import type { CardGeometry } from "../model/geometry";
import { fluidFrame, FLUID, type Blob, type FluidFrame } from "../model/fluid";
import { morphBlur, LIQUID } from "../model/geometry";
import { hoverScale } from "../model/hover";
import { springEasing, SURFACE_SPRING } from "../model/curves";
import { useIslandStyles } from "./styles";

export const HOVER_EASING = springEasing(SURFACE_SPRING.response, SURFACE_SPRING.damping);

export interface LiquidCardProps {
  geometry: CardGeometry;
  /** Seconds into the birth; the card at rest when omitted. */
  seconds?: number;
  hovered?: boolean;
  /** Reduce Motion: no birth, the card appears where it rests. */
  reducedMotion?: boolean;
  /** Fully shown at rest (or `seconds` past the settle): its parts take clicks. */
  children: ReactNode;
  /** Where the panel's centre sits from the left of its container; the container's centre by default. */
  centerX?: number | string;
  label?: string;
}

export function restingFluid(geometry: CardGeometry): FluidFrame {
  return { ...fluidFrame(geometry, FLUID.settle), blobs: [], crisp: 1, content: 1, blur: 0, card: geometry.card };
}

function blobElement(blob: Blob, key: number): ReactElement {
  const { x, y, width, height } = blob.rect;
  if (blob.shape.kind === "ellipse") return <ellipse key={key} cx={x + width / 2} cy={y + height / 2} rx={width / 2} ry={height / 2} />;
  const r = blob.shape.kind === "capsule" ? Math.min(width, height) / 2 : blob.shape.radius;
  return <rect key={key} x={x} y={y} width={width} height={height} rx={r} ry={r} />;
}

export function Melt({ frame, width, height }: { frame: FluidFrame; width: number; height: number }): ReactElement {
  const id = `clv-goo-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return (
    <svg className="clv-melt" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <defs>
        <filter id={id} x="-20%" y="-20%" width="140%" height="140%" colorInterpolationFilters="sRGB">
          <feGaussianBlur stdDeviation={Math.max(0, frame.blur)} />
          <feColorMatrix type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 40 -20" />
        </filter>
      </defs>
      <g filter={`url(#${id})`} fill="#000">
        {frame.blobs.map(blobElement)}
      </g>
    </svg>
  );
}

export function LiquidCard({ geometry, seconds, hovered = false, reducedMotion = false, children, centerX = "50%", label }: LiquidCardProps): ReactElement {
  useIslandStyles();
  const atRest = seconds === undefined || seconds >= FLUID.settle;
  let frame: FluidFrame;
  if (atRest) frame = restingFluid(geometry);
  else if (reducedMotion) frame = { ...restingFluid(geometry), crisp: seconds > 0 ? 1 : 0, content: seconds > 0 ? 1 : 0 };
  else frame = fluidFrame(geometry, seconds);

  const { panelSize } = geometry;
  const card = frame.card;
  const radius = geometry.cornerRadius === null ? card.height / 2 : Math.min(geometry.cornerRadius, Math.min(card.width, card.height) / 2);
  const interactive = frame.content > 0.9;
  const grow = hovered && interactive;

  const shell: CSSProperties = {
    left: card.x,
    top: card.y,
    width: Math.max(card.width, 0),
    height: Math.max(card.height, 0),
    borderRadius: radius,
    transition: `transform ${HOVER_EASING.durationMs}ms ${HOVER_EASING.easing}`,
    pointerEvents: interactive ? "auto" : "none",
  };
  if (frame.crisp < 1) shell.opacity = frame.crisp;
  if (grow) shell.transform = `scale(${hoverScale(geometry.card.width)})`;

  const blur = morphBlur(card, geometry.card) + LIQUID.maxMorphBlur * (1 - frame.content);
  const content: CSSProperties = {
    width: geometry.card.width,
    height: geometry.card.height,
    marginLeft: -geometry.card.width / 2,
  };
  if (frame.content < 1) content.opacity = frame.content;
  if (blur > 0.25) content.filter = `blur(${blur.toFixed(2)}px)`;

  return (
    <div
      className="clv-card-panel"
      style={{ width: panelSize.width, height: panelSize.height, left: `calc(${typeof centerX === "number" ? `${centerX}px` : centerX} - ${panelSize.width / 2}px)` }}
      data-resting={atRest || undefined}
    >
      {frame.crisp < 1 && frame.blobs.length > 0 ? <Melt frame={frame} width={panelSize.width} height={panelSize.height} /> : null}
      <div className="clv-card-shell" style={shell} data-hovered={grow || undefined} role="dialog" aria-label={label}>
        <div className="clv-card-content" style={content}>
          {children}
        </div>
      </div>
    </div>
  );
}
