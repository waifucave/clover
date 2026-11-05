// The bot's avatar on its stage (the stage's `avatar` spot, keyed `vrm`, spec §5.5): the VRM drawn in the
// theme's light, breathing and blinking at rest, its mouth moving with the speech the app plays — told to it as a
// feed of loudness-and-brightness frames on the audio clock (`SpeechFeed`), so it hears nothing itself and asks
// for no `audio` capability. It animates only while it can be seen (on screen, the window not hidden, not
// paused), spec open question 33's budget, and draws at most 30 frames a second at rest, 60 while speech plays;
// with reduced motion the body holds still and only the eyes and mouth move. The model's licence fields are
// honoured: a model that asks for credit, or that its maker marked a placeholder, carries a credit line, on a
// plate in a band of its own below the avatar, never over it.
//
// The file is read with a running cap: a Content-Length over it is refused before the body is read, and the
// body streams in until it passes the cap, then stops.

import { useEffect, useRef, useState, type ReactElement } from "react";
import { LipSync, SpeechRing, frameSource, type SpeechFeed } from "../lipsync/sources";
import { SHUT, type VisemeWeights } from "../lipsync/visemes";
import { Blinker } from "../motion/blink";
import { idlePose } from "../motion/idle";
import { t } from "../strings";
import { AvatarError, AvatarScene, DEFAULT_LIGHTS, type FaceState, type Framing, type RendererFactory, type StageLights } from "../vrm/scene";
import { MAX_VRM_BYTES, type VrmMeta } from "../vrm/validate";
import { useAvatarStyles } from "./styles";

export interface AvatarFrames {
  now(): number;
  requestFrame(callback: (time: number) => void): number;
  cancelFrame(id: number): void;
}

export const BROWSER_FRAMES: AvatarFrames = {
  now: () => performance.now(),
  requestFrame: (callback) => requestAnimationFrame(callback),
  cancelFrame: (id) => cancelAnimationFrame(id),
};

/** A fixed frame instead of a living avatar: the gallery's. */
export interface AvatarStill {
  /** Seconds into the idle motion. */
  at: number;
  visemes?: Partial<VisemeWeights>;
  blink?: number;
  happy?: number;
  surprised?: number;
}

export interface VrmAvatarProps {
  /** The avatar file: a URL inside the bot's plugin, or its bytes. */
  src: string | ArrayBuffer;
  /** Who it is, for its label and its loading line. */
  name: string;
  /** Shown while the model loads, and in its place if it can't be drawn. */
  portrait?: string;
  /** The speech the app plays, as frames on the audio clock; null when the bot is quiet. */
  speech?: SpeechFeed | null;
  happy?: number;
  surprised?: number;
  framing?: Framing;
  /** The host's own reason to stop (the tab behind another). */
  paused?: boolean;
  reducedMotion?: boolean;
  still?: AvatarStill;
  /** The stage's light; read from the theme's `avatar.*` tokens when omitted. */
  lights?: StageLights;
  credit?: "auto" | "always" | "never";
  createRenderer?: RendererFactory;
  fetchBytes?: (url: string) => Promise<ArrayBuffer>;
  frames?: AvatarFrames;
  onReady?: (meta: VrmMeta) => void;
  /** What the screen says went wrong, and the check's detail for the log. */
  onError?: (message: string, detail?: string) => void;
  /** Draws at most this many frames a second while quiet and while speech plays (the idle budget, OQ 33). */
  maxFps?: { quiet: number; speaking: number };
}

type Status = { state: "loading" } | { state: "ready"; meta: VrmMeta } | { state: "error"; message: string };

export const AVATAR_FPS = { quiet: 30, speaking: 60 } as const;

/**
 * The avatar file's bytes, never more than `limit`: a Content-Length over it is refused before the body is read,
 * and the body is read as a stream and dropped the moment it passes the limit (a server may send more than it says,
 * and a compressed body more than its Content-Length).
 */
export async function fetchCapped(url: string, limit = MAX_VRM_BYTES, fetcher: (url: string) => Promise<Response> = (u) => fetch(u)): Promise<ArrayBuffer> {
  const response = await fetcher(url);
  if (!response.ok) throw new AvatarError("unreadable", `The server answered ${response.status}.`);
  const tooLarge = () => new AvatarError("too-large", `Over ${limit} bytes.`);
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  const reader = response.body?.getReader();
  if (!reader) {
    const whole = await response.arrayBuffer();
    if (whole.byteLength > limit) throw tooLarge();
    return whole;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out.buffer;
}

/** What the screen says about an error, and its detail for the log. */
function describeError(error: unknown): { message: string; detail: string } {
  if (error instanceof AvatarError) return { message: t(`clover.vrm.refused.${error.reason}`), detail: error.detail };
  return { message: t("clover.vrm.refused.unreadable"), detail: error instanceof Error ? error.message : String(error) };
}

/** The light the theme gives the stage, from its custom properties. */
export function themeLights(el: Element | null): StageLights {
  if (!el || typeof getComputedStyle !== "function") return DEFAULT_LIGHTS;
  const style = getComputedStyle(el);
  const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  const exposure = Number.parseFloat(read("--clover-avatar-exposure", "1"));
  return {
    key: read("--clover-avatar-light-key", DEFAULT_LIGHTS.key),
    fill: read("--clover-avatar-light-fill", DEFAULT_LIGHTS.fill),
    rim: read("--clover-avatar-light-rim", DEFAULT_LIGHTS.rim),
    exposure: Number.isFinite(exposure) ? exposure : 1,
  };
}

/** The credit line a model's licence asks for, or its maker's placeholder mark; null when none is due. */
export function creditLine(meta: VrmMeta, credit: "auto" | "always" | "never" = "auto"): string | null {
  if (credit === "never") return null;
  if (credit === "auto" && !meta.creditRequired && !meta.placeholder) return null;
  const licence = meta.otherLicenceUrl ? licenceName(meta.otherLicenceUrl) : meta.licenceName;
  return [meta.title, meta.author ? t("clover.vrm.by", { author: meta.author }) : null, licence].filter(Boolean).join(" · ");
}

function licenceName(url: string): string {
  if (/^https:\/\/vrm\.dev\/licenses\/1\.0\/?$/i.test(url)) return "VRM Public License 1.0";
  if (/apache\.org\/licenses\/LICENSE-2\.0/i.test(url)) return "Apache-2.0";
  if (/creativecommons\.org\/publicdomain\/zero/i.test(url)) return "CC0";
  return url.replace(/^https?:\/\//, "");
}

const ratio = () => (typeof window === "undefined" ? 1 : Math.min(2, window.devicePixelRatio || 1));

export function VrmAvatar(props: VrmAvatarProps): ReactElement {
  useAvatarStyles();
  const { src, name, portrait, framing = "bust", paused = false, still, credit = "auto", frames = BROWSER_FRAMES } = props;
  const figure = useRef<HTMLElement | null>(null);
  /** What the canvas fills: the figure less the credit's band. */
  const view = useRef<HTMLDivElement | null>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const scene = useRef<AvatarScene | null>(null);
  const [status, setStatus] = useState<Status>({ state: "loading" });
  const [visible, setVisible] = useState(true);
  const latest = useRef(props);
  latest.current = props;
  const lipsync = useRef(new LipSync(null));
  const blinker = useRef(new Blinker());
  /** Whether speech sounds now: a pushed frame covers the audio clock's now. */
  const speaking = useRef<() => boolean>(() => false);

  // The speech feed: its frames into a ring, read at the audio clock's now.
  const feed = props.speech ?? null;
  useEffect(() => {
    speaking.current = () => false;
    if (!feed) {
      lipsync.current.use(null);
      return;
    }
    const ring = new SpeechRing(48000, 0);
    const now = () => feed.now();
    lipsync.current.use(frameSource(ring, now));
    speaking.current = () => ring.frameAt(now()) !== null;
    const stop = feed.subscribe((frames) => ring.push(frames));
    return () => {
      stop();
      lipsync.current.use(null);
      speaking.current = () => false;
    };
  }, [feed]);

  /** The face and pose for this moment: a still's, or the living avatar's. */
  const moment = (dt: number, timeMs: number): { pose: ReturnType<typeof idlePose>; face: FaceState } => {
    const p = latest.current;
    if (p.still) {
      return {
        pose: idlePose(p.still.at, p.reducedMotion),
        face: { visemes: { ...SHUT, ...p.still.visemes }, blink: p.still.blink ?? 0, happy: p.still.happy ?? p.happy, surprised: p.still.surprised ?? p.surprised },
      };
    }
    const seconds = timeMs / 1000;
    return { pose: idlePose(seconds, p.reducedMotion), face: { visemes: lipsync.current.sample(dt), blink: blinker.current.value(seconds), happy: p.happy, surprised: p.surprised } };
  };

  const drawNow = (dt: number) => {
    const s = scene.current;
    if (!s?.loaded) return;
    const { pose, face } = moment(dt, frames.now());
    s.draw(pose, face, dt);
  };

  // The scene lives as long as the component; the model loads again when the file changes.
  useEffect(() => {
    if (!canvas.current) return;
    let alive = true;
    let made: AvatarScene;
    try {
      made = new AvatarScene(canvas.current, { createRenderer: latest.current.createRenderer, framing, lights: latest.current.lights ?? themeLights(figure.current) });
    } catch (error) {
      const message = t("clover.vrm.noWebgl");
      setStatus({ state: "error", message });
      latest.current.onError?.(message, error instanceof Error ? error.message : String(error));
      return;
    }
    scene.current = made;
    setStatus({ state: "loading" });
    (async () => {
      try {
        const bytes = typeof src === "string" ? await (latest.current.fetchBytes ?? ((url: string) => fetchCapped(url)))(src) : src;
        const loaded = await made.load(bytes);
        if (!alive) return;
        const rect = view.current?.getBoundingClientRect();
        made.setSize(rect?.width || 300, rect?.height || 400, ratio());
        setStatus({ state: "ready", meta: loaded.meta });
        latest.current.onReady?.(loaded.meta);
      } catch (error) {
        if (!alive) return;
        const { message, detail } = describeError(error);
        setStatus({ state: "error", message });
        latest.current.onError?.(message, detail);
      }
    })();
    return () => {
      alive = false;
      made.dispose();
      scene.current = null;
    };
    // The file decides the model; everything else is read live.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  useEffect(() => {
    scene.current?.frame(framing);
  }, [framing]);

  useEffect(() => {
    if (props.lights) scene.current?.setLights(props.lights);
  }, [props.lights]);

  // Seen or not: on screen, and the window not hidden.
  useEffect(() => {
    const el = figure.current;
    const doc = el?.ownerDocument;
    let onScreen = true;
    const update = () => setVisible(onScreen && doc?.visibilityState !== "hidden");
    let observer: IntersectionObserver | undefined;
    if (el && typeof IntersectionObserver !== "undefined") {
      observer = new IntersectionObserver((entries) => {
        onScreen = entries.some((e) => e.isIntersecting);
        update();
      });
      observer.observe(el);
    }
    doc?.addEventListener("visibilitychange", update);
    return () => {
      observer?.disconnect();
      doc?.removeEventListener("visibilitychange", update);
    };
  }, []);

  const running = status.state === "ready" && visible && !paused && !still;

  // The canvas follows its view's size; a still (or a paused avatar) draws again at the new size.
  useEffect(() => {
    const el = view.current;
    if (!el || status.state !== "ready" || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const rect = el.getBoundingClientRect();
      scene.current?.setSize(rect.width, rect.height, ratio());
      if (!running) drawNow(0);
    });
    observer.observe(el);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.state, running]);

  // A still: its spring bones settle for a second, then it draws once (again whenever it changes).
  const stillKey = still ? JSON.stringify(still) : null;
  useEffect(() => {
    const s = scene.current;
    if (status.state !== "ready" || !still || !s) return;
    const { pose, face } = moment(1 / 60, 0);
    s.settle(pose, face, 1.5);
    s.draw(pose, face, 1 / 60);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.state, stillKey, props.reducedMotion]);

  // The living avatar: a frame loop only while it is ready, seen and not paused, drawing at most `maxFps` (a display
  // at 120 Hz draws half its frames; the frames it skips cost a callback, not a picture).
  useEffect(() => {
    if (!running) return;
    let last = frames.now();
    let due = last;
    let id = frames.requestFrame(function tick() {
      const now = frames.now();
      const fps = latest.current.maxFps ?? AVATAR_FPS;
      const gap = 1000 / (speaking.current() ? fps.speaking : fps.quiet);
      // Draws fall due on a steady schedule, with a few milliseconds' grace for a display's frames landing early.
      if (now >= due - 4) {
        drawNow((now - last) / 1000);
        last = now;
        due += gap;
        if (due <= now) due = now + gap;
      }
      id = frames.requestFrame(tick);
    });
    return () => frames.cancelFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, frames]);

  const line = status.state === "ready" ? creditLine(status.meta, credit) : null;
  return (
    <figure ref={figure} className="clvr-avatar" data-state={status.state} data-running={running || undefined} aria-label={name}>
      <div ref={view} className="clvr-view">
        <canvas ref={canvas} className="clvr-canvas" aria-hidden="true" />
        {status.state === "loading" ? (
          <div className="clvr-wait" role="status">
            {portrait ? <img className="clvr-portrait" src={portrait} alt="" draggable={false} /> : <span className="clvr-silhouette" aria-hidden="true" />}
            <span className="clvr-wait-line">{t("clover.vrm.gettingReady", { name })}</span>
          </div>
        ) : null}
        {status.state === "error" ? (
          <div className="clvr-error" role="alert">
            {portrait ? <img className="clvr-portrait" src={portrait} alt="" draggable={false} /> : null}
            <span className="clvr-error-title">{t("clover.vrm.cantShow", { name })}</span>
            <span className="clvr-error-line">{status.message}</span>
          </div>
        ) : null}
      </div>
      {line ? (
        <figcaption className="clvr-credit">
          <span className="clvr-credit-plate">{line}</span>
        </figcaption>
      ) : null}
    </figure>
  );
}
