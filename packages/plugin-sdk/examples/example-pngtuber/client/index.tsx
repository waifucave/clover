// The picture-swap renderer, a whole character renderer in one file. The app's character part (clover/character) puts the `avatar`
// spot on a bot's stage and picks the entry whose `key` is the bot's avatar format ("pngtuber" here); that entry draws it.
// What this folder declares in clover.json is all the app needs to know about the format: the files it may serve (a small JSON
// list and pictures, inside the model's own folder), the extension that picks it when a user imports a model, and the one thing
// it can do (`lipsync`, `expressions`). It ships no engine: the pictures are plain <img> elements, and a second set, for the
// `happy` expression, is drawn by code (an inline SVG), so there is nothing to ship for it.
//
// The avatar contract (`useAvatarControl`): a bot plugin's cue arrives with `onCue`, the renderer says which expressions it has
// with `setCatalogue`, and where the figure stands with `setBox`. A cue for an expression it doesn't list never gets here.
import { useEffect, useMemo, useRef, useState } from "react";
import { useAvatarControl, useAvatarSpeech, useT } from "@waifucave/clover-plugin-sdk/ui";

/** What the app gives the `avatar` spot. `file` is the URL of the bot's `.pngtuber.json`. The speech comes from
 *  `useAvatarSpeech()`, not the props: in a plugin's frame it arrives as numbers the app sends on. */
interface AvatarProps {
  bot: { id: string; name?: string } | string;
  file: string;
  format: string;
}
interface EntryProps { props: AvatarProps }

/** The speech feed `useAvatarSpeech()` hands a renderer: loudness frames on the audio clock, a little ahead of when they play. */
interface SpeechFrame { t: number; rms: number; centroid: number }
interface SpeechFeed {
  subscribe(listener: (frames: readonly SpeechFrame[]) => void): () => void;
  now(): number;
}

/** The model's own file: three pictures, named relative to it. */
interface Pictures { name?: string; idle: string; talk: string; blink: string }

/** A frame this loud has the mouth open; a frame is heard for at most this long; the mouth is looked at this often while speech is due. */
const OPEN_RMS = 0.04;
const FRAME_SECONDS = 0.05;
const LOOK_MS = 40;

/** The three pictures, read from the model's JSON and resolved against its URL; undefined while loading, null if it can't be read. */
function usePictures(file: string): { name?: string; urls: Record<"idle" | "talk" | "blink", string> } | null | undefined {
  const [state, setState] = useState<ReturnType<typeof usePictures>>(undefined);
  useEffect(() => {
    let live = true;
    setState(undefined);
    fetch(file)
      .then((r) => (r.ok ? (r.json() as Promise<Pictures>) : Promise.reject(new Error(String(r.status)))))
      .then((m) => {
        if (!live) return;
        const at = (rel: unknown) => (typeof rel === "string" ? new URL(rel, new URL(file, location.href)).href : undefined);
        const idle = at(m.idle);
        const talk = at(m.talk);
        const blink = at(m.blink);
        setState(idle === undefined || talk === undefined || blink === undefined ? null : { name: m.name, urls: { idle, talk, blink } });
      })
      .catch(() => live && setState(null));
    return () => {
      live = false;
    };
  }, [file]);
  return state;
}

/** Whether the mouth is open now, from the feed. With no feed (the app is not describing speech to this frame) it stays
 *  shut. It looks only while speech is still due: a quiet bot runs no timer. */
function useMouthOpen(feed: SpeechFeed | undefined): boolean {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (feed === undefined) return;
    let frames: SpeechFrame[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const look = (): void => {
      timer = undefined;
      const now = feed.now();
      frames = frames.filter((f) => f.t + FRAME_SECONDS >= now);
      setOpen(frames.some((f) => f.t <= now && now < f.t + FRAME_SECONDS && f.rms > OPEN_RMS));
      if (frames.length > 0) timer = setTimeout(look, LOOK_MS);
    };
    const off = feed.subscribe((more) => {
      frames = frames.concat(more).slice(-400);
      if (timer === undefined) look();
    });
    return () => {
      off();
      if (timer !== undefined) clearTimeout(timer);
      setOpen(false);
    };
  }, [feed]);
  return open;
}

/** A blink every few seconds, for a moment. */
function useBlink(): boolean {
  const [shut, setShut] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const next = (): void => {
      timer = setTimeout(() => {
        setShut(true);
        timer = setTimeout(() => {
          setShut(false);
          next();
        }, 130);
      }, 2800 + Math.random() * 2600);
    };
    next();
    return () => clearTimeout(timer);
  }, []);
  return shut;
}

/** The one expression this renderer has, and how long the bot keeps it before the picture set goes back to rest. */
const HAPPY = "happy";
const HAPPY_MS = 8000;

/** Listens for the bot's expression cue: whether the happy set is showing. It has just the one expression, held a few seconds. */
function useHappy(): boolean {
  const control = useAvatarControl();
  const [happy, setHappy] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    control.setCatalogue({ expressions: [HAPPY], motions: [], outfits: [] });
    const off = control.onCue((cue) => {
      if (cue.type !== "expression" || cue.name !== HAPPY) return;
      setHappy(true);
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => setHappy(false), HAPPY_MS);
    });
    return () => {
      off();
      if (timer !== undefined) clearTimeout(timer);
      control.setCatalogue(undefined);
    };
  }, [control]);
  return happy;
}

/** The second picture set, drawn by code: a round face with smiling eyes, its mouth shut or open. Two pictures, no files. */
function HappyFace({ open, label }: { open: boolean; label: string }) {
  return (
    <svg viewBox="0 0 200 200" role="img" aria-label={label} className="pt__svg">
      <circle cx="100" cy="100" r="86" fill="#FFD76A" stroke="#C98F1D" strokeWidth="6" />
      <path d="M62 84 Q74 68 86 84" fill="none" stroke="#5A3B05" strokeWidth="7" strokeLinecap="round" />
      <path d="M114 84 Q126 68 138 84" fill="none" stroke="#5A3B05" strokeWidth="7" strokeLinecap="round" />
      {open ? <ellipse cx="100" cy="132" rx="22" ry="17" fill="#7A2E1D" /> : <path d="M72 122 Q100 152 128 122" fill="none" stroke="#5A3B05" strokeWidth="7" strokeLinecap="round" />}
    </svg>
  );
}

const CSS = `
.pt { width: 100%; height: 100%; display: grid; place-items: center; }
.pt img, .pt__svg { max-width: 100%; max-height: 100%; object-fit: contain; image-rendering: auto; user-select: none; -webkit-user-drag: none; }
.pt__note { color: var(--clover-color-text-muted, #6B6046); font: 13px var(--clover-font-family, system-ui, sans-serif); }
`;

export function PngtuberAvatar({ props }: EntryProps) {
  const t = useT();
  const botName = typeof props.bot === "string" ? props.bot : (props.bot.name ?? props.bot.id);
  const pictures = usePictures(props.file);
  const mouthOpen = useMouthOpen(useAvatarSpeech().feed);
  const blinking = useBlink();
  const happy = useHappy();
  // Where the figure stands: the stage's size and the picture's box, said when it shows and when it resizes (throttled by the app).
  const control = useAvatarControl();
  const stage = useRef<HTMLDivElement>(null);
  const picture = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const host = stage.current;
    if (!host || typeof ResizeObserver === "undefined") return;
    const say = (): void => {
      const h = host.getBoundingClientRect();
      const p = picture.current?.getBoundingClientRect();
      control.setBox({ canvas: { width: Math.round(h.width), height: Math.round(h.height) }, ...(p ? { figure: { x: Math.round(p.left - h.left), y: Math.round(p.top - h.top), width: Math.round(p.width), height: Math.round(p.height) } } : {}) });
    };
    const ro = new ResizeObserver(say);
    ro.observe(host);
    say();
    return () => { ro.disconnect(); control.setBox(undefined); };
  }, [control, pictures === undefined || pictures === null, happy]);
  const shown = useMemo(() => {
    if (!pictures) return undefined;
    return mouthOpen ? pictures.urls.talk : blinking ? pictures.urls.blink : pictures.urls.idle;
  }, [pictures, mouthOpen, blinking]);
  return (
    <div ref={stage} className="pt" data-pngtuber={pictures === null ? "broken" : shown === undefined ? "loading" : happy ? "happy" : mouthOpen ? "talk" : blinking ? "blink" : "idle"}>
      <style>{CSS}</style>
      {pictures === null ? <span className="pt__note">{t("example-pngtuber.cant")}</span> : shown === undefined ? null : happy
        ? <span ref={(el) => { picture.current = el; }} style={{ display: "contents" }}><HappyFace open={mouthOpen} label={t("example-pngtuber.label", { name: botName })} /></span>
        : <img ref={(el) => { picture.current = el; }} src={shown} alt={t("example-pngtuber.label", { name: botName })} draggable={false} />}
    </div>
  );
}
