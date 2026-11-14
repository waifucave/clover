// Alpha's room: everything she keeps in front of her stage, in one frame of her plugin (`bot.side`) that fills the scene's left part. Her name in a
// big italic, how she is and the scene and mood chips; a pinned paper note; the day's tally in serif; the stage tools; a speech bubble for what she is
// doing now; and the grass (in front of the figure and behind everything else here). The way to the other tabs is the window's own sidebar, beside her
// tab as on every tab (Bots doesn't offer a bot the sidebar). What the buttons do is the plugin API's: `avatar.*` for her figure, her stage's store
// for the rest. Nothing here is special-cased for Alpha by the app: any bot plugin can draw its own.
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { usePluginApi } from "@waifucave/clover-plugin-sdk/ui";
import type { AvatarBox, AvatarCatalogue, AvatarCue, ShellState } from "@waifucave/clover-plugin-sdk";
import { useStageState } from "./stage-store";
import { DARK_SCENES } from "./backdrop";
import { Grass } from "./grass";
import { GLYPH, NOW, useBot, useDark, useSeen, type BotRef } from "./live";
import { localDay } from "./seen";
import { controlsInset, roomSize, tabWidth, TOGGLE_GAP_PX, TOGGLE_PX } from "./room-size";
import { cuesToDress, dressedIn, nextOutfit, OUTFIT_SETTING, outfitOf, outfitTitle, wearsHerOutfits, type Outfit } from "./outfits";

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

/* The grass band along the bottom of the room (300px; in the narrow band, across its lower part down under the pane's top edge, so the
   band's foot, where the figure stops and the stage puts a credit plate, lies under the pane): she stands in it. */
.rm__grass { position: absolute; left: 0; right: 0; bottom: 0; height: 300px; contain: strict; pointer-events: none; }
.rm .rm__grass svg { width: 100%; height: 100%; stroke: none; }
.rm[data-size="wide"] .rm__grass { -webkit-mask-image: linear-gradient(to right, #000 calc(100% - 220px), transparent); mask-image: linear-gradient(to right, #000 calc(100% - 220px), transparent); }
.rm[data-size="narrow"] .rm__grass { top: 140px; bottom: auto; height: 120px; }
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

.rm:not([data-size="wide"]) :is(.rm__left, .rm__chips, .rm__say, .rm__credit) { display: none; }
/* The mid room's one line: her name and how she is, in the top band beside her sidebar toggle (her controls' own frame: --rm-title-left is where the
   toggle ends, from the same window state), level with it, above the pane. */
.rm:not([data-size="wide"]) .rm__title { top: 24px; left: var(--rm-title-left, 68px); display: flex; align-items: baseline; gap: 12px; }
.rm:not([data-size="wide"]) .rm__name { font-size: 30px; }
.rm:not([data-size="wide"]) .rm__status { margin-top: 0; font-size: 13px; }
/* A narrow tab (800 px or less): the figure is a band across the top, the pane under it takes the width; her title and stats stay out. */
.rm[data-size="narrow"] .rm__title { display: none; }
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

/** How often her room checks the window's width when no `resize` said it changed. */
const WIDTH_LOOK_MS = 2000;
/** The window's width, not this frame's: her room's frame is narrower than the window while the pane sits beside it, and `outerWidth` is the window's own in every frame. */
function useWindowWidth(): number {
  const read = () => (typeof window === "undefined" ? 1600 : window.outerWidth || window.innerWidth || 1600);
  const [w, setW] = useState(read);
  useEffect(() => {
    const settle = () => setW(read());
    let again: ReturnType<typeof setTimeout>[] = [];
    // Her frame lives in a process of its own: it can hear `resize` before the window's new width has reached it, and
    // then it would keep the old one (a wide window drawn as a narrow room). So it reads again a moment
    // after each resize, and looks once in a while (an unchanged width draws nothing).
    const on = () => {
      settle();
      for (const t of again) clearTimeout(t);
      again = [150, 700].map((ms) => setTimeout(settle, ms));
    };
    window.addEventListener("resize", on);
    document.addEventListener("visibilitychange", on);
    const look = setInterval(settle, WIDTH_LOOK_MS);
    on();
    return () => {
      window.removeEventListener("resize", on);
      document.removeEventListener("visibilitychange", on);
      clearInterval(look);
      for (const t of again) clearTimeout(t);
    };
  }, []);
  return w;
}
const WORDS: Record<string, string> = { idle: "Here with you", thinking: "Thinking it over", asleep: "Asleep on another computer", paused: "Paused" };
const clock = (at: number): string => new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

export function AlphaRoom({ props }: { props: { bot: BotRef } }) {
  const api = usePluginApi();
  const shell = api.shell;
  const bot = useBot(props.bot);
  const seen = useSeen(bot?.mainSession);
  const stage = useStageState();
  const [win, setWin] = useState<ShellState | undefined>();
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
  // Her outfit (her `outfit` setting, the Edit page's picker's): on her own model her stage dresses her in it whenever the
  // setting or the model changes. With another avatar picked for her, the setting is left aside and that model's parts stay
  // as they are.
  const [outfit, setOutfit] = useState<Outfit | undefined>();
  useEffect(() => {
    const read = () => void api.settings?.get(OUTFIT_SETTING).then((v) => setOutfit(outfitOf(v)), () => setOutfit(outfitOf(undefined)));
    read();
    return api.settings?.watch?.(OUTFIT_SETTING, read);
  }, [api]);
  const parts = cat?.outfits ?? [];
  const hers = bot !== undefined && bot.otherAvatar !== true && wearsHerOutfits(parts.map((o) => o.name));
  const dressed = outfit !== undefined && dressedIn(parts, outfit);
  // What her figure shows now, part by part: any change while she isn't dressed in her outfit (a cue that landed, or her model
  // loaded again mid-way and starting from its own defaults) dresses her again from what it shows, until she is.
  const showing = parts.map((o) => `${o.name}:${o.on ? 1 : 0}`).join(" ");
  // The last cues her tab sent to dress her and what came back, on the room for a test to read (`data-dressing`).
  const sent = useRef<string[]>([]);
  useEffect(() => {
    if (!hers || outfit === undefined || dressed) return;
    let live = true;
    void (async () => {
      // The setting as it is now: her tool or the Edit page may have changed it since this frame read it.
      const asked = api.settings?.get(OUTFIT_SETTING);
      const now = asked === undefined ? outfit : outfitOf(await asked.catch(() => outfit));
      if (!live) return;
      if (now !== outfit) { setOutfit(now); return; }
      for (const cue of cuesToDress(parts, outfit)) {
        if (!live) return;
        const r = await avatar?.cue?.(cue).catch((e: unknown) => ({ ok: false, reason: String(e) }));
        sent.current = [...sent.current.slice(-7), `${cue.part}:${cue.on ? 1 : 0}=${r === undefined ? "none" : r.ok ? "ok" : (r as { reason?: string }).reason}`];
      }
    })();
    return () => { live = false; };
    // `parts` is read through `showing`, its on/off by name.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hers, outfit, dressed, avatar, showing, api]);
  // The window's state: the sidebar beside her tab (its measured width sizes her room) and how far the window's own buttons reach.
  useEffect(() => shell?.watch?.(setWin), [shell]);

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
  const size = roomSize(tabWidth(width, win));
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
  const tools: { name: string; glyph: ReactNode; off: string | undefined; title?: string; go: () => void }[] = [
    { name: "Wave", glyph: WAVE, off: why("motions", wave !== undefined, "This model has no wave"), go: () => wave && play({ type: "motion", name: wave }) },
    { name: "Pose", glyph: POSE, off: why("motions", poses.length > 0, "This model has no other motions"), go: () => { const n = poses[turn.current.pose++ % poses.length]; if (n) play({ type: "motion", name: n }); } },
    // On her own model the button puts on her next outfit (her setting, so the Edit page's picker agrees); on another model it switches its parts in turn.
    hers && outfit !== undefined
      ? { name: "Outfit", glyph: OUTFIT, off: undefined, title: `Outfit: ${outfitTitle(outfit)}`, go: () => void api.settings?.set(OUTFIT_SETTING, nextOutfit(outfit)).catch(() => setSaid("Her outfit didn't change")) }
      : { name: "Outfit", glyph: OUTFIT, off: why("outfits", outfits.length > 0, "This model has no outfit parts"), go: () => { const o = outfits[turn.current.outfit++ % outfits.length]; if (o) play({ type: "outfit", part: o.name, on: !o.on }); } },
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
    <div className="rm" data-size={size} data-state={state} data-dark={night || undefined} data-dressing={`${outfit ?? "?"} | ${showing} | ${sent.current.join(" ")}`} style={{ "--rm-title-left": `${controlsInset(win) + TOGGLE_PX + TOGGLE_GAP_PX}px` } as CSSProperties} aria-label="Alpha's room">
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
            <button key={t.name} type="button" className="rm__tool" aria-label={t.name} aria-disabled={t.off !== undefined || undefined} title={t.off ?? t.title ?? t.name} aria-expanded={t.name === "Expression" && t.off === undefined ? listing : undefined} onClick={() => { if (t.off === undefined) t.go(); }}><span>{t.glyph}</span>{t.name}</button>
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
    </div>
  );
}
