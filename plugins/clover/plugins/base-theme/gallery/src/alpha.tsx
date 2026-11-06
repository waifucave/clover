// Alpha's tab in the gallery: its layout (layout format 1) drawn by a small stand-in for the app's layout
// engine, its theme stacked on the base theme with its CSS scoped to the frame, and stand-ins for the parts lane F
// builds (header, conversation, composer). The stage holds the real VRM avatar.

import type { CSSProperties, ReactElement, ReactNode } from "react";
import alphaTheme from "../../../../../alpha/tab/theme.json" with { type: "json" };
import alphaCss from "../../../../../alpha/tab/theme.css" with { type: "text" };
import alphaLayout from "../../../../../alpha/tab/layout.json" with { type: "json" };
import { VrmAvatar } from "../../../vrm/src/ui/VrmAvatar";
import { ALPHA_PORTRAIT, ALPHA_VRM, avatarsSettled } from "../../../vrm/src/gallery";
import { cssVar } from "../../src/catalog";
import { readTheme } from "../../src/theme";
import type { ThemeLayer } from "./themes";

export const ALPHA_LAYER: ThemeLayer = { id: "alpha", theme: readTheme(alphaTheme, { strict: true }), css: alphaCss, base: "plugins/alpha/tab/" };

const v = cssVar;

type LayoutNode = Record<string, unknown>;

/** Layout format 1, drawn: rows and columns as flex boxes, sizes in pixels, `hideBelow` against the window's width. */
function LayoutView({ node, spots, width }: { node: LayoutNode; spots: Record<string, ReactNode>; width: number }): ReactElement | null {
  if (typeof node.hideBelow === "number" && width < node.hideBelow) return null;
  const style: CSSProperties = { display: "flex", minWidth: 0, minHeight: 0, boxSizing: "border-box" };
  const inRowOrColumn = (kids: LayoutNode[], direction: "row" | "column") => {
    style.flexDirection = direction;
    return kids.map((child, i) => <LayoutView key={i} node={child} spots={spots} width={width} />);
  };
  let content: ReactNode = null;
  if (Array.isArray(node.row)) content = inRowOrColumn(node.row as LayoutNode[], "row");
  else if (Array.isArray(node.column)) content = inRowOrColumn(node.column as LayoutNode[], "column");
  else if (typeof node.spot === "string") {
    style.flexDirection = "column";
    content = spots[node.spot] ?? null;
  }
  if (typeof node.size === "number") style.flex = `0 0 ${node.size}px`;
  if (typeof node.grow === "number") style.flexGrow = node.grow;
  if (typeof node.min === "number") style.minWidth = node.min;
  if (typeof node.max === "number") style.maxWidth = node.max;
  if (typeof node.gap === "number") style.gap = node.gap;
  if (typeof node.padding === "number") style.padding = node.padding;
  return (
    <div className={typeof node.class === "string" ? node.class : undefined} style={style} data-node={typeof node.spot === "string" ? node.spot : undefined}>
      {content}
    </div>
  );
}

function Header(): ReactElement {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 20px", borderBottom: `1px solid ${v("color.hairline")}`, background: v("color.surface") }}>
      <img src={ALPHA_PORTRAIT} alt="" width={34} height={34} style={{ borderRadius: "50%" }} />
      <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
        <span style={{ fontFamily: v("font.sans"), fontWeight: 600, fontSize: v("font.size.large"), color: v("color.text") }}>Alpha</span>
        <span style={{ fontSize: v("font.size.caption"), color: v("color.text.muted") }}>Talking on Studio</span>
      </div>
    </div>
  );
}

function Conversation(): ReactElement {
  const user: CSSProperties = { alignSelf: "flex-end", maxWidth: "78%", padding: "10px 15px", borderRadius: v("bubble.radius"), background: v("bubble.user.background"), color: v("bubble.user.text"), lineHeight: v("font.line.body") };
  const bot: CSSProperties = { alignSelf: "flex-start", maxWidth: "86%", padding: "2px 2px", color: v("bubble.bot.text"), lineHeight: v("font.line.body") };
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "flex-end", gap: 14, padding: "24px 28px", fontFamily: v("font.sans"), fontSize: v("font.size.body"), background: v("color.surface") }}>
      <div style={user}>Good morning! Can you look over today's plan?</div>
      <div style={bot}>
        Morning! Three things today: the release notes, the tray fix, and the call at three. I'd start with the notes while it's quiet. <span style={{ color: v("color.accent.text"), textDecoration: "underline" }}>Open the plan</span>
      </div>
      <div style={user}>Start on the notes, please.</div>
    </div>
  );
}

function Composer(): ReactElement {
  return (
    <div style={{ padding: "4px 24px 20px", background: v("color.surface") }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 8px 8px 18px", borderRadius: v("composer.radius"), background: v("composer.background"), boxShadow: `inset 0 0 0 1px ${v("composer.rim")}`, fontFamily: v("font.sans"), fontSize: v("font.size.large") }}>
        <span style={{ flex: 1, color: v("composer.placeholder") }}>Message Alpha</span>
        <span style={{ width: 34, height: 34, borderRadius: "50%", background: v("color.accent"), color: v("color.accent.contrast"), display: "inline-flex", alignItems: "center", justifyContent: "center", fontWeight: 700 }}>↑</span>
      </div>
    </div>
  );
}

function StageSpot(): ReactElement {
  return (
    <div style={{ position: "relative", flex: 1 }}>
      <div style={{ position: "absolute", left: "50%", bottom: "9%", width: "60%", height: 30, marginLeft: "-30%", borderRadius: "50%", background: `radial-gradient(closest-side, ${v("stage.floor")}, #00000000)` }} />
      <VrmAvatar src={ALPHA_VRM} name="Alpha" portrait={ALPHA_PORTRAIT} still={{ at: 1.6, happy: 0.35 }} credit="auto" />
    </div>
  );
}

function AlphaTab({ width, height }: { width: number; height: number }): ReactElement {
  const spots = { "bot.header": <Header />, conversation: <Conversation />, composer: <Composer />, "bot.stage": <StageSpot /> };
  return (
    <div style={{ width, height, display: "flex", background: v("color.canvas") }}>
      <div style={{ flex: 1, display: "flex" }}>
        <LayoutView node={{ ...(alphaLayout.root as LayoutNode), grow: 1 }} spots={spots} width={width} />
      </div>
    </div>
  );
}

export interface AlphaStory {
  id: string;
  title: string;
  width: number;
  height: number;
  theme: string;
  render: () => ReactNode;
  ready?: () => Promise<void>;
}

export const ALPHA_STORIES: AlphaStory[] = [
  { id: "alpha/tab-light", title: "Alpha's tab: its theme on the base theme, its layout, the stage's meadow", width: 1180, height: 720, theme: "alpha-light", render: () => <AlphaTab width={1180} height={720} />, ready: avatarsSettled },
  { id: "alpha/tab-dark", title: "Alpha's tab in the dark", width: 1180, height: 720, theme: "alpha-dark", render: () => <AlphaTab width={1180} height={720} />, ready: avatarsSettled },
  { id: "alpha/tab-narrow", title: "Alpha's tab on a narrow window: the stage gives way (hideBelow 820)", width: 720, height: 600, theme: "alpha-light", render: () => <AlphaTab width={720} height={600} /> },
  {
    id: "alpha/portrait",
    title: "Alpha's placeholder portrait at the sizes it is used",
    width: 420,
    height: 150,
    theme: "alpha-light",
    render: () => (
      <div style={{ display: "flex", gap: 24, alignItems: "center", justifyContent: "center", height: 150, background: v("color.canvas") }}>
        {[96, 48, 34, 24].map((size) => (
          <img key={size} src={ALPHA_PORTRAIT} alt="" width={size} height={size} style={{ borderRadius: "50%", boxShadow: `0 0 0 1px ${v("color.hairline")}` }} />
        ))}
      </div>
    ),
  },
];
