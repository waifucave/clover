// The bot's avatar on its stage (the stage's `avatar` spot, keyed `vrm`, spec §5.5): the VRM drawn in the
// theme's light, breathing and blinking at rest, its mouth moving with the speech the app plays. It animates
// only while it can be seen (on screen, the window not hidden, not paused), spec open question 33's budget;
// with reduced motion the body holds still and only the eyes and mouth move. The model's licence fields are
// honoured: a model that asks for credit, or that its maker marked a placeholder, carries a credit line.

import { useEffect, useRef, useState, type ReactElement } from "react";
import { LipSync, type LipSyncSource } from "../lipsync/sources";
import { SHUT, type VisemeWeights } from "../lipsync/visemes";
import { Blinker } from "../motion/blink";
import { idlePose } from "../motion/idle";
import { AvatarScene, DEFAULT_LIGHTS, type FaceState, type Framing, type RendererFactory, type StageLights } from "../vrm/scene";
import type { VrmMeta } from "../vrm/validate";
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
  /** The speech playing now; null when the bot is quiet. */
  speech?: LipSyncSource | null;
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
  onError?: (message: string) => void;
}

type Status = { state: "loading" } | { state: "ready"; meta: VrmMeta } | { state: "error"; message: string };

const NO_WEBGL = "This computer can't draw the 3D avatar here.";

const fetchArrayBuffer = async (url: string): Promise<ArrayBuffer> => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`The avatar file could not be read (${response.status}).`);
  return response.arrayBuffer();
};

/** The light the theme gives the stage, from its custom properties. */
export function themeLights(el: Element | null): StageLights {
  if (!el || typeof getComputedStyle !== "function") return DEFAULT_LIGHTS;
  const style = getComputedStyle(el);
  const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  const exposure = Number.parseFloat(read("--avatar-exposure", "1"));
  return {
    key: read("--avatar-light-key", DEFAULT_LIGHTS.key),
    fill: read("--avatar-light-fill", DEFAULT_LIGHTS.fill),
    rim: read("--avatar-light-rim", DEFAULT_LIGHTS.rim),
    exposure: Number.isFinite(exposure) ? exposure : 1,
  };
}

/** The credit line a model's licence asks for, or its maker's placeholder mark; null when none is due. */
export function creditLine(meta: VrmMeta, credit: "auto" | "always" | "never" = "auto"): string | null {
  if (credit === "never") return null;
  if (credit === "auto" && !meta.creditRequired && !meta.placeholder) return null;
  const licence = meta.otherLicenceUrl ? licenceName(meta.otherLicenceUrl) : meta.licenceName;
  return [meta.title, meta.author ? `by ${meta.author}` : null, licence].filter(Boolean).join(" · ");
}

function licenceName(url: string): string {
  if (/apache\.org\/licenses\/LICENSE-2\.0/i.test(url)) return "Apache-2.0";
  if (/creativecommons\.org\/publicdomain\/zero/i.test(url)) return "CC0";
  return url.replace(/^https?:\/\//, "");
}

const ratio = () => (typeof window === "undefined" ? 1 : Math.min(2, window.devicePixelRatio || 1));

export function VrmAvatar(props: VrmAvatarProps): ReactElement {
  useAvatarStyles();
  const { src, name, portrait, framing = "bust", paused = false, still, credit = "auto", frames = BROWSER_FRAMES } = props;
  const figure = useRef<HTMLElement | null>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const scene = useRef<AvatarScene | null>(null);
  const [status, setStatus] = useState<Status>({ state: "loading" });
  const [visible, setVisible] = useState(true);
  const latest = useRef(props);
  latest.current = props;
  const lipsync = useRef(new LipSync(null));
  const blinker = useRef(new Blinker());
  lipsync.current.use(props.speech ?? null);

  /** The face and pose for this moment: a still's, or the living avatar's. */
  const moment = (dt: number, timeMs: number): { pose: ReturnType<typeof idlePose>; face: FaceState } => {
    const p = latest.current;
    if (p.still) {
      return {
        pose: idlePose(p.still.at, p.reducedMotion),
        face: { visemes: { ...SHUT, ...p.still.visemes }, blink: p.still.blink ?? 0, happy: p.still.happy ?? p.happy, surprised: p.still.surprised ?? p.surprised },
      };
    }
    const t = timeMs / 1000;
    return { pose: idlePose(t, p.reducedMotion), face: { visemes: lipsync.current.sample(dt), blink: blinker.current.value(t), happy: p.happy, surprised: p.surprised } };
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
    } catch {
      setStatus({ state: "error", message: NO_WEBGL });
      latest.current.onError?.(NO_WEBGL);
      return;
    }
    scene.current = made;
    setStatus({ state: "loading" });
    (async () => {
      try {
        const bytes = typeof src === "string" ? await (latest.current.fetchBytes ?? fetchArrayBuffer)(src) : src;
        const loaded = await made.load(bytes);
        if (!alive) return;
        const rect = figure.current?.getBoundingClientRect();
        made.setSize(rect?.width || 300, rect?.height || 400, ratio());
        setStatus({ state: "ready", meta: loaded.meta });
        latest.current.onReady?.(loaded.meta);
      } catch (error) {
        if (!alive) return;
        const message = error instanceof Error ? error.message : String(error);
        setStatus({ state: "error", message });
        latest.current.onError?.(message);
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

  // The canvas follows the figure's size; a still (or a paused avatar) draws again at the new size.
  useEffect(() => {
    const el = figure.current;
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

  // The living avatar: a frame loop only while it is ready, seen and not paused.
  useEffect(() => {
    if (!running) return;
    let last = frames.now();
    let id = frames.requestFrame(function tick() {
      const now = frames.now();
      drawNow((now - last) / 1000);
      last = now;
      id = frames.requestFrame(tick);
    });
    return () => frames.cancelFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, frames]);

  const line = status.state === "ready" ? creditLine(status.meta, credit) : null;
  return (
    <figure ref={figure} className="clvr-avatar" data-state={status.state} data-running={running || undefined} aria-label={name}>
      <canvas ref={canvas} className="clvr-canvas" aria-hidden="true" />
      {status.state === "loading" ? (
        <div className="clvr-wait" role="status">
          {portrait ? <img className="clvr-portrait" src={portrait} alt="" draggable={false} /> : <span className="clvr-silhouette" aria-hidden="true" />}
          <span className="clvr-wait-line">Getting {name} ready…</span>
        </div>
      ) : null}
      {status.state === "error" ? (
        <div className="clvr-error" role="alert">
          {portrait ? <img className="clvr-portrait" src={portrait} alt="" draggable={false} /> : null}
          <span className="clvr-error-title">{name}'s avatar can't be shown</span>
          <span className="clvr-error-line">{status.message}</span>
        </div>
      ) : null}
      {line ? <figcaption className="clvr-credit">{line}</figcaption> : null}
    </figure>
  );
}
