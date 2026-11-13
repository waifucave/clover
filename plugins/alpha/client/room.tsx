// Alpha's room: everything she keeps in front of her stage, in one frame of her plugin (`bot.side`) that fills the scene's left part. Her name in a
// big italic, how she is and the scene and mood chips; a pinned paper note; the day's tally in serif; the stage tools; a speech bubble for what she is
// doing now; the grass (in front of the figure and behind everything else here); and the dock at the bottom,
// the only way to the other tabs while her theme says `sidebar.mode: none` (it folds to a single clover button). What the buttons do is the plugin
// API's: `shell.*` for the window, her stage's store for the rest. Nothing here is special-cased for Alpha by the app: any bot plugin can draw its own.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { usePluginApi } from "@waifucave/clover-plugin-sdk/ui";
import type { AvatarBox, AvatarCatalogue, AvatarCue, ShellAccount, ShellApp, ShellState } from "@waifucave/clover-plugin-sdk";
import { useStageState } from "./stage-store";
import { DARK_SCENES } from "./backdrop";
import { Grass } from "./grass";
import { GLYPH, NOW, useBot, useDark, useSeen, type BotRef } from "./live";
import { localDay } from "./seen";

const SERIF = '"Iowan Old Style", "Palatino", "Hoefler Text", ui-serif, Georgia, serif';
const UI = 'ui-rounded, "SF Pro Rounded", system-ui, "Hiragino Sans", sans-serif';
const SCENE_NAMES: Record<string, string> = { meadow: "Meadow", study: "Lamplit study", starry: "Night meadow", rain: "Rainy window" };
const MOOD_NAMES: Record<string, string> = { calm: "content", focused: "focused", alert: "alert", joy: "joyful", sad: "wistful" };

/** The furthest left the bubble may start: its own width (260 px, at most 30% of the frame) and a 16 px margin short of the frame's right edge. */
export const SAY_RIGHT = "calc(100% - min(260px, 30%) - 16px)";

const CSS = `
html, body { background: transparent !important; margin: 0; height: 100%; overflow: hidden; -webkit-font-smoothing: antialiased; font-family: ${UI}; }
.rm { --ink: #1B2247; --ink2: #465078; --ink3: #6D7598; --glass: rgba(255,253,247,.72); --glass-line: rgba(27,34,71,.10); --field: rgba(27,34,71,.06);
  --gold: #A8823A; --gold-soft: rgba(168,130,58,.25); --clover: #2F9E6A; --cyan: #1D86CF; --paper: #FFFAF0; --paper-ink: #2A2A44; --seg-on: #1B2247; --seg-on-ink: #FFFAF0; --shadow-ink: 255,255,255;
  position: relative; box-sizing: border-box; height: 100vh; width: 100vw; overflow: hidden; color: var(--ink); user-select: none; }
.rm[data-dark] { --ink: #EEF0FB; --ink2: #B9BFDC; --ink3: #8A90B4; --glass: rgba(16,22,52,.62); --glass-line: rgba(255,255,255,.10); --field: rgba(255,255,255,.07);
  --gold: #D9B46A; --gold-soft: rgba(217,180,106,.28); --clover: #5FD29A; --cyan: #74D2FF; --paper: #F3EAD3; --seg-on: #EEF0FB; --seg-on-ink: #141A3C; --shadow-ink: 0,0,0; }
.rm svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; flex: none; }
:where(.rm) button { all: unset; box-sizing: border-box; cursor: pointer; }
:where(.rm) button:focus-visible { outline: 2px solid var(--gold); outline-offset: 2px; }

/* The grass band along the bottom of the room (300px, 150px when narrow): she stands in it. */
.rm__grass { position: absolute; left: 0; right: 0; bottom: 0; height: 300px; contain: strict; pointer-events: none; }
.rm .rm__grass svg { width: 100%; height: 100%; stroke: none; }
.rm[data-size="wide"] .rm__grass { -webkit-mask-image: linear-gradient(to right, #000 calc(100% - 220px), transparent); mask-image: linear-gradient(to right, #000 calc(100% - 220px), transparent); }
.rm[data-size="narrow"] .rm__grass { top: 96px; bottom: auto; height: 144px; }
/* In front of the figure, behind everything below: the scene's foreground fills this slot. */
.rm__fore { position: absolute; inset: 0; pointer-events: none; }

.rm__title { position: absolute; left: clamp(20px, 4.6%, 96px); top: 72px; max-width: 46%; }
.rm__name { margin: 0; font: italic 400 clamp(44px, 5.6vh, 76px)/.95 ${SERIF}; letter-spacing: -.01em; color: var(--ink); text-shadow: 0 2px 24px rgba(var(--shadow-ink),.3); }
.rm__status { display: flex; align-items: center; gap: 8px; margin-top: 12px; font-size: 15px; color: var(--ink2); }
.rm__dot { width: 8px; height: 8px; border-radius: 50%; background: var(--clover); box-shadow: 0 0 0 3px color-mix(in srgb, var(--clover) 22%, transparent); }
.rm[data-state="thinking"] .rm__dot { animation: rm-pulse 1.1s ease-in-out infinite; }
.rm[data-state="asleep"] .rm__dot, .rm[data-state="paused"] .rm__dot { background: var(--ink3); box-shadow: none; }
@keyframes rm-pulse { 50% { transform: scale(1.6); } }
.rm__credit { font-size: 11px; color: var(--ink3); margin-top: 6px; max-width: 46ch; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.rm__chips { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
.rm__chip { display: flex; align-items: center; gap: 7px; padding: 6px 12px 6px 9px; border-radius: 999px; background: var(--glass); border: 1px solid var(--glass-line); font-size: 13px; color: var(--ink2); backdrop-filter: blur(12px); }
.rm__chip b { font-weight: 600; color: var(--ink); }
.rm__chip svg { width: 14px; height: 14px; }

.rm__left { position: absolute; left: clamp(20px, 4.8%, 100px); top: calc(72px + clamp(170px, 20vh, 240px)); width: 200px; display: flex; flex-direction: column; gap: clamp(18px, 3.2vh, 40px); }
.rm__pin { position: relative; padding: 22px 18px 16px; background: var(--paper); color: var(--paper-ink); border-radius: 3px 3px 10px 3px; transform: rotate(-3deg); box-shadow: 0 18px 30px -12px rgba(0,0,0,.5), 0 2px 0 rgba(255,255,255,.4) inset; animation: rm-pin .5s ease both; }
.rm__pin::before { content: ""; position: absolute; top: -7px; left: 50%; width: 14px; height: 14px; margin-left: -7px; border-radius: 50%; background: radial-gradient(circle at 35% 35%, #7fdcff, #2a6fb8 70%); box-shadow: 0 2px 3px rgba(0,0,0,.35); }
.rm__pin p { margin: 0; font: 400 19px/1.25 ${SERIF}; }
.rm__pin small { display: block; margin-top: 10px; font-size: 12px; color: #7a7488; }
@keyframes rm-pin { from { transform: translateY(-10px) rotate(-8deg); } }
.rm__today h3 { margin: 0 0 10px; font: italic 400 18px/1 ${SERIF}; color: var(--ink2); }
.rm__today ul { margin: 0; padding: 0; list-style: none; display: grid; gap: 8px; }
.rm__today li { display: flex; align-items: baseline; gap: 10px; font-size: 14px; color: var(--ink2); }
.rm__today li b { font: 400 30px/1 ${SERIF}; color: var(--ink); min-width: 26px; text-align: right; font-variant-numeric: lining-nums; }
.rm__tools { display: grid; gap: 10px; }
.rm__tool { display: flex; align-items: center; gap: 12px; font-size: 14px; color: var(--ink2); }
.rm__tool > span { width: 40px; height: 40px; border-radius: 50%; display: grid; place-items: center; background: var(--glass); border: 1px solid var(--glass-line); backdrop-filter: blur(10px); color: var(--ink); transition: transform .18s ease, border-color .18s ease; }
.rm__tool:hover > span { transform: translateY(-1px); border-color: var(--gold); }
.rm__tool[aria-disabled="true"] { cursor: default; color: var(--ink3); }
.rm__tool[aria-disabled="true"] > span { background: transparent; border: 1px dashed var(--glass-line); color: var(--ink3); opacity: .75; backdrop-filter: none; }
.rm__tool[aria-disabled="true"]:hover > span { transform: none; border-color: var(--glass-line); }
.rm__tools { position: relative; }
.rm__list { position: absolute; left: 212px; bottom: 0; display: flex; flex-wrap: wrap; gap: 6px; width: 210px; padding: 10px; border-radius: 16px; background: var(--glass); border: 1px solid var(--glass-line); backdrop-filter: blur(18px); box-shadow: 0 18px 40px -20px rgba(0,0,0,.6); }
.rm__list button { padding: 5px 11px; border-radius: 999px; font-size: 12.5px; color: var(--ink2); background: var(--field); }
.rm__list button:hover, .rm__list button[aria-pressed="true"] { color: var(--ink); box-shadow: 0 0 0 1px var(--gold); }
.rm__note { font-size: 12px; color: var(--ink3); max-width: 200px; }
.rm__tool[aria-pressed="true"] > span { border-color: var(--gold); box-shadow: 0 0 0 3px var(--gold-soft); }

/* What she is doing now: a speech bubble. Until a renderer reports where her head is, it sits at a fixed spot in the upper part of the stage. */
.rm__say { position: absolute; box-sizing: border-box; /* Placed from the figure's head, but never past this frame's own right edge (the frame is narrower than the window: it clips what leaves it). */ left: max(16px, min(var(--rm-say-x, 56%), ${SAY_RIGHT})); top: var(--rm-say-y, 14%); width: 260px; max-width: 30%; padding: 16px 20px 15px; border-radius: 22px 22px 22px 6px; background: var(--paper); color: var(--paper-ink); box-shadow: 0 16px 40px -14px rgba(0,0,0,.55); transition: left .4s ease, top .4s ease; }
.rm__say::after { content: ""; position: absolute; left: -2px; bottom: -14px; width: 30px; height: 24px; background: var(--paper); clip-path: polygon(0 0, 100% 0, 0 100%); transform: rotate(8deg); }
.rm__say small { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #6f6a80; }
.rm__say small i { width: 6px; height: 6px; border-radius: 50%; background: var(--clover); }
.rm__say p { margin: 4px 0 0; font: 400 21px/1.2 ${SERIF}; }
.rm__say em { display: block; font-size: 13.5px; font-style: normal; color: #6f6a80; margin-top: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rm__say[data-attention] { box-shadow: 0 0 0 3px var(--gold), 0 16px 40px -14px rgba(0,0,0,.55); }

/* The dock: the sidebar, set on the grass. */
.as { position: absolute; left: clamp(20px, 4.8%, 100px); bottom: 26px; display: flex; align-items: center; gap: 6px; padding: 8px 10px; border-radius: 22px; background: var(--glass); border: 1px solid var(--glass-line); backdrop-filter: blur(22px) saturate(1.3); box-shadow: 0 18px 40px -20px rgba(0,0,0,.6); max-width: calc(100% - 40px); }
.as__switch { display: flex; flex-direction: column; gap: 2px; padding: 3px; border-radius: 12px; background: var(--field); }
.as__opt { width: 58px; height: 24px; border-radius: 9px; font-size: 12px; color: var(--ink3); display: grid; place-items: center; }
.as__opt[aria-checked="true"] { background: var(--seg-on); color: var(--seg-on-ink); }
.as__div { width: 1px; height: 42px; background: var(--glass-line); margin: 0 4px; flex: none; }
.as__scroll { display: flex; align-items: center; gap: 2px; min-width: 0; overflow-x: auto; scrollbar-width: none; }
.as__row { position: relative; width: 70px; flex: none; display: flex; flex-direction: column; align-items: center; gap: 5px; font-size: 11.5px; color: var(--ink2); padding: 4px 0; }
.as__row:hover { color: var(--ink); }
.as__glyph, .as__av { width: 40px; height: 40px; border-radius: 13px; display: grid; place-items: center; background: var(--field); color: var(--ink); overflow: hidden; font-weight: 700; font-size: 15px; }
.as__glyph img, .as__av img { width: 100%; height: 100%; object-fit: cover; }
.as__row[aria-current="page"] { color: var(--ink); }
.as__row[aria-current="page"] .as__av, .as__row[aria-current="page"] .as__glyph { box-shadow: 0 0 0 2px var(--gold), 0 0 18px var(--gold-soft); }
.as__name { max-width: 68px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.as__dot { position: absolute; top: 2px; right: 10px; width: 10px; height: 10px; border-radius: 50%; background: var(--clover); border: 2px solid var(--glass); }
.as__dot[data-state="idle"] { display: none; }
.as__dot[data-state="thinking"] { animation: rm-pulse 1.1s ease-in-out infinite; }
.as__account .as__av { border-radius: 50%; background: linear-gradient(160deg, #f3d08f, #c99a4c); color: #3a2a10; }
.as__fold { width: 28px; height: 28px; border-radius: 9px; display: grid; place-items: center; color: var(--ink3); }
.as__fold:hover { background: var(--field); color: var(--ink); }
.as[data-rail] { padding: 8px 14px 8px 8px; gap: 10px; border-radius: 999px; }
.as[data-rail] .as__clover { width: 40px; height: 40px; border-radius: 50%; display: grid; place-items: center; background: var(--gold); color: #18204a; }
.as[data-rail] .as__faces { display: flex; }
.as[data-rail] .as__faces .as__av { width: 28px; height: 28px; border-radius: 50%; margin-left: -8px; font-size: 12px; border: 2px solid var(--glass); }
.as[data-rail] .as__faces .as__av:first-child { margin-left: 0; }

.rm:not([data-size="wide"]) :is(.rm__left, .rm__chips, .rm__say, .rm__credit) { display: none; }
.rm:not([data-size="wide"]) .rm__title { top: 4px; left: 138px; display: flex; align-items: baseline; gap: 12px; }
.rm:not([data-size="wide"]) .rm__name { font-size: 30px; }
.rm:not([data-size="wide"]) .rm__status { margin-top: 0; font-size: 13px; }
.rm:not([data-size="wide"]) .as { left: 12px; bottom: 12px; }
/* A narrow window (900 px or less): the figure is a band across the top, the pane under it takes the width; her title and stats stay out, the dock rests as its clover button at the band's foot, clear of the composer. */
.rm[data-size="narrow"] .rm__title { display: none; }
.rm[data-size="narrow"] .as { top: 176px; bottom: auto; left: 12px; right: 12px; }
.rm[data-size="narrow"] .as[data-rail] { left: auto; right: 20px; }
@media (prefers-reduced-motion: reduce) { .rm *, .rm *::before, .rm *::after { animation: none !important; transition: none !important; } }
`;

const Icon = ({ children }: { children: ReactNode }) => <svg viewBox="0 0 24 24" aria-hidden="true">{children}</svg>;
const WAVE = <Icon><path d="M8 12V6.5a1.5 1.5 0 0 1 3 0V11M11 10V5a1.5 1.5 0 0 1 3 0v6M14 10.5V6.5a1.5 1.5 0 0 1 3 0V13a6 6 0 0 1-6 6h-.5a5 5 0 0 1-4.2-2.3L4 13.5a1.4 1.4 0 0 1 2.3-1.6L8 14" /></Icon>;
const POSE = <Icon><circle cx="12" cy="5" r="1.8" /><path d="M5 9l7 1.5L19 9M12 10.5V15M12 15l-3.5 5M12 15l3.5 5" /></Icon>;
const OUTFIT = <Icon><path d="M9 4l3 2 3-2 5 3.5-2 3.5-2-1V20H8v-9l-2 1-2-3.5z" /></Icon>;
const SMILE = <Icon><circle cx="12" cy="12" r="8.5" /><path d="M8.5 14c1 1.5 2.2 2.2 3.5 2.2s2.5-.7 3.5-2.2M9 9.5v.5M15 9.5v.5" /></Icon>;
const MOON = <Icon><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" /></Icon>;
const SUN = <Icon><circle cx="12" cy="12" r="4" /><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6L7 7M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4" /></Icon>;
const HEART = <Icon><path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z" /></Icon>;
const ARCHIVE = <Icon><rect x="3.5" y="5" width="17" height="4" rx="1.5" /><path d="M5 9v9a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 18V9M10 13h4" /></Icon>;
const GRID = <Icon><rect x="4" y="4" width="6.5" height="6.5" rx="1.6" /><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.6" /><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.6" /><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.6" /></Icon>;
const PLUG = <Icon><path d="M9 3v5M15 3v5M6.5 8h11v3a5.5 5.5 0 0 1-11 0zM12 16.5V21" /></Icon>;
const GEAR = <Icon><circle cx="12" cy="12" r="3" /><path d="M12 3.5l1.3 2.2 2.5-.6.9 2.4 2.4.9-.6 2.5L20.5 12l-2.1 1.2.6 2.5-2.4.9-.9 2.4-2.5-.6L12 20.5l-1.3-2.2-2.5.6-.9-2.4-2.4-.9.6-2.5L3.5 12l2.1-1.2-.6-2.5 2.4-.9.9-2.4 2.5.6z" /></Icon>;
const CLOVER = <Icon><path d="M12 12c-2-3-6-3-6-6a3 3 0 0 1 6 0 3 3 0 0 1 6 0c0 3-4 3-6 6zM12 12c-3 2-3 6-6 6a3 3 0 0 1 0-6M12 12c3 2 3 6 6 6a3 3 0 0 0 0-6M12 12v9" /></Icon>;

/** The window's width, not this frame's: her room's frame is narrower than the window while the pane sits beside it, and `outerWidth` is the window's own in every frame. */
function useWindowWidth(): number {
  const read = () => (typeof window === "undefined" ? 1600 : window.outerWidth || window.innerWidth || 1600);
  const [w, setW] = useState(read);
  useEffect(() => {
    const on = () => setW(read());
    window.addEventListener("resize", on);
    on();
    return () => window.removeEventListener("resize", on);
  }, []);
  return w;
}
const initial = (name: string) => (name.trim()[0] ?? "·").toUpperCase();
const WORDS: Record<string, string> = { idle: "Here with you", thinking: "Thinking it over", asleep: "Asleep on another computer", paused: "Paused" };
const clock = (at: number): string => new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

interface BotRow { id: string; name: string; state: string; portrait?: string }

export function AlphaRoom({ props }: { props: { bot: BotRef } }) {
  const api = usePluginApi();
  const shell = api.shell;
  const bot = useBot(props.bot);
  const seen = useSeen(bot?.mainSession);
  const stage = useStageState();
  const [bots, setBots] = useState<BotRow[]>([]);
  const [win, setWin] = useState<ShellState | undefined>();
  const [apps, setApps] = useState<readonly ShellApp[]>([]);
  const [account, setAccount] = useState<ShellAccount>({ name: "" });
  const styled = useRef(false);
  const dark = useDark();
  const avatar = api.avatar;
  const [cat, setCat] = useState<AvatarCatalogue | undefined>();
  const [box, setBox] = useState<AvatarBox | undefined>();
  const [said, setSaid] = useState("");
  const [listing, setListing] = useState(false);
  const [shown, setShown] = useState("");
  const turn = useRef({ expression: 0, pose: 0, outfit: 0 });
  // What her figure's renderer says it has and where she stands: her tools and the speech bubble follow it (a renderer that says nothing leaves a plain default).
  useEffect(() => {
    void avatar?.catalogue?.().then(setCat, () => undefined);
    void avatar?.box?.().then(setBox, () => undefined);
    const stop = avatar?.watch?.((c) => { if (c.kind === "catalogue") setCat((was: typeof c.catalogue) => (JSON.stringify(was) === JSON.stringify(c.catalogue) ? was : c.catalogue)); else setBox((was: typeof c.box) => (JSON.stringify(was) === JSON.stringify(c.box) ? was : c.box)); });
    // A figure that is still loading hasn't said anything yet: ask again a few times, in case the first word was missed.
    let n = 0;
    const again = setInterval(() => {
      if (++n > 12) return clearInterval(again);
      void avatar?.catalogue?.().then((c) => c && setCat(c), () => undefined);
      void avatar?.box?.().then((b) => b && setBox(b), () => undefined);
    }, 2500);
    return () => { stop?.(); clearInterval(again); };
  }, [avatar]);

  useEffect(() => {
    if (styled.current) return;
    styled.current = true;
    const el = document.createElement("style");
    el.textContent = CSS;
    document.head.append(el);
  }, []);
  useEffect(() => shell?.watch?.(setWin), [shell]);
  // The dock is the way to the other tabs: the window may drop its own sidebar while this says so (and takes it back when this goes).
  useEffect(() => {
    void shell?.provide?.(["sidebar"]).catch(() => undefined);
    return () => void shell?.provide?.([]).catch(() => undefined);
  }, [shell]);
  useEffect(() => {
    void shell?.apps?.().then((a) => setApps((o) => (JSON.stringify(o) === JSON.stringify(a) ? o : a)), () => undefined);
    void shell?.account?.().then((a) => setAccount((o) => (o.name === a.name && o.detail === a.detail ? o : a)), () => undefined);
  }, [shell, win]);
  useEffect(() => {
    let live = true;
    const row = (b: any): BotRow => ({ id: b.id, name: typeof b.name === "string" ? b.name : b.id, state: b.state ?? "idle", ...(b.portrait ? { portrait: b.portrait } : {}) });
    void api.bots?.list().then((l) => live && setBots(l.map(row)), () => undefined);
    const stop = api.bots?.watch((b: any) => setBots((list) => { const at = list.findIndex((x) => x.id === b.id); if (at < 0) return [...list, row(b)]; const next = row(b); return JSON.stringify(list[at]) === JSON.stringify(next) ? list : list.map((x, i) => (i === at ? next : x)); }));
    return () => { live = false; stop?.(); };
  }, [api]);

  const tool = seen.tool;
  const running = bot?.state === "thinking" || tool?.status === "running";
  const now = useMemo(() => {
    if (seen.waiting) return { title: "Waiting for you", sub: "I need a yes before I go on" };
    const act = stage.activity;
    if (act?.kind === "celebrate") return { title: "Celebrating", sub: "That went well" };
    if (tool && running) return { title: tool.title ?? NOW[tool.name] ?? `Using ${tool.name.replace(/_+/g, " ")}`, sub: tool.detail || "" };
    if (act?.kind === "thinking") return { title: "Thinking it over", sub: "" };
    if (act?.kind === "tool") return { title: "Working", sub: act.label };
    if (tool?.status === "failed") return { title: "That one did not work", sub: tool.detail };
    if (tool) return { title: "All caught up", sub: `Last: ${(NOW[tool.name] ?? tool.name).toLowerCase()} ${tool.detail}`.trim() };
    return { title: "Ready when you are", sub: "Ask me anything" };
  }, [seen, tool, running, stage.activity]);
  void GLYPH;

  const state = bot?.state ?? "idle";
  const width = useWindowWidth();
  const size = width <= 900 ? "narrow" : width <= 1100 ? "mid" : "wide";
  const narrow = size === "narrow";
  const [peek, setPeek] = useState(false);
  const rail = win?.sidebar.collapsed === true || (narrow && !peek);
  const run = (p: Promise<void> | undefined) => void p?.catch(() => undefined);
  const onBot = win?.tab.kind === "bot" ? win.tab.id : undefined;
  // "So far today": what her conversation shows for today (by each event's own time) and, where it counted today, the stage's own tally (a turn's end and a tool's end it saw);
  // the larger of the two, so a day's older tally never shows and a hook that was refused in a burst never undercounts.
  const kept = stage.tally?.day === localDay() ? stage.tally : undefined;
  const counts = { replies: Math.max(seen.today.replies, kept?.turns ?? 0), tools: Math.max(seen.today.tools, kept?.tools ?? 0), files: seen.today.files };
  const night = DARK_SCENES.has(stage.scene) || dark;
  const pin = stage.pinned[stage.pinned.length - 1];
  const tally = (n: number, one: string, many: string) => (
    <li><b>{n}</b><span>{n === 1 ? one : many}</span></li>
  );
  // Her stage tools call the figure's own cues (`avatar.cue`); what this figure's renderer can't do shows as a disabled button with the reason, not as an error after a press.
  const caps = new Set<string>(cat?.capabilities ?? []);
  const motions = cat?.motions ?? [];
  const wave = motions.find((m) => /wave|hello|greet|hi\b/i.test(m));
  const poses = motions.filter((m) => m !== wave);
  const outfits = cat?.outfits ?? [];
  const exprs = cat?.expressions ?? [];
  const why = (cap: string, has: boolean, none: string): string | undefined =>
    cat === undefined ? "Nothing is drawing her yet" : !caps.has(cap) ? "This figure's renderer doesn't do that" : has ? undefined : none;
  const play = (cue: AvatarCue): void => {
    void avatar?.cue?.(cue).then((r) => setSaid(r.ok ? "" : r.message), () => setSaid("That didn't play"));
  };
  const tools: { name: string; glyph: ReactNode; off: string | undefined; go: () => void }[] = [
    { name: "Wave", glyph: WAVE, off: why("motions", wave !== undefined, "This model has no wave"), go: () => wave && play({ type: "motion", name: wave }) },
    { name: "Pose", glyph: POSE, off: why("motions", poses.length > 0, "This model has no other motions"), go: () => { const n = poses[turn.current.pose++ % poses.length]; if (n) play({ type: "motion", name: n }); } },
    { name: "Outfit", glyph: OUTFIT, off: why("outfits", outfits.length > 0, "This model has no outfit parts"), go: () => { const o = outfits[turn.current.outfit++ % outfits.length]; if (o) play({ type: "outfit", part: o.name, on: !o.on }); } },
    { name: "Expression", glyph: SMILE, off: why("expressions", exprs.length > 0, "This model has no expressions"), go: () => setListing((o) => !o) },
  ];
  // The bubble sits beside her head: from the figure's box (the renderer's own, or the app's default), else a fixed place in the upper part of the stage.
  const sayAt = ((): { left: string; top: string } | undefined => {
    const head = box?.anchors?.headTop ?? box?.anchors?.face;
    if (box === undefined || head === undefined || box.canvas.width <= 0 || box.canvas.height <= 0) return undefined;
    // The stage and this room share an origin (the room's frame covers the window), so the figure's own pixels place the bubble.
    const fig = box.figure;
    const x = Math.max(16, head.x + (fig ? fig.width * 0.2 : box.canvas.width * 0.14));
    const y = Math.max(16, Math.min(box.canvas.height * 0.5, head.y - 20));
    return { left: `max(16px, min(${Math.round(x)}px, ${SAY_RIGHT}))`, top: `${Math.round(y)}px` };
  })();

  return (
    <div className="rm" data-size={size} data-state={state} data-dark={night || undefined} aria-label="Alpha's room">
      <div className="rm__fore" data-slot="foreground" aria-hidden="true"><Grass scene={stage.scene} dark={night} className="rm__grass" /></div>
      <header className="rm__title">
        <h1 className="rm__name">{props.bot.name}</h1>
        <div className="rm__status" title={bot?.model ? `Model: ${bot.model}` : undefined}><i className="rm__dot" />{WORDS[state] ?? state}</div>
        {bot?.credit ? <div className="rm__credit" title={bot.credit}>{bot.credit}</div> : null}
        <div className="rm__chips">
          <span className="rm__chip">{night ? MOON : SUN}{stage.scene === "meadow" ? (night ? "Night meadow" : "Day meadow") : (SCENE_NAMES[stage.scene] ?? stage.scene)}</span>
          <span className="rm__chip">{HEART}Feeling <b>{MOOD_NAMES[stage.mood] ?? stage.mood}</b></span>
        </div>
      </header>
      <div className="rm__left">
        {pin ? <div className="rm__pin"><p>{pin.text}</p><small>{pin.at === undefined ? "Pinned" : `Pinned at ${clock(pin.at)}`}</small></div> : null}
        <section className="rm__today" aria-label="So far today">
          <h3>So far today</h3>
          <ul>{tally(counts.replies, "reply", "replies")}{tally(counts.tools, "tool call", "tool calls")}{tally(counts.files, "file touched", "files touched")}</ul>
        </section>
        <div className="rm__tools" role="toolbar" aria-label="Stage tools">
          {tools.map((t) => (
            <button key={t.name} type="button" className="rm__tool" aria-label={t.name} aria-disabled={t.off !== undefined || undefined} title={t.off ?? t.name} aria-expanded={t.name === "Expression" && t.off === undefined ? listing : undefined} onClick={() => { if (t.off === undefined) t.go(); }}><span>{t.glyph}</span>{t.name}</button>
          ))}
          {listing && exprs.length > 0 ? (
            <div className="rm__list" role="menu" aria-label="Expressions">
              {exprs.map((n) => <button key={n} type="button" role="menuitem" aria-pressed={shown === n} onClick={() => { setShown(n); play({ type: "expression", name: n }); }}>{n}</button>)}
            </div>
          ) : null}
          {said ? <div className="rm__note" role="status">{said}</div> : null}
        </div>
      </div>
      <aside className="rm__say" style={sayAt} data-attention={seen.waiting || undefined} aria-label="Right now">
        <small>{running || seen.waiting ? <i /> : null}Right now</small>
        <p>{now.title}</p>
        {now.sub ? <em>{now.sub}</em> : null}
      </aside>

      <nav className="as" aria-label="Sidebar" data-rail={rail || undefined}>
        {rail ? (
          <>
            <button type="button" className="as__clover" aria-label="Show the sidebar" title="Show the sidebar" onClick={() => (narrow && win?.sidebar.collapsed !== true ? setPeek(true) : run(shell?.toggleSidebar?.()))}>{CLOVER}</button>
            <span className="as__faces">{bots.slice(0, 3).map((b) => <span key={b.id} className="as__av">{b.portrait ? <img src={b.portrait} alt="" /> : initial(b.name)}</span>)}</span>
          </>
        ) : (
          <>
            <div className="as__switch" role="radiogroup" aria-label="Bots or code">
              <button type="button" role="radio" aria-checked="true" className="as__opt" title="Bots" aria-label="Bots">Bots</button>
              <button type="button" role="radio" aria-checked="false" className="as__opt" title="Code" aria-label="Code" onClick={() => run(shell?.go?.({ side: "code" }))}>Code</button>
            </div>
            <div className="as__div" />
            <div className="as__scroll">
              {bots.map((b) => (
                <button key={b.id} type="button" className="as__row" aria-current={onBot === b.id ? "page" : undefined} aria-label={b.name} title={b.name} onClick={() => run(shell?.go?.({ bot: b.id }))}>
                  <span className="as__av">{b.portrait ? <img src={b.portrait} alt="" /> : initial(b.name)}</span>
                  <span className="as__name">{b.name}</span>
                  <i className="as__dot" data-state={b.state} />
                </button>
              ))}
              {apps.map((a) => (
                <button key={a.id} type="button" className="as__row" aria-current={win?.tab.kind === "app" && win.tab.id === a.id ? "page" : undefined} aria-label={a.title} title={a.title} onClick={() => run(shell?.go?.({ app: a.id }))}>
                  <span className="as__glyph">{a.icon && /^(clover-plugin|https?|data):/.test(a.icon) ? <img src={a.icon} alt="" width={20} height={20} /> : a.id === "archive" ? ARCHIVE : GRID}</span>
                  <span className="as__name">{a.title}</span>
                </button>
              ))}
              <div className="as__div" />
              <button type="button" className="as__row" aria-label="Plugins" title="Plugins" onClick={() => run(shell?.go?.({ page: "plugins" }))}><span className="as__glyph">{PLUG}</span><span className="as__name">Plugins</span></button>
              <button type="button" className="as__row" aria-label="Settings" title="Settings" onClick={() => run(shell?.openSettings?.())}><span className="as__glyph">{GEAR}</span><span className="as__name">Settings</span></button>
              {account.name !== "" ? (
                <>
                  <div className="as__div" />
                  <button type="button" className="as__row as__account" aria-label={`Account ${account.name}`} title={`Account ${account.name}`} onClick={() => run(shell?.openSettings?.())}>
                    <span className="as__av">{initial(account.name)}</span><span className="as__name">{account.name}</span>
                  </button>
                </>
              ) : null}
            </div>
            <button type="button" className="as__fold" aria-label="Fold the sidebar" title="Fold the sidebar" onClick={() => (narrow ? setPeek(false) : run(shell?.toggleSidebar?.()))}>{CLOVER}</button>
          </>
        )}
      </nav>
    </div>
  );
}
