// The island in every state, for the lane's gallery (rendered to PNGs in CI, never on a desk). Each story
// draws still frames of the pure animations, so a picture is the same on every run.

import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement, type ReactNode } from "react";
import { emptyDraft } from "./model/cards";
import { cardGeometry, ISLAND, islandRect, stripRect, topInset, waitingRect, type ScreenShape } from "./model/geometry";
import { FLUID } from "./model/fluid";
import { MORPH } from "./model/morph";
import { NEEDS_YOU, tabState } from "./model/tabs";
import { APPROVAL, APPROVAL_2, APPROVAL_ALWAYS, LINK, NOTCH, NO_NOTCH, QUESTION, QUESTIONS_2, SEALED } from "./fixtures";
import { QuestionCardContent, SealedCardContent } from "./ui/CardContent";
import { LiquidCard } from "./ui/Liquid";
import { NeedsYou, OpenIsland } from "./ui/OpenIsland";
import { mockSealedKit } from "./mock-kit";
import { SealedKitContext } from "./ui/sealed";
import { Strip } from "./ui/Strip";
import { WaitingPill } from "./ui/WaitingPill";
import { DevicesList } from "./ui/DevicesTab";
import { IslandSurface, type SurfaceHostApi } from "./ui/IslandSurface";
import { islandPlacement, type SurfaceEnvironment, type SurfaceWindowSpec } from "./model/placement";
import type { DeviceView } from "./model/devices";
import type { IslandCard } from "./model/cards";

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

/** The island's tabs in every story: Needs you, then the usage plugin's Usage and the island's own Devices. */
const USAGE = { id: "usage", title: "Usage" };
const DEVICES = { id: "devices", title: "Devices" };
/** In the manifests' order: the usage plugin's tab (800) before the island's own Devices (900). */
export const ISLAND_TABS = [NEEDS_YOU, USAGE, DEVICES];
const TABS = ISLAND_TABS;

/** A screen's top edge: wallpaper, the menu bar, and the camera housing when there is one. */
function Desktop({ shape, width, height, dark = false, children }: { shape: ScreenShape; width: number; height: number; dark?: boolean; children: ReactNode }): ReactElement {
  const bar = topInset(shape);
  const wallpaper = dark ? "linear-gradient(180deg, #1F2A44 0%, #3B2F4F 100%)" : "linear-gradient(180deg, #8CA8D1 0%, #DBD4E6 100%)";
  const style: CSSProperties = { position: "relative", width, height, overflow: "hidden", background: wallpaper };
  return (
    <SealedKitContext.Provider value={kit}>
      <div style={style}>
        <div style={{ position: "absolute", left: 0, right: 0, top: 0, height: bar, background: dark ? "#00000040" : "#FFFFFF59" }} />
        {shape.housing ? (
          <div
            style={{
              position: "absolute",
              top: 0,
              left: `calc(50% - ${shape.housing.width / 2}px)`,
              width: shape.housing.width,
              height: shape.housing.height,
              background: "#000",
              borderRadius: "0 0 9px 9px",
            }}
          />
        ) : null}
        <div className="clv-island" style={{ position: "absolute", inset: 0 }}>
          {children}
        </div>
      </div>
    </SealedKitContext.Provider>
  );
}

type CardGeometry = ReturnType<typeof cardGeometry>;

interface MeasuredCardProps {
  content: ReactNode;
  seconds?: number;
  hovered?: boolean;
  shape?: ScreenShape;
  /** Drawn BENEATH the card (before it in the tree, as the island does), placed from its geometry: the waiting pill. */
  beneath?: (g: CardGeometry) => ReactNode;
}

/** A card on top, its height measured from its own content as the island measures it. */
function MeasuredCard({ content, seconds, hovered, shape = NOTCH, beneath }: MeasuredCardProps): ReactElement {
  const ref = useRef<HTMLDivElement | null>(null);
  const [height, setHeight] = useState(132);
  useLayoutEffect(() => {
    const h = Math.ceil(ref.current?.getBoundingClientRect().height ?? 0);
    if (h > 0 && h + 2 * ISLAND.cardPadding !== height) setHeight(h + 2 * ISLAND.cardPadding);
  });
  const g = cardGeometry(shape, { width: ISLAND.cardWidth, height }, { rounded: true });
  return (
    <>
      {beneath?.(g)}
      <LiquidCard geometry={g} seconds={seconds} hovered={hovered}>
        <div ref={ref}>{content}</div>
      </LiquidCard>
    </>
  );
}

function filmstrip(times: number[], frame: (t: number) => ReactNode, width: number, height: number): ReactElement {
  return (
    <div style={{ display: "grid", gridTemplateColumns: `repeat(3, ${width}px)`, gap: 8, background: "#0000", padding: 0 }}>
      {times.map((t) => (
        <div key={t} style={{ position: "relative" }}>
          {frame(t)}
          <span style={{ position: "absolute", right: 8, bottom: 6, font: "500 11px system-ui, sans-serif", color: "#1C1B22", background: "#FFFFFFB3", borderRadius: 6, padding: "1px 6px" }}>
            {t.toFixed(2)} s
          </span>
        </div>
      ))}
    </div>
  );
}

/** Sample devices for the Devices tab (sample data). */
const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
export const SAMPLE_DEVICES: DeviceView[] = [
  { id: "studio", name: "Studio", kind: "desktop", os: "macos", runsCore: true, online: true, isThis: true, isMain: true, addedAt: 0 },
  { id: "laptop", name: "Pocket laptop", kind: "desktop", os: "windows", runsCore: true, online: true, isThis: false, isMain: false, addedAt: 0, link: { peer: "laptop", up: true, path: "lan", rttMs: 3.4 } },
  { id: "box", name: "Box", kind: "server", os: "linux", runsCore: true, online: true, isThis: false, isMain: false, addedAt: 0, link: { peer: "box", up: true, path: "relay", relay: "waifucave relay", rttMs: 48 } },
  { id: "phone", name: "Phone", kind: "phone", os: "ios", runsCore: false, online: false, isThis: false, isMain: false, addedAt: 0, lastSeenAt: NOW - 3 * 3_600_000, link: { peer: "phone", up: false, path: "relay", relay: "waifucave relay" } },
];

/** The island's desktop for another plugin's tab stories (the usage plugin's): wallpaper, menu bar and housing. */
export const IslandDesktop = Desktop;

/** A screen's top-centre crop for the surface stories: wallpaper, what the OS draws along the top, and the island's
 *  overlay window where the surface asks for it, outlined (dashed, a few pixels out and BENEATH everything, never over a
 *  sealed part): only what the island draws, never the whole frame. */
function Screen({ env, width, height, cards, working = 0 }: { env: SurfaceEnvironment; width: number; height: number; cards: IslandCard[]; working?: number }): ReactElement {
  const placement = islandPlacement(env);
  const { bounds } = env.display;
  const band = placement.shape.menuBarHeight;
  const [spec, setSpec] = useState<SurfaceWindowSpec | null>(null);
  const host = useMemo<SurfaceHostApi>(() => ({ setWindow: setSpec, setInteractiveRegions: () => {} }), []);
  // The crop's left edge on the display: the frame centred in the crop.
  const crop = placement.window.bounds.x - bounds.x + placement.window.bounds.width / 2 - width / 2;
  const win = spec?.bounds ?? placement.window.bounds;
  const left = Math.round(win.x - bounds.x - crop);
  const top = win.y - bounds.y;
  const wallpaper = env.os === "windows" ? "linear-gradient(160deg, #1B4F8A 0%, #6FA3D9 100%)" : env.os === "linux" ? "linear-gradient(160deg, #3C2F5C 0%, #C46A4A 100%)" : "linear-gradient(180deg, #8CA8D1 0%, #DBD4E6 100%)";
  const barColour = env.os === "linux" ? "#000000E6" : "#FFFFFF59";
  return (
    <SealedKitContext.Provider value={kit}>
      <div style={{ position: "relative", width, height, overflow: "hidden", background: wallpaper }}>
        {band > 0 ? <div style={{ position: "absolute", left: 0, right: 0, top: 0, height: band, background: barColour }} /> : null}
        {placement.shape.housing ? (
          <div style={{ position: "absolute", top: 0, left: `calc(50% - ${placement.shape.housing.width / 2}px)`, width: placement.shape.housing.width, height: placement.shape.housing.height, background: "#000", borderRadius: "0 0 9px 9px" }} />
        ) : null}
        {spec?.visible ? <div style={{ position: "absolute", left: left - 4, top, width: win.width + 8, height: win.height + 4, boxSizing: "border-box", border: "1px dashed #FFFFFFD9", borderTop: 0 }} /> : null}
        <div style={{ position: "absolute", left, top }}>
          <IslandSurface environment={env} cards={cards} working={working} host={host} reducedMotion />
        </div>
      </div>
    </SealedKitContext.Provider>
  );
}

/** Wayland: the island as a normal window the compositor frames, always open on Needs you. */
function WaylandWindow({ width, height, cards }: { width: number; height: number; cards: IslandCard[] }): ReactElement {
  const env = WAYLAND_ENV;
  const placement = islandPlacement(env);
  const w = placement.window.bounds;
  const titleBar = 38;
  return (
    <SealedKitContext.Provider value={kit}>
      <div style={{ position: "relative", width, height, overflow: "hidden", background: "linear-gradient(160deg, #3C2F5C 0%, #C46A4A 100%)" }}>
        <div style={{ position: "absolute", left: 0, right: 0, top: 0, height: 32, background: "#000000E6" }} />
        <div style={{ position: "absolute", left: (width - w.width) / 2, top: 56, width: w.width, borderRadius: 12, overflow: "hidden", boxShadow: "0 12px 40px #00000066", background: "#242424" }}>
          <div style={{ height: titleBar, display: "flex", alignItems: "center", justifyContent: "center", font: "600 13px system-ui, sans-serif", color: "#FFFFFFDE" }}>Island</div>
          <div style={{ position: "relative", height: w.height, background: "#000" }}>
            <IslandSurface environment={env} cards={cards} reducedMotion />
          </div>
        </div>
      </div>
    </SealedKitContext.Provider>
  );
}

const MAC_NOTCH_ENV: SurfaceEnvironment = { os: "macos", display: { bounds: { x: 0, y: 0, width: 1512, height: 982 }, workArea: { x: 0, y: 32, width: 1512, height: 950 }, notch: { x: 663.5, y: 0, width: 185, height: 32 } } };
const MAC_PLAIN_ENV: SurfaceEnvironment = { os: "macos", display: { bounds: { x: 0, y: 0, width: 2560, height: 1440 }, workArea: { x: 0, y: 25, width: 2560, height: 1415 }, notch: null } };
const WINDOWS_ENV: SurfaceEnvironment = { os: "windows", display: { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1032 }, notch: null } };
const X11_ENV: SurfaceEnvironment = { os: "linux", session: "x11", display: { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 32, width: 1920, height: 1048 }, notch: null } };
const WAYLAND_ENV: SurfaceEnvironment = { ...X11_ENV, session: "wayland" };

const W = 640;

export const ISLAND_STORIES: Story[] = [
  { id: "island/strip-idle", title: "Strip: idle, the housing alone", width: W, height: 72, render: () => <Desktop shape={NOTCH} width={W} height={72}><Strip shape={NOTCH} counts={{ waiting: 0, working: 0 }} /></Desktop> },
  { id: "island/strip-waiting", title: "Strip: two cards wait", width: W, height: 72, render: () => <Desktop shape={NOTCH} width={W} height={72}><Strip shape={NOTCH} counts={{ waiting: 2, working: 0 }} /></Desktop> },
  { id: "island/strip-working", title: "Strip: three bots work", width: W, height: 72, render: () => <Desktop shape={NOTCH} width={W} height={72}><Strip shape={NOTCH} counts={{ waiting: 0, working: 3 }} /></Desktop> },
  { id: "island/strip-both-hovered", title: "Strip: waiting and working, under the pointer", width: W, height: 72, render: () => <Desktop shape={NOTCH} width={W} height={72}><Strip shape={NOTCH} counts={{ waiting: 2, working: 1 }} hovered /></Desktop> },
  { id: "island/strip-no-housing", title: "Strip: no housing, a tab from the top", width: W, height: 72, render: () => <Desktop shape={NO_NOTCH} width={W} height={72}><Strip shape={NO_NOTCH} counts={{ waiting: 1, working: 2 }} /></Desktop> },
  {
    id: "island/card-approval",
    title: "Card on top: an approval (sealed parts)",
    width: W,
    height: 200,
    sealed: { visible: 5 },
    render: () => <Desktop shape={NOTCH} width={W} height={200}><Strip shape={NOTCH} counts={{ waiting: 1, working: 1 }} /><MeasuredCard content={<SealedCardContent card={APPROVAL} />} /></Desktop>,
  },
  {
    id: "island/card-approval-hovered",
    title: "Card on top: hovered, ✓ under the pointer",
    width: W,
    height: 200,
    sealed: { visible: 5 },
    render: () => <Desktop shape={NOTCH} width={W} height={200}><Strip shape={NOTCH} counts={{ waiting: 1, working: 1 }} /><MeasuredCard content={<SealedCardContent card={APPROVAL} hover="accept" />} hovered /></Desktop>,
  },
  {
    id: "island/card-approval-always",
    title: "Card on top: an approval whose answers include \"Always allow\" (one sealed button per option)",
    width: W,
    height: 200,
    sealed: { visible: 5 },
    render: () => <Desktop shape={NOTCH} width={W} height={200}><Strip shape={NOTCH} counts={{ waiting: 1, working: 0 }} /><MeasuredCard content={<SealedCardContent card={APPROVAL_ALWAYS} />} /></Desktop>,
  },
  {
    id: "island/card-link",
    title: "Card on top: a link request",
    width: W,
    height: 210,
    sealed: { visible: 5 },
    render: () => <Desktop shape={NOTCH} width={W} height={210}><Strip shape={NOTCH} counts={{ waiting: 1, working: 0 }} /><MeasuredCard content={<SealedCardContent card={LINK} />} /></Desktop>,
  },
  {
    id: "island/card-question",
    title: "Card on top: a question, an option under the pointer",
    width: W,
    height: 330,
    render: () => <Desktop shape={NOTCH} width={W} height={330}><Strip shape={NOTCH} counts={{ waiting: 1, working: 0 }} /><MeasuredCard content={<QuestionCardContent card={QUESTION} draft={emptyDraft()} hoverOption={1} />} /></Desktop>,
  },
  {
    id: "island/card-questions-multi",
    title: "Card on top: several questions, multiple choice, answered",
    width: W,
    height: 330,
    render: () => <Desktop shape={NOTCH} width={W} height={330}><Strip shape={NOTCH} counts={{ waiting: 1, working: 0 }} /><MeasuredCard content={<QuestionCardContent card={QUESTIONS_2} draft={{ visible: 0, selections: { 0: [0, 2] }, others: {} }} hoverAccept />} /></Desktop>,
  },
  {
    id: "island/card-waiting",
    title: "A hovered card holds; the newcomer waits below",
    width: W,
    height: 250,
    sealed: { visible: 5 },
    render: () => (
      <Desktop shape={NOTCH} width={W} height={250}>
        <Strip shape={NOTCH} counts={{ waiting: 2, working: 0 }} />
        <MeasuredCard
          content={<SealedCardContent card={APPROVAL} />}
          hovered
          beneath={(g) => (
            <div className="clv-card-panel" style={{ width: g.panelSize.width, height: g.panelSize.height + 48, left: `calc(50% - ${g.panelSize.width / 2}px)` }}>
              <WaitingPill card={APPROVAL_2} rect={waitingRect(g)} />
            </div>
          )}
        />
      </Desktop>
    ),
  },
  {
    id: "island/card-no-housing",
    title: "Card on top: a screen with no housing",
    width: W,
    height: 190,
    sealed: { visible: 5 },
    render: () => <Desktop shape={NO_NOTCH} width={W} height={190}><Strip shape={NO_NOTCH} counts={{ waiting: 1, working: 0 }} /><MeasuredCard content={<SealedCardContent card={APPROVAL} />} shape={NO_NOTCH} /></Desktop>,
  },
  {
    id: "island/card-birth",
    title: "A card's birth from the housing, frame by frame",
    width: 3 * 460 + 16,
    height: 3 * 200 + 16,
    sealed: { visible: 5, moving: 40 },
    render: () =>
      filmstrip(
        [0.06, 0.14, 0.22, 0.3, 0.38, 0.46, 0.58, 0.78, FLUID.settle],
        (t) => <Desktop shape={NOTCH} width={460} height={200}><MeasuredCard content={<SealedCardContent card={APPROVAL} />} seconds={t} /></Desktop>,
        460,
        200,
      ),
  },
  {
    id: "island/open-needs-you",
    title: "Open island: Needs you",
    width: W,
    height: 220,
    sealed: { visible: 5, scrolled: 6 },
    render: () => (
      <Desktop shape={NOTCH} width={W} height={220}>
        <Strip shape={NOTCH} counts={{ waiting: 3, working: 1 }} />
        <OpenIsland shape={NOTCH} tabs={tabState(TABS)} count={3}>
          <NeedsYou cards={[LINK, QUESTION, { ...APPROVAL, issuedAt: 6 }]} scrolls={false} />
        </OpenIsland>
      </Desktop>
    ),
  },
  {
    id: "island/open-needs-you-no-housing",
    title: "Open island: Needs you, no housing",
    width: W,
    height: 220,
    sealed: { visible: 4, scrolled: 7 },
    render: () => (
      <Desktop shape={NO_NOTCH} width={W} height={220}>
        <OpenIsland shape={NO_NOTCH} tabs={tabState(TABS)} count={2}>
          <NeedsYou cards={[APPROVAL_2, APPROVAL]} scrolls={false} />
        </OpenIsland>
      </Desktop>
    ),
  },
  {
    id: "island/open-empty",
    title: "Open island: nothing needs you",
    width: W,
    height: 220,
    render: () => (
      <Desktop shape={NOTCH} width={W} height={220} dark>
        <OpenIsland shape={NOTCH} tabs={tabState(TABS)}>
          <NeedsYou cards={[]} />
        </OpenIsland>
      </Desktop>
    ),
  },
  {
    id: "island/open-devices",
    title: "Open island: Devices, the computers then the phones, one row under the pointer",
    width: W,
    height: 220,
    render: () => (
      <Desktop shape={NOTCH} width={W} height={220}>
        <Strip shape={NOTCH} counts={{ waiting: 0, working: 2 }} />
        <OpenIsland shape={NOTCH} tabs={tabState(TABS, 2)}>
          <DevicesList devices={SAMPLE_DEVICES} now={NOW} hovered="laptop" onOpenDevices={() => {}} />
        </OpenIsland>
      </Desktop>
    ),
  },
  {
    id: "island/open-devices-no-housing",
    title: "Open island: Devices on a screen with no housing, an offline phone under the pointer",
    width: W,
    height: 220,
    render: () => (
      <Desktop shape={NO_NOTCH} width={W} height={220}>
        <OpenIsland shape={NO_NOTCH} tabs={tabState(TABS, 2)}>
          <DevicesList devices={SAMPLE_DEVICES} now={NOW} hovered="phone" />
        </OpenIsland>
      </Desktop>
    ),
  },
  {
    id: "island/surface-macos-housing",
    title: "The surface on a Mac with a camera housing: its window (dashed) is only the strip and the card, never the whole frame",
    width: 760,
    height: 240,
    sealed: { visible: 5 },
    render: () => <Screen env={MAC_NOTCH_ENV} width={760} height={240} cards={[APPROVAL]} working={1} />,
  },
  {
    id: "island/surface-macos-external",
    title: "The surface on a Mac's external display: no housing, from the top edge below the menu bar",
    width: 760,
    height: 240,
    sealed: { visible: 5 },
    render: () => <Screen env={MAC_PLAIN_ENV} width={760} height={240} cards={[APPROVAL]} working={1} />,
  },
  {
    id: "island/surface-windows",
    title: "The surface on Windows: the same island from the top edge, themed, no Apple blue",
    width: 760,
    height: 240,
    sealed: { visible: 5 },
    render: () => <Screen env={WINDOWS_ENV} width={760} height={240} cards={[APPROVAL]} working={2} />,
  },
  {
    id: "island/surface-linux-x11",
    title: "The surface on Linux (X11): below GNOME's top bar",
    width: 760,
    height: 240,
    sealed: { visible: 5 },
    render: () => <Screen env={X11_ENV} width={760} height={240} cards={[APPROVAL]} working={0} />,
  },
  {
    id: "island/surface-linux-wayland",
    title: "The surface on Linux (Wayland): a normal window, always open on Needs you",
    width: 760,
    height: 300,
    // As on a screen with no housing: the open island's header is a row of its own, so the newest card's last parts
    // lie below the fold of Needs you, a scroll away.
    sealed: { visible: 4, scrolled: 2 },
    render: () => <WaylandWindow width={760} height={300} cards={[{ ...QUESTION, issuedAt: 1 }, { ...APPROVAL, issuedAt: 6 }]} />,
  },
  {
    id: "island/open-morph",
    title: "The island opening out of the strip, frame by frame",
    width: 3 * 640 + 16,
    height: 2 * 220 + 8,
    sealed: { moving: 30, scrolled: 6 },
    render: () => {
      const from = stripRect(NOTCH, true)!;
      const tabs = tabState(TABS);
      return filmstrip(
        [0.03, 0.08, 0.14, 0.22, 0.32, MORPH.settle],
        (t) => (
          <Desktop shape={NOTCH} width={640} height={220}>
            <Strip shape={NOTCH} counts={{ waiting: 2, working: 1 }} />
            <OpenIsland shape={NOTCH} size={islandRect(NOTCH)} seconds={t} from={from} tabs={tabs} count={2}>
              <NeedsYou cards={[APPROVAL, QUESTION]} scrolls={false} />
            </OpenIsland>
          </Desktop>
        ),
        640,
        220,
      );
    },
  },
];
