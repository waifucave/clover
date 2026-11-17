// The picture-swap renderer, a whole renderer for the avatar plugin in one file. The avatar plugin (moss/character) shows one
// figure at a time; it asks its own UI spot `moss.character.renderer` for the drawing, keyed by the figure's format
// ("pngtuber" here), and this entry draws it. What this folder declares in moss.json is all the avatar plugin needs to know:
// the format and what it can do (`moss.character.formats`: `lipsync`, `expressions`), and one figure in it, Sunny
// (`moss.character.packs`: the model's entry file, whose small JSON list and pictures beside it come along). It ships no
// engine: the pictures are plain <img> elements, and a second set, for the `happy` expression, is drawn by code (an inline
// SVG), so there is nothing to ship for it.
//
// The avatar plugin's contract, point messages on its spot: it sends `{ mount, cue }` for this drawing's `mount`, and this
// renderer sends back `{ mount, names }` (which expressions it has) and `{ mount, box }` (where the figure stands). The mouth
// comes from MOSS Voice's own point `moss.voice.speech`, which this plugin fills: its levels, stamped in epoch milliseconds,
// become a speech feed through the SDK's `TimedSpeech`. Each point it fills is a line on its OK card.
import { useEffect, useMemo, useRef, useState } from "react";
import { TimedSpeech, useT, usePluginApi } from "@waifucave/moss-plugin-sdk/ui";

const RENDERER_SPOT = "moss.character.renderer";
const SPEECH_POINT = "moss.voice.speech";

/** What the avatar plugin gives its renderer spot. `file` is the URL of the figure's `.pngtuber.json`; `mount` names this
 *  drawing in the point messages. */
interface AvatarProps {
  mount?: string;
  name?: string;
  file: string;
  format: string;
  /** How the avatar plugin frames the figure, from the theme (CSS variables do not cross into a plugin's frame, so it reads them and
   *  sends them as data): the preset `mode`, or the part of the figure's height to `crop` to (0.2 to 1) with `headroom` above it.
   *  Absent: the whole picture, fitted. */
  framing?: { mode?: "full" | "bust" | "waist"; crop?: number; headroom?: number };
}
interface EntryProps { props: AvatarProps }

/** MOSS Voice's levels, kept by time (the SDK's `TimedSpeech`). */
function useVoiceFeed(): TimedSpeech {
  const api = usePluginApi();
  const feed = useMemo(() => new TimedSpeech(), []);
  useEffect(() => {
    feed.reopen();
    return () => feed.close();
  }, [feed]);
  useEffect(() => api.points.onMessage(SPEECH_POINT, (m) => feed.accept(m.value, m.from)), [api, feed]);
  return feed;
}

/** The avatar plugin's cues for this drawing, and what goes back to it. */
function useFigure(mount: string | undefined) {
  const api = usePluginApi();
  return useMemo(() => ({
    onCue(listener: (cue: { type?: unknown; name?: unknown }) => void, ask?: () => void): () => void {
      return api.points.onMessage(RENDERER_SPOT, (m) => {
        const v = m.value as { mount?: unknown; cue?: unknown; ask?: unknown } | null;
        if (mount === undefined || v?.mount !== mount) return;
        // The avatar plugin asks again for what it may have missed: say it once more.
        if (v.ask === "report") return ask?.();
        if (typeof v.cue === "object" && v.cue !== null) listener(v.cue as { type?: unknown; name?: unknown });
      });
    },
    say(what: Record<string, unknown>): void {
      if (mount !== undefined) void api.points.send(RENDERER_SPOT, { mount, ...what }).catch(() => undefined);
    },
  }), [api, mount]);
}

/** The model's own file: three pictures, named relative to it. */
interface Pictures { name?: string; idle: string; talk: string; blink: string }

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

/** Whether the bot is speaking now: from its first level's time to a moment after its last (the feed's `speaking`). A
 *  picture-swap figure shows its talking picture for all of it; it runs no timer of its own. */
function useTalking(feed: TimedSpeech): boolean {
  const [talking, setTalking] = useState(feed.speaking);
  useEffect(() => {
    setTalking(feed.speaking);
    return feed.onSpeaking(setTalking);
  }, [feed]);
  return talking;
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

/** Listens for the expression cue: whether the happy set is showing. It has just the one expression, held a few seconds. */
function useHappy(figure: ReturnType<typeof useFigure>): boolean {
  const [happy, setHappy] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const names = { expressions: [HAPPY], motions: [], outfits: [] };
    figure.say({ names });
    const off = figure.onCue((cue) => {
      if (cue.type !== "expression" || cue.name !== HAPPY) return;
      setHappy(true);
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => setHappy(false), HAPPY_MS);
    }, () => figure.say({ names }));
    return () => {
      off();
      if (timer !== undefined) clearTimeout(timer);
      figure.say({ names: null });
    };
  }, [figure]);
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

/** Where the picture goes in a box of `host` pixels when the stage frames it: `crop` of its height from the top, with `headroom` of it empty
 *  above, as large as that lets it be without leaving the box's width; the rest falls below the box. Undefined: no framing asked for. */
export function framePicture(framing: AvatarProps["framing"], natural: { width: number; height: number }, host: { width: number; height: number }): { left: number; top: number; width: number; height: number } | undefined {
  const preset = framing?.mode === "bust" ? 0.38 : framing?.mode === "waist" ? 0.56 : framing?.mode === "full" ? 1 : undefined;
  const crop = framing?.crop ?? preset;
  if (crop === undefined || !(natural.width > 0 && natural.height > 0 && host.width > 0 && host.height > 0)) return undefined;
  const headroom = framing?.crop === undefined ? 0.03 : (framing.headroom ?? 0.03);
  const scale = Math.min(host.height / (natural.height * (crop + headroom)), (host.width * 0.98) / natural.width);
  const width = natural.width * scale, height = natural.height * scale;
  return { left: (host.width - width) / 2, top: headroom * height, width, height };
}

const CSS = `
.pt { position: relative; overflow: hidden; width: 100%; height: 100%; display: grid; place-items: center; }
.pt [data-framed] { position: absolute; max-width: none; max-height: none; }
.pt [data-framed] .pt__svg { width: 100%; height: 100%; }
.pt img, .pt__svg { max-width: 100%; max-height: 100%; object-fit: contain; image-rendering: auto; user-select: none; -webkit-user-drag: none; }
.pt__note { color: var(--moss-color-text-muted, #6B6046); font: 13px var(--moss-font-family, system-ui, sans-serif); }
`;

export function PngtuberAvatar({ props }: EntryProps) {
  const t = useT();
  const botName = props.name ?? "";
  const pictures = usePictures(props.file);
  const mouthOpen = useTalking(useVoiceFeed());
  const blinking = useBlink();
  const figure = useFigure(props.mount);
  const happy = useHappy(figure);
  // Where the figure stands: its box's size and the picture's, said when it shows and when it resizes.
  const stage = useRef<HTMLDivElement>(null);
  const picture = useRef<HTMLElement | null>(null);
  // The stage's size and the picture's own, for the framing the stage asks for.
  const [hostSize, setHostSize] = useState({ width: 0, height: 0 });
  const [natural, setNatural] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const host = stage.current;
    if (!host || typeof ResizeObserver === "undefined") return;
    const say = (): void => {
      const h = host.getBoundingClientRect();
      setHostSize((was) => (was.width === Math.round(h.width) && was.height === Math.round(h.height) ? was : { width: Math.round(h.width), height: Math.round(h.height) }));
      const p = picture.current?.getBoundingClientRect();
      figure.say({ box: { canvas: { width: Math.round(h.width), height: Math.round(h.height) }, ...(p ? { figure: { x: Math.round(p.left - h.left), y: Math.round(p.top - h.top), width: Math.round(p.width), height: Math.round(p.height) } } : {}) } });
    };
    const ro = new ResizeObserver(say);
    ro.observe(host);
    say();
    return () => { ro.disconnect(); figure.say({ box: null }); };
  }, [figure, pictures === undefined || pictures === null, happy]);
  const shown = useMemo(() => {
    if (!pictures) return undefined;
    return mouthOpen ? pictures.urls.talk : blinking ? pictures.urls.blink : pictures.urls.idle;
  }, [pictures, mouthOpen, blinking]);
  const framed = framePicture(props.framing, happy ? { width: 200, height: 200 } : natural, hostSize);
  const place = framed === undefined ? undefined : ({ left: framed.left, top: framed.top, width: framed.width, height: framed.height } as const);
  return (
    <div ref={stage} className="pt" data-pngtuber={/* the mouth shows on either face, so talking is said first */ pictures === null ? "broken" : shown === undefined ? "loading" : mouthOpen ? "talk" : happy ? "happy" : blinking ? "blink" : "idle"}>
      <style>{CSS}</style>
      {pictures === null ? <span className="pt__note">{t("example-pngtuber.cant")}</span> : shown === undefined ? null : happy
        ? <span ref={(el) => { picture.current = el; }} {...(place === undefined ? { style: { display: "contents" } } : { "data-framed": "", style: { ...place, display: "block" } })}><HappyFace open={mouthOpen} label={t("example-pngtuber.label", { name: botName })} /></span>
        : <img ref={(el) => { picture.current = el; }} onLoad={(e) => setNatural({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })} {...(place === undefined ? {} : { "data-framed": "", style: place })} src={shown} alt={t("example-pngtuber.label", { name: botName })} draggable={false} />}
    </div>
  );
}
