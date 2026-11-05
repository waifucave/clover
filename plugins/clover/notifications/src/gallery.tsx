// The desktop notifications' words, for lane G's gallery. The OS draws the real banner (its own font, icon and
// place), so these are sketches of where the words land on each OS, not the banner itself: what proof there is that
// a banner says who and what happened and nothing that was said. Sample bots and counts.

import type { CSSProperties, ReactElement } from "react";
import { noticeWords, type NotifierUpdate } from "./notifier";

export interface NotificationStory {
  id: string;
  title: string;
  width: number;
  height: number;
  render: () => ReactElement;
}

const at = 1_781_270_000_000;
const SAMPLES: { update: NotifierUpdate; name?: string; count: number }[] = [
  { update: { seq: 1, kind: "message", unseen: 1, bot: "alpha", at }, name: "Alpha", count: 1 },
  { update: { seq: 2, kind: "message", unseen: 3, bot: "alpha", at }, name: "Alpha", count: 3 },
  { update: { seq: 3, kind: "card", unseen: 4, bot: "scout", at }, name: "Scout", count: 1 },
  { update: { seq: 4, kind: "question", unseen: 5, bot: "luna", at }, name: "Luna", count: 2 },
  { update: { seq: 5, kind: "routine-result", unseen: 6, bot: "alpha", at }, name: "Alpha", count: 1 },
  { update: { seq: 6, kind: "agent-finished", unseen: 7, bot: "scout", at }, name: "Scout", count: 1 },
  { update: { seq: 7, kind: "notification", unseen: 8, at, notification: { title: "Render finished", body: "scene.blend, 240 frames, 12 min" } }, count: 1 },
];

type Os = "macos" | "windows" | "linux";

const LOOK: Record<Os, { card: CSSProperties; title: CSSProperties; body: CSSProperties; app: CSSProperties }> = {
  macos: {
    card: { borderRadius: 18, padding: "11px 14px", background: "#F2F2F7E6", boxShadow: "0 6px 24px #0000002E", width: 344 },
    title: { font: "600 13px -apple-system, system-ui, sans-serif", color: "#1C1C1E" },
    body: { font: "400 13px -apple-system, system-ui, sans-serif", color: "#3A3A3C" },
    app: { font: "400 11px -apple-system, system-ui, sans-serif", color: "#6E6E73" },
  },
  windows: {
    card: { borderRadius: 8, padding: "12px 16px", background: "#2B2B2B", boxShadow: "0 8px 24px #00000059", width: 364 },
    title: { font: "600 14px 'Segoe UI', system-ui, sans-serif", color: "#FFFFFF" },
    body: { font: "400 13px 'Segoe UI', system-ui, sans-serif", color: "#D6D6D6" },
    app: { font: "400 12px 'Segoe UI', system-ui, sans-serif", color: "#A6A6A6" },
  },
  linux: {
    card: { borderRadius: 12, padding: "10px 14px", background: "#303030", boxShadow: "0 4px 16px #00000066", width: 356 },
    title: { font: "700 13px Cantarell, 'Noto Sans', system-ui, sans-serif", color: "#FFFFFF" },
    body: { font: "400 13px Cantarell, 'Noto Sans', system-ui, sans-serif", color: "#DEDEDE" },
    app: { font: "400 11px Cantarell, 'Noto Sans', system-ui, sans-serif", color: "#9A9A9A" },
  },
};

function Banner({ os, title, body }: { os: Os; title: string; body?: string }): ReactElement {
  const look = LOOK[os];
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "flex-start", boxSizing: "border-box", ...look.card }}>
      <span style={{ flex: "none", width: 30, height: 30, borderRadius: 8, background: "#3F9C5A", color: "#FFFFFF", display: "grid", placeItems: "center", font: "700 15px system-ui, sans-serif" }}>C</span>
      <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
        <span style={look.app}>Clover</span>
        <span style={look.title}>{title}</span>
        {body ? <span style={look.body}>{body}</span> : null}
      </span>
    </div>
  );
}

function Column({ os }: { os: Os }): ReactElement {
  const backdrop = os === "macos" ? "linear-gradient(180deg, #8CA8D1 0%, #DBD4E6 100%)" : os === "windows" ? "linear-gradient(160deg, #1B4F8A 0%, #6FA3D9 100%)" : "linear-gradient(160deg, #3C2F5C 0%, #C46A4A 100%)";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: 16, background: backdrop, alignItems: "center", height: "100%", boxSizing: "border-box" }}>
      {SAMPLES.map(({ update, name, count }) => {
        const words = noticeWords(update, name, count);
        return <Banner key={update.seq} os={os} title={words.title} body={words.body} />;
      })}
    </div>
  );
}

export const NOTIFICATION_STORIES: NotificationStory[] = [
  { id: "notifications/macos", title: "Desktop notifications, sketched on macOS: each kind, a busy bot's count, a plugin's own", width: 400, height: 560, render: () => <Column os="macos" /> },
  { id: "notifications/windows", title: "Desktop notifications, sketched on Windows", width: 400, height: 580, render: () => <Column os="windows" /> },
  { id: "notifications/linux", title: "Desktop notifications, sketched on GNOME", width: 400, height: 560, render: () => <Column os="linux" /> },
];
