// The Dispatch pill in every state, for the lane's gallery (rendered to PNGs in CI, never on a desk). Each
// story draws still frames: the shape's spring stepped to a moment, the plume built for a moment, so a
// picture is the same on every run.

import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement, type ReactNode } from "react";
import type { Rect, SurfaceEnvironment, SurfaceHostApi, SurfaceWindowSpec } from "@waifucave/clover-plugin-island";
import { emptyDraft, type PillCard, type QuestionDraft } from "./model/cards";
import { PILL, barLook, cardSize, contentReveal, mainSize, previewCeiling, previewHeight, type Presentation, type Size } from "./model/metrics";
import { CHILD_PALETTES, PALETTES } from "./model/plume";
import { turnPreview } from "./model/preview";
import { springAt } from "./model/spring";
import { t } from "./strings";
import { AGENTS, ALPHA, APPROVAL, APPROVAL_ALWAYS, EXCHANGES, LINK, MANY_AGENTS, QUESTION, QUESTIONS, SEALED, TARGETS, THROWS } from "./fixtures";
import { Bar, BarMenus, type BarMenu, type PillTarget } from "./ui/Bar";
import { pillTargets } from "./model/targets";
import { CardBody } from "./ui/Card";
import { Children } from "./ui/Children";
import { Plume } from "./ui/Plume";
import { Preview } from "./ui/Preview";
import { mockSealedKit } from "./mock-kit";
import { SealedKitContext } from "./ui/sealed";
import { Shell } from "./ui/Shell";
import { PillSurface } from "./ui/PillSurface";
import { pillWindow, RESTING_CANVAS } from "./model/placement";

export interface Story {
  id: string;
  title: string;
  width: number;
  height: number;
  render: () => ReactNode;
  /** The sealed parts it draws, as the gallery's Chromium check counts them: whole and visible at rest, mid-motion
   *  (a filmstrip's frames), or cut at the edge of a list that scrolls. Absent, it draws none. */
  sealed?: { visible?: number; moving?: number; scrolled?: number };
}

const kit = mockSealedKit(SEALED);
const PLUME_AT = 1.75;

/** The bottom of a screen: wallpaper and the Dock, the pill above it. */
function Desk({ width, height, children, dark = false }: { width: number; height: number; children: ReactNode; dark?: boolean }): ReactElement {
  const style: CSSProperties = {
    position: "relative",
    width,
    height,
    overflow: "hidden",
    background: dark ? "linear-gradient(180deg, #2B2140 0%, #141826 100%)" : "linear-gradient(180deg, #DBD4E6 0%, #9FB4D8 100%)",
  };
  return (
    <SealedKitContext.Provider value={kit}>
      <div style={style}>
        <div style={{ position: "absolute", left: "50%", bottom: 6, width: 300, height: 10, marginLeft: -150, borderRadius: 6, background: dark ? "#FFFFFF1A" : "#FFFFFF66" }} />
        <div className="clp-stage" style={{ position: "absolute", left: 0, right: 0, bottom: 16 + PILL.dockGap / 2 }}>
          {children}
        </div>
      </div>
    </SealedKitContext.Provider>
  );
}

interface BarFrameProps {
  presentation?: Presentation;
  draft?: string;
  running?: boolean;
  stopping?: boolean;
  menu?: BarMenu;
  verb?: string;
  /** The text's lines, for the shape (the field measures itself; the frame's size is set here). */
  lines?: number;
  hovered?: boolean;
  size?: Size;
  /** Who the menu lists; the bots alone when absent. */
  targets?: readonly PillTarget[];
}

/** The bots, then three plugins' `pill.target` entries (sample data). */
const WITH_PLUGIN_TARGETS: readonly PillTarget[] = pillTargets(
  TARGETS.map((t) => ({ id: t.id, name: t.name, portrait: t.portrait, color: t.color })),
  [
    { ref: "agents#codex", pluginId: "agents", pluginName: "Agents", id: "codex", title: "Codex" },
    { ref: "blender#scene", pluginId: "blender", pluginName: "Blender", id: "scene", title: "Scene" },
    { ref: "home#lights", pluginId: "home", pluginName: "Home", id: "lights", title: "Lights", order: 600 },
  ],
);

/** The main pill showing its bar, at rest (or at `size` on its way). */
function BarFrame({ presentation = "compact", draft = "", running = false, stopping = false, menu = null, verb, lines = 1, hovered = false, size, targets = TARGETS }: BarFrameProps): ReactElement {
  const target = mainSize(presentation, lines * 20 + 6);
  const look = barLook(presentation === "expanded", running, draft, false, `Message ${ALPHA.name}`, verb ?? `${ALPHA.name} is working`);
  return (
    <div className="clp-stack" style={hovered ? { transform: `scale(${1 + (PILL.compactWidth * (PILL.hoverScale - 1)) / target.width})` } : undefined}>
      <BarMenus menu={menu} target={targets[0] ?? ALPHA} targets={targets} width={(size ?? target).width} />
      <Shell
        size={size ?? target}
        target={target}
        underlay={running ? <Plume width={PILL.compactWidth} height={PILL.pillHeight} still={{ at: PLUME_AT, throws: THROWS }} /> : undefined}
        underlayShown={look.working}
      >
        <Bar presentation={presentation} target={targets[0] ?? ALPHA} targets={targets} draft={draft} working={look.working} circle={look.circle} placeholder={look.placeholder} stopping={stopping} accessories={presentation === "expanded"} menu={menu} />
      </Shell>
    </div>
  );
}

interface CardFrameProps {
  card: PillCard;
  presentation?: Presentation;
  draft?: QuestionDraft;
  waiting?: number;
  hover?: "accept" | "refuse";
  hoverOption?: number;
  hoverAccept?: boolean;
  error?: string;
  inFlight?: boolean;
  /** A moment of the morph from the compact pill: seconds after the old content began fading. */
  at?: number;
}

/** The pill grown into a card: its height measured from the card's own content, as the pill does. */
function CardFrame({ card, presentation = "compact", draft = emptyDraft(), waiting = 0, hover, hoverOption, hoverAccept, error, inFlight, at }: CardFrameProps): ReactElement {
  const ref = useRef<HTMLDivElement | null>(null);
  const [measured, setMeasured] = useState(0);
  useLayoutEffect(() => {
    const h = Math.ceil(ref.current?.firstElementChild?.getBoundingClientRect().height ?? 0);
    if (h > 0 && h !== measured) setMeasured(h);
  });
  const target = cardSize(presentation, measured);
  const compact = mainSize("compact", 26);
  const fadeOut = PILL.contentFadeOut;
  // The morph: the bar fades for `contentFadeOut`, then the shape springs and the card is revealed near its end.
  const fading = at !== undefined && at < fadeOut;
  const size = at === undefined ? target : fading ? compact : springAt(compact, target, at - fadeOut).size;
  const visibility = at === undefined ? 1 : fading ? 1 - at / fadeOut : contentReveal(compact, size, target);
  if (fading) {
    return (
      <div className="clp-stack">
        <Shell size={compact} target={compact} visibility={visibility}>
          <Bar presentation="compact" target={ALPHA} draft="" working={false} circle="voice" placeholder={`Message ${ALPHA.name}`} />
        </Shell>
      </div>
    );
  }
  return (
    <div className="clp-stack">
      <Shell size={size} target={target} visibility={visibility}>
        <Bar presentation={presentation} target={ALPHA} draft="" working={false} circle="voice" placeholder={null} covered />
        <div ref={ref} style={{ position: "absolute", left: "50%", top: 0, width: target.width, marginLeft: -target.width / 2 }}>
          <CardBody card={card} draft={draft} waiting={waiting} hover={hover} hoverOption={hoverOption} hoverAccept={hoverAccept} error={error} inFlight={inFlight} />
        </div>
      </Shell>
    </div>
  );
}

/** A pinned turn, its height from its reply. */
function PreviewFrame({ index, visibleHeight = 900 }: { index: number; visibleHeight?: number }): ReactElement {
  const ref = useRef<HTMLDivElement | null>(null);
  const [reply, setReply] = useState(20);
  useLayoutEffect(() => {
    const el = ref.current?.querySelector(".clp-preview-reply") as HTMLElement | null;
    const h = el ? Math.ceil(el.scrollHeight) : 0;
    if (h > 0 && h !== reply) setReply(h);
  });
  const preview = turnPreview(EXCHANGES, index)!;
  const target = mainSize("expanded", 0, previewHeight(reply, 20, previewCeiling(visibleHeight)), visibleHeight);
  return (
    <div className="clp-stack">
      <Shell size={target} target={target}>
        <Bar presentation="expanded" target={ALPHA} draft="" working={false} circle="voice" placeholder={null} covered />
        <div ref={ref} style={{ position: "absolute", left: 0, top: 0, width: target.width, height: target.height }}>
          <Preview preview={preview} />
        </div>
      </Shell>
    </div>
  );
}

function filmstrip(times: number[], frame: (t: number) => ReactNode, width: number, height: number, columns = 4): ReactElement {
  return (
    <div style={{ display: "grid", gridTemplateColumns: `repeat(${columns}, ${width}px)`, gap: 8 }}>
      {times.map((t) => (
        <div key={t} style={{ position: "relative", width, height }}>
          {frame(t)}
          <span style={{ position: "absolute", left: 8, top: 6, font: "500 11px system-ui, sans-serif", color: "#1C1B22", background: "#FFFFFFB3", borderRadius: 6, padding: "1px 6px" }}>
            {t.toFixed(2)} s
          </span>
        </div>
      ))}
    </div>
  );
}


/** The bottom of a display, cropped around its centre: the OS's own bar along the bottom, and the pill's window where
 *  `PillSurface` asks the host to put it, outlined (dashed) so the window's size shows. */
const SURFACES: Record<"macos" | "windows" | "linux-x11" | "linux-wayland", SurfaceEnvironment> = {
  macos: { os: "macos", display: { bounds: { x: 0, y: 0, width: 1512, height: 982 }, workArea: { x: 0, y: 32, width: 1512, height: 880 }, notch: null } },
  windows: { os: "windows", display: { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1032 }, notch: null } },
  "linux-x11": { os: "linux", session: "x11", display: { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 32, width: 1920, height: 1048 }, notch: null } },
  "linux-wayland": { os: "linux", session: "wayland", display: { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 32, width: 1920, height: 1048 }, notch: null } },
};

function SurfaceScreen({ env, width, height, draft, menu, targets = TARGETS }: { env: SurfaceEnvironment; width: number; height: number; draft?: string; menu?: BarMenu; targets?: readonly PillTarget[] }): ReactElement {
  const [spec, setSpec] = useState<SurfaceWindowSpec>(() => pillWindow(env, RESTING_CANVAS));
  const [regions, setRegions] = useState<readonly Rect[]>([]);
  const host = useMemo<SurfaceHostApi>(() => ({ setWindow: setSpec, setInteractiveRegions: setRegions }), []);
  const { bounds, workArea } = env.display;
  const cropLeft = bounds.x + bounds.width / 2 - width / 2;
  const cropTop = bounds.y + bounds.height - height;
  const left = Math.round(spec.bounds.x - cropLeft);
  const top = Math.round(spec.bounds.y - cropTop);
  const bottomBar = bounds.y + bounds.height - (workArea.y + workArea.height);
  const wallpaper = env.os === "windows" ? "linear-gradient(160deg, #1B4F8A 0%, #6FA3D9 100%)" : env.os === "linux" ? "linear-gradient(160deg, #3C2F5C 0%, #C46A4A 100%)" : "linear-gradient(180deg, #8CA8D1 0%, #DBD4E6 100%)";
  const framed = !spec.overlay;
  return (
    <SealedKitContext.Provider value={kit}>
      <div style={{ position: "relative", width, height, overflow: "hidden", background: wallpaper }}>
        {bottomBar > 0 && env.os === "macos" ? (
          <div style={{ position: "absolute", left: "50%", bottom: 6, width: 420, marginLeft: -210, height: bottomBar - 12, borderRadius: 18, background: "#FFFFFF59" }} />
        ) : null}
        {bottomBar > 0 && env.os !== "macos" ? <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: bottomBar, background: "#202020F2" }} /> : null}
        {framed ? (
          // The compositor's frame around a normal window: a title bar above it.
          <div style={{ position: "absolute", left: left - 1, top: top - 30, width: spec.bounds.width + 2, height: spec.bounds.height + 31, borderRadius: "10px 10px 0 0", background: "#2A2A2A", boxShadow: "0 8px 30px #00000066" }}>
            <div style={{ height: 30, display: "grid", placeItems: "center", font: "600 13px system-ui, sans-serif", color: "#DDDDDD" }}>{t("clover.pill.name")}</div>
          </div>
        ) : (
          <div style={{ position: "absolute", left: left - 1, top: top - 1, width: spec.bounds.width + 2, height: spec.bounds.height + 2, boxSizing: "border-box", border: "1px dashed #FFFFFFD9" }} />
        )}
        <div style={{ position: "absolute", left, top, background: framed ? "#000000" : undefined }}>
          <PillSurface environment={env} host={host} target={ALPHA} targets={targets} draft={draft} initialPresentation={draft || menu ? "expanded" : undefined} initialMenu={menu} reducedMotion />
        </div>
        {/* The parts that take clicks (dotted): everything else in the window passes them through. */}
        {spec.overlay
          ? regions.map((r, i) => <div key={i} style={{ position: "absolute", left: left + r.x, top: top + r.y, width: r.width, height: r.height, boxSizing: "border-box", border: "1px dotted #FFD54AE6", pointerEvents: "none" }} />)
          : null}
      </div>
    </SealedKitContext.Provider>
  );
}

const W = 680;
const COMPACT: Size = { width: PILL.compactWidth, height: PILL.pillHeight };
const NOTES = "Can you tidy the release notes before I post them?";
const LONG = "Can you tidy the release notes before I post them? Merge the two bug-fix sections, put the Windows tray note first, and keep the tone plain: no exclamation marks, no emoji. Then show me the diff.";

export const PILL_STORIES: Story[] = [
  { id: "pill/surface-macos", title: "On macOS: the pill's window (dashed) at the bottom centre, just above the Dock, and no bigger than the pill and its shadow", width: W, height: 200, render: () => <SurfaceScreen env={SURFACES.macos} width={W} height={200} /> },
  { id: "pill/surface-windows", title: "On Windows: above the taskbar, the window grown with the typing pill", width: W, height: 200, render: () => <SurfaceScreen env={SURFACES.windows} width={W} height={200} draft="Dim the lights in the studio" /> },
  { id: "pill/surface-menu", title: "Choosing who to message on macOS: the window (dashed) grows to the menu as drawn, and only the pill and the menu take clicks (dotted)", width: W, height: 420, render: () => <SurfaceScreen env={SURFACES.macos} width={W} height={420} menu="targets" targets={WITH_PLUGIN_TARGETS} /> },
  { id: "pill/surface-linux-x11", title: "On Linux (X11): the same overlay at the bottom centre of a display with no bottom panel", width: W, height: 200, render: () => <SurfaceScreen env={SURFACES["linux-x11"]} width={W} height={200} /> },
  { id: "pill/surface-linux-wayland", title: "On Linux (Wayland): a normal window the user moves, the pill's own size", width: W, height: 200, render: () => <SurfaceScreen env={SURFACES["linux-wayland"]} width={W} height={200} /> },
  { id: "pill/compact", title: "Compact: who it messages, and the voice circle", width: W, height: 120, render: () => <Desk width={W} height={120}><BarFrame /></Desk> },
  { id: "pill/compact-hovered", title: "Compact, under the pointer: it grows by the same few pixels as every pill", width: W, height: 120, render: () => <Desk width={W} height={120}><BarFrame hovered /></Desk> },
  { id: "pill/typing", title: "Typing: the pill widens, ↗ and ⋯ float at the field's end, the circle sends", width: W, height: 120, render: () => <Desk width={W} height={120}><BarFrame presentation="expanded" draft={NOTES} /></Desk> },
  { id: "pill/typing-long", title: "Typing several lines: the pill grows with them and ↗ ⋯ give way", width: W, height: 190, render: () => <Desk width={W} height={190}><BarFrame presentation="expanded" draft={LONG} lines={4} /></Desk> },
  { id: "pill/typing-more-menu", title: "Typing, with ⋯ open", width: W, height: 220, render: () => <Desk width={W} height={220}><BarFrame presentation="expanded" draft="Check the tray fix" menu="more" /></Desk> },
  { id: "pill/targets-menu", title: "Choosing who to message: every bot is a target", width: W, height: 240, render: () => <Desk width={W} height={240}><BarFrame presentation="expanded" menu="targets" /></Desk> },
  { id: "pill/targets-menu-plugins", title: "Choosing who to message: the bots, then the plugins' pill.target entries under a hairline", width: W, height: 360, render: () => <Desk width={W} height={360}><BarFrame presentation="expanded" menu="targets" targets={WITH_PLUGIN_TARGETS} /></Desk> },
  { id: "pill/working", title: "Working: the plume, each tool thrown out of the nozzle, the stop circle", width: W, height: 120, render: () => <Desk width={W} height={120}><BarFrame running /></Desk> },
  { id: "pill/working-stopping", title: "Working, stop pressed and not yet confirmed", width: W, height: 120, render: () => <Desk width={W} height={120}><BarFrame running stopping /></Desk> },
  { id: "pill/typing-over-work", title: "Typing over a running turn: the circle stays a stop, Enter steers", width: W, height: 120, render: () => <Desk width={W} height={120}><BarFrame presentation="expanded" running verb="Reading the release notes…" /></Desk> },
  { id: "pill/card-approval", title: "Card: an approval, its words and buttons sealed", width: W, height: 260, sealed: { visible: 6 }, render: () => <Desk width={W} height={260}><CardFrame card={APPROVAL} waiting={1} /></Desk> },
  { id: "pill/card-approval-hovered", title: "Card: an approval, ✓ under the pointer", width: W, height: 260, sealed: { visible: 6 }, render: () => <Desk width={W} height={260}><CardFrame card={APPROVAL} hover="accept" /></Desk> },
  { id: "pill/card-approval-always", title: "Card: an approval whose answers include \"Always allow\" (one sealed button per option)", width: W, height: 230, sealed: { visible: 5 }, render: () => <Desk width={W} height={230}><CardFrame card={APPROVAL_ALWAYS} /></Desk> },
  { id: "pill/card-link", title: "Card: a sign-in link", width: W, height: 230, sealed: { visible: 5 }, render: () => <Desk width={W} height={230}><CardFrame card={LINK} /></Desk> },
  { id: "pill/card-question", title: "Card: a question, an option under the pointer (choosing never sends)", width: W, height: 360, render: () => <Desk width={W} height={360}><CardFrame card={QUESTION} draft={{ visible: 0, selections: { 0: [1] }, others: {} }} hoverOption={0} hoverAccept /></Desk> },
  { id: "pill/card-questions", title: "Card: the first of two questions, multiple choice", width: W, height: 360, render: () => <Desk width={W} height={360}><CardFrame card={QUESTIONS} presentation="expanded" draft={{ visible: 0, selections: { 0: [0, 1] }, others: {} }} waiting={2} /></Desk> },
  { id: "pill/card-question-error", title: "Card: an answer that didn't go through", width: W, height: 360, render: () => <Desk width={W} height={360}><CardFrame card={QUESTION} draft={{ visible: 0, selections: {}, others: { 0: "The release branch, but rebase first" } }} error={t("clover.pill.notSent")} /></Desk> },
  { id: "pill/preview", title: "A pinned turn: its prompt, its whole reply in plain words, where it sits", width: W, height: 280, render: () => <Desk width={W} height={280}><PreviewFrame index={1} /></Desk> },
  { id: "pill/preview-update", title: "A pinned turn the user did not start", width: W, height: 150, render: () => <Desk width={W} height={150}><PreviewFrame index={2} /></Desk> },
  {
    id: "pill/agents",
    title: "Agents at work above the pill: working (its own plume), needs you, done",
    width: W,
    height: 180,
    render: () => (
      <Desk width={W} height={180}>
        <div className="clp-stack">
          <Children items={AGENTS} width={PILL.compactWidth} stillAt={PLUME_AT} />
          <BarFrame running />
        </div>
      </Desk>
    ),
  },
  {
    id: "pill/agents-many",
    title: "Many agents over the typing pill: as many as fit, then +n",
    width: W,
    height: 180,
    render: () => (
      <Desk width={W} height={180}>
        <div className="clp-stack">
          <Children items={MANY_AGENTS} width={PILL.expandedWidth} stillAt={PLUME_AT} />
          <BarFrame presentation="expanded" running verb="Waiting on 4 agents…" />
        </div>
      </Desk>
    ),
  },
  {
    id: "pill/agent-rising",
    title: "A new agent rises out of the pill",
    width: W,
    height: 180,
    render: () => (
      <Desk width={W} height={180}>
        <div className="clp-stack">
          <Children items={AGENTS.slice(0, 2)} width={PILL.compactWidth} stillAt={PLUME_AT} entering={{ "agent-2": 0.45 }} />
          <BarFrame running />
        </div>
      </Desk>
    ),
  },
  {
    id: "pill/morph-to-card",
    title: "Morph: the compact pill becomes a card (the bar fades, the shape springs, the card sharpens in)",
    width: 4 * 460 + 3 * 8,
    height: 2 * 250 + 8,
    sealed: { visible: 6, moving: 30 },
    render: () =>
      filmstrip(
        [0.04, 0.1, 0.16, 0.22, 0.3, 0.4, 0.55, 0.9],
        (t) => (
          <Desk width={460} height={250}>
            <CardFrame card={APPROVAL} at={t} />
          </Desk>
        ),
        460,
        250,
      ),
  },
  {
    id: "pill/morph-typing",
    title: "Morph: the first keystroke widens the compact pill",
    width: 4 * 600 + 3 * 8,
    height: 110,
    render: () =>
      filmstrip(
        [0.05, 0.1, 0.18, 0.4],
        (t) => (
          <Desk width={600} height={110}>
            <BarFrame presentation="expanded" draft="C" size={springAt(mainSize("compact", 26), mainSize("expanded", 26), t).size} />
          </Desk>
        ),
        600,
        110,
      ),
  },
  {
    id: "pill/plume-palettes",
    title: "Plume colours: the pill's blue, and each agent's own",
    width: 2 * 330 + 8,
    height: 4 * 52 + 3 * 8,
    render: () => (
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 330px)", gap: 8, background: "#141826", padding: 0 }}>
        {[PALETTES.blue, ...CHILD_PALETTES].map((palette, i) => (
          <div key={i} style={{ width: 330, height: 52, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Shell
              size={COMPACT}
              target={COMPACT}
              underlayShown
              underlay={<Plume width={PILL.compactWidth} height={PILL.pillHeight} palette={palette} seed={0x51 + i} still={{ at: PLUME_AT + i * 0.11, throws: i === 0 ? THROWS : [] }} />}
            />
          </div>
        ))}
      </div>
    ),
  },
];
