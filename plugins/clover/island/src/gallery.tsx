// The island in every state, for the lane's gallery (rendered to PNGs in CI, never on a desk). Each story
// draws still frames of the pure animations, so a picture is the same on every run.

import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactElement, type ReactNode } from "react";
import { emptyDraft } from "./model/cards";
import { cardGeometry, ISLAND, islandRect, stripRect, topInset, waitingRect, type ScreenShape } from "./model/geometry";
import { FLUID } from "./model/fluid";
import { MORPH } from "./model/morph";
import { NEEDS_YOU, tabState } from "./model/tabs";
import { APPROVAL, APPROVAL_2, APPROVAL_ALWAYS, LINK, NOTCH, NO_NOTCH, QUESTION, QUESTIONS_2, SEALED } from "./fixtures";
import { QuestionCardContent, SealedCardContent } from "./ui/CardContent";
import { LiquidCard } from "./ui/Liquid";
import { NeedsYou, OpenIsland, TabScroll } from "./ui/OpenIsland";
import { mockSealedKit } from "./mock-kit";
import { SealedKitContext } from "./ui/sealed";
import { Strip } from "./ui/Strip";
import { WaitingPill } from "./ui/WaitingPill";
import { GroupTitle, LiftRow, LinkWords, RowWords, StatusWord } from "./ui/rows";

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

/** The island's tabs in every story, in one order: Needs you, then the two sample guests. */
const DEVICES = { id: "devices", title: "Devices" };
const USAGE = { id: "usage", title: "Usage" };
const TABS = [NEEDS_YOU, DEVICES, USAGE];

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

function SampleDevices({ hovered = false }: { hovered?: boolean }): ReactElement {
  return (
    <TabScroll scrolls={false}>
      <div className="clv-rows">
        <GroupTitle title="Computers" meta="2 connected" />
        <LiftRow
          title="Studio"
          side="this computer · main"
          mark={{ kind: "dot", color: "#4CC38A" }}
          trailing={<StatusWord mark={{ kind: "dot", color: "#4CC38A" }} word="Running" />}
        />
        <LiftRow
          title="Pocket laptop"
          side="2 bots lent their files"
          mark={{ kind: "dot", color: "#4CC38A" }}
          hovered={hovered}
          trailing={<StatusWord mark={{ kind: "dot", color: "#4CC38A" }} word="Connected" />}
          below={hovered ? <RowWords text="Paired 3 days ago · last turn 2 min ago" trailing={<LinkWords text="Open" />} /> : null}
        />
        <GroupTitle title="Phones" meta="1 paired" />
        <LiftRow title="Phone" mark={{ kind: "ring", color: "#8B8B8B" }} quiet trailing={<StatusWord mark={{ kind: "ring", color: "#8B8B8B" }} word="Asleep" />} />
      </div>
    </TabScroll>
  );
}

/** A sample Usage tab: what the usage plugin will show, in the island's row language (sample data). */
function SampleUsage(): ReactElement {
  return (
    <TabScroll scrolls={false}>
      <div className="clv-rows">
        <GroupTitle title="This week" meta="sample" />
        <LiftRow title="Claude" side="Max plan" trailing={<StatusWord mark={{ kind: "dot", color: "#4CC38A" }} word="62% left" />} />
        <LiftRow title="Codex" side="Plus plan" trailing={<StatusWord mark={{ kind: "dot", color: "#FFC747" }} word="18% left" />} below={<RowWords text="Resets Monday at 09:00" />} hovered />
        <LiftRow title="Grok" side="API key" quiet trailing={<StatusWord mark={{ kind: "ring", color: "#8B8B8B" }} word="Pay as you go" />} />
      </div>
    </TabScroll>
  );
}

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
    id: "island/open-rows",
    title: "Open island: a tab in the island's row language, one row hovered",
    width: W,
    height: 220,
    render: () => (
      <Desktop shape={NOTCH} width={W} height={220}>
        <Strip shape={NOTCH} counts={{ waiting: 0, working: 2 }} />
        <OpenIsland shape={NOTCH} tabs={tabState(TABS, 1)}>
          <SampleDevices hovered />
        </OpenIsland>
      </Desktop>
    ),
  },
  {
    id: "island/open-usage",
    title: "Open island: Usage, a sample body until the usage plugin lands",
    width: W,
    height: 220,
    render: () => (
      <Desktop shape={NOTCH} width={W} height={220}>
        <Strip shape={NOTCH} counts={{ waiting: 0, working: 1 }} />
        <OpenIsland shape={NOTCH} tabs={tabState(TABS, 2)}>
          <SampleUsage />
        </OpenIsland>
      </Desktop>
    ),
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
