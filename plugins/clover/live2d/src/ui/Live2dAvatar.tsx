// The bot's Live2D avatar on its stage (the stage's `avatar` spot, keyed `live2d`, spec §5.5 and decision 87), drawn by
// Mochi2D. The same caps as the VRM avatar: the files read with a running cap and checked before anything decodes them
// (`validateLive2d`), drawing only inside its own box, animating only while it can be seen and not paused, at most 30
// frames a second at rest and 60 while speech plays; with reduced motion it neither breathes nor idles, and only the
// eyes and mouth move. Its mouth moves with the speech the app plays (the `SpeechFeed` of loudness-and-brightness
// frames), never with a microphone: Mochi2D's live lip sync and its motion sync from audio are never started, and the
// model's motions play without their sounds.

import { useEffect, useRef, useState, type ReactElement } from "react";
import { MochiView, type ViewOptions } from "@waifucave/mochi2d";
import { parseMotionSync, type MotionSyncSetting } from "@waifucave/mochi2d/headless";
import { LipSync, SHUT, SpeechRing, frameSource, type SpeechFeed, type VisemeWeights } from "@waifucave/clover-plugin-vrm/lipsync";
import { mouthPlan, type MouthPlan } from "../mouth";
import { urlSource, zipSource, readCapped } from "../sources";
import { t } from "../strings";
import { LIVE2D_BUDGETS, Live2dRefusal, insideFolder, validateLive2d, type Live2dModel } from "../validate";
import { useLive2dStyles } from "./styles";

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

export const AVATAR_FPS = { quiet: 30, speaking: 60 } as const;

/** Mochi2D's view as the avatar uses it: what the tests fake (there is no WebGL without a browser). */
export interface Live2dView {
  load(input: { files: Record<string, Uint8Array> }, options?: { settings?: string }): Promise<Live2dShownModel>;
  advance(seconds: number): void;
  resize(): void;
  dispose(): void;
}

export interface Live2dShownModel {
  setParameter(id: string, value: number): boolean;
  setEffect(name: string, on: boolean): void;
  /** Mochi2D's runtime: the live lip-sync input, which motions and expressions can't override with `replace`. */
  runtime: { setLiveLipSync(source: { next(dt: number): number } | null, mix?: "add" | "replace" | "max" | ((live: number, current: number, id: string) => number)): boolean };
}

export type ViewFactory = (canvas: HTMLCanvasElement, options: ViewOptions) => Live2dView;

/** The view's options: the caps (decision 87). Nothing follows the pointer, nothing zooms or pans, the textures stay in
 *  a 256 MiB budget, and the loop is the avatar's own. */
export const VIEW_OPTIONS: ViewOptions = {
  autoStart: false,
  look: "off",
  zoom: false,
  pan: false,
  background: "transparent",
  textureBudget: 256,
  masks: "atlas",
  maxPixelRatio: 2,
  fit: 0.95,
};

const mochiView: ViewFactory = (canvas, options) => new MochiView(canvas, options) as unknown as Live2dView;

/** A fixed frame instead of a living avatar: the gallery's. */
export interface AvatarStill {
  visemes?: Partial<VisemeWeights>;
  /** 0 open to 1 shut. */
  blink?: number;
  /** 0 to 1. */
  breath?: number;
}

export interface Live2dAvatarProps {
  /** The settings file (`.model3.json`) or a `.zip` of the model's folder: a URL inside the bot's plugin. */
  src: string;
  name: string;
  portrait?: string;
  /** The speech the app plays, as frames on the audio clock; null when the bot is quiet. */
  speech?: SpeechFeed | null;
  paused?: boolean;
  reducedMotion?: boolean;
  still?: AvatarStill;
  frames?: AvatarFrames;
  maxFps?: { quiet: number; speaking: number };
  fetcher?: (url: string) => Promise<Response>;
  createView?: ViewFactory;
  onReady?: (model: Live2dModel) => void;
  onError?: (message: string, detail?: string) => void;
}

type Status = { state: "loading" } | { state: "ready"; model: Live2dModel } | { state: "error"; message: string };

/** Reads and checks the model behind `src`: a folder by its settings file, or a `.zip`. */
export async function loadLive2d(src: string, fetcher: (url: string) => Promise<Response> = (u) => fetch(u)): Promise<Live2dModel> {
  if (/\.zip(?:[?#]|$)/i.test(src)) {
    const bytes = await readCapped(await fetcher(src), LIVE2D_BUDGETS.totalBytes, "the archive");
    const { source, settingsPath } = zipSource(bytes);
    return validateLive2d(source, settingsPath);
  }
  const { source, settingsPath } = urlSource(src, fetcher);
  return validateLive2d(source, settingsPath);
}

function describe(error: unknown): { message: string; detail: string } {
  if (error instanceof Live2dRefusal) return { message: t(`clover.live2d.refused.${error.code}`), detail: error.detail };
  return { message: t("clover.live2d.refused.unreadable"), detail: error instanceof Error ? error.message : String(error) };
}

function motionSyncOf(model: Live2dModel): MotionSyncSetting | null {
  const path = model.settings.motionSync;
  if (!path) return null;
  // Resolved as the check resolved it, so `a/../b.motionsync3.json` finds the file the check read.
  const full = insideFolder(model.settingsPath, path);
  const bytes = full ? model.files.get(full) : undefined;
  if (!full || !bytes) return null;
  try {
    const file = parseMotionSync(bytes, full);
    return file.settings.find((s) => s.usable) ?? null;
  } catch {
    return null;
  }
}

export function Live2dAvatar(props: Live2dAvatarProps): ReactElement {
  useLive2dStyles();
  const { src, name, portrait, paused = false, still, frames = BROWSER_FRAMES } = props;
  const figure = useRef<HTMLElement | null>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const view = useRef<Live2dView | null>(null);
  const shown = useRef<Live2dShownModel | null>(null);
  const plan = useRef<MouthPlan | null>(null);
  /** The mouth's values this frame, by parameter: what the live lip-sync input writes over motions and expressions. */
  const mouth = useRef<{ open: number; values: Map<string, number> }>({ open: 0, values: new Map() });
  const [status, setStatus] = useState<Status>({ state: "loading" });
  const [visible, setVisible] = useState(true);
  const latest = useRef(props);
  latest.current = props;
  const lipsync = useRef(new LipSync(null));
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

  // Read, check, then show: a model that fails the check never reaches Mochi2D.
  useEffect(() => {
    let cancelled = false;
    setStatus({ state: "loading" });
    const el = canvas.current;
    (async () => {
      const model = await loadLive2d(src, latest.current.fetcher);
      if (cancelled || !el) return;
      let v: Live2dView;
      try {
        v = (latest.current.createView ?? mochiView)(el, VIEW_OPTIONS);
      } catch (error) {
        throw new Live2dRefusal("texture", error instanceof Error ? error.message : "no WebGL");
      }
      view.current = v;
      const m = await v.load({ files: Object.fromEntries(model.files) }, { settings: model.settingsPath });
      if (cancelled) return;
      shown.current = m;
      const lipSyncIds = model.settings.groups.find((g) => g.target === "Parameter" && g.name === "LipSync")?.ids ?? [];
      plan.current = mouthPlan(model.parameterIds, lipSyncIds, motionSyncOf(model));
      // The lip-sync parameters take the speech through Mochi2D's live input, mixed by `replace` per parameter: a motion
      // or an expression that moves the mouth never overrides what the bot is saying. The other mouth parameters (the
      // form, a motion-sync setting's own) are set as base values.
      m.runtime.setLiveLipSync({ next: () => mouth.current.open }, (live, _current, id) => mouth.current.values.get(id) ?? live);
      setStatus({ state: "ready", model });
      latest.current.onReady?.(model);
    })().catch((error: unknown) => {
      if (cancelled) return;
      const { message, detail } = describe(error);
      setStatus({ state: "error", message });
      latest.current.onError?.(message, detail);
    });
    return () => {
      cancelled = true;
      shown.current?.runtime.setLiveLipSync(null);
      view.current?.dispose();
      view.current = null;
      shown.current = null;
      plan.current = null;
    };
  }, [src]);

  // Reduced motion and a still: no breath and no idle; a still blinks only as it says.
  useEffect(() => {
    const m = shown.current;
    if (status.state !== "ready" || !m) return;
    const calm = props.reducedMotion === true || still !== undefined;
    m.setEffect("breath", !calm);
    m.setEffect("idle", !calm);
    m.setEffect("eyeBlink", still === undefined);
    m.setEffect("look", false);
  }, [status.state, props.reducedMotion, still]);

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

  /** Writes the mouth for these weights, then draws `dt` seconds on. */
  const drawNow = (dt: number, weights: VisemeWeights) => {
    const m = shown.current;
    const p = plan.current;
    if (!m || !p || !view.current) return;
    const values = p.values(weights);
    const live = new Map<string, number>();
    for (const [id, value] of values) {
      if (p.lipSync.has(id)) live.set(id, value);
      else m.setParameter(id, value);
    }
    mouth.current = { open: Math.max(0, ...live.values()), values: live };
    view.current.advance(dt);
  };

  const running = status.state === "ready" && visible && !paused && !still;

  // A still: its parameters set, then one frame drawn (again whenever it changes).
  const stillKey = still ? JSON.stringify(still) : null;
  useEffect(() => {
    const m = shown.current;
    if (status.state !== "ready" || !still || !m) return;
    const open = 1 - (still.blink ?? 0);
    m.setParameter("ParamEyeLOpen", open);
    m.setParameter("ParamEyeROpen", open);
    m.setParameter("ParamBreath", still.breath ?? 0);
    drawNow(0, { ...SHUT, ...still.visemes });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.state, stillKey]);

  // The first picture of a paused or unseen avatar, so it is never blank.
  useEffect(() => {
    if (status.state === "ready" && !still) drawNow(0, SHUT);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.state]);

  // The living avatar: a frame loop only while it is ready, seen and not paused, at most `maxFps`.
  useEffect(() => {
    if (!running) return;
    let last = frames.now();
    let due = last;
    let id = frames.requestFrame(function tick() {
      const now = frames.now();
      const fps = latest.current.maxFps ?? AVATAR_FPS;
      const gap = 1000 / (speaking.current() ? fps.speaking : fps.quiet);
      if (now >= due - 4) {
        const dt = (now - last) / 1000;
        drawNow(dt, lipsync.current.sample(dt));
        last = now;
        due += gap;
        if (due <= now) due = now + gap;
      }
      id = frames.requestFrame(tick);
    });
    return () => frames.cancelFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, frames]);

  return (
    <figure ref={figure} className="clvl-avatar" data-state={status.state} data-running={running || undefined} aria-label={name}>
      <div className="clvl-view">
        <canvas ref={canvas} className="clvl-canvas" aria-hidden="true" />
        {status.state === "loading" ? (
          <div className="clvl-wait" role="status">
            {portrait ? <img className="clvl-portrait" src={portrait} alt="" draggable={false} /> : <span className="clvl-silhouette" aria-hidden="true" />}
            <span className="clvl-wait-line">{t("clover.live2d.gettingReady", { name })}</span>
          </div>
        ) : null}
        {status.state === "error" ? (
          <div className="clvl-error" role="alert">
            {portrait ? <img className="clvl-portrait" src={portrait} alt="" draggable={false} /> : null}
            <span className="clvl-error-title">{t("clover.live2d.cantShow", { name })}</span>
            <span className="clvl-error-line">{status.message}</span>
          </div>
        ) : null}
      </div>
    </figure>
  );
}
