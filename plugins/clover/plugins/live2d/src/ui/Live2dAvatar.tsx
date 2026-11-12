// The bot's Live2D avatar on its stage (the stage's `avatar` spot, keyed `live2d`, spec §5.5 and decision 87), drawn by
// Mochi2D. The same caps as the VRM avatar: the files read with a running cap and checked before anything decodes them
// (`validateLive2d`), drawing only inside its own box, animating only while it can be seen and not paused, at most 30
// frames a second at rest and 60 while speech plays; with reduced motion it neither breathes nor idles, and only the
// eyes and mouth move. Its mouth moves with the speech the app plays (the `SpeechFeed` of loudness-and-brightness
// frames), never with a microphone: Mochi2D's live lip sync and its motion sync from audio are never started, and the
// model's motions play without their sounds.

import { useEffect, useRef, useState, type ReactElement } from "react";
import { MochiView, type ViewOptions } from "@waifucave/mochi2d";
import { drawnBounds, frameFor, readCrop, type Box, type Crop, type DrawnRuntime } from "./framing";
import { parseMotionSync, type MotionSyncSetting } from "@waifucave/mochi2d/headless";
import { LipSync, SHUT, SpeechRing, frameSource, type SpeechFeed, type VisemeWeights } from "@waifucave/clover-plugin-vrm/lipsync";
import { mouthPlan, type MouthPlan } from "../mouth";
import { urlSource, zipSource, readCapped } from "../sources";
import { t } from "../strings";
import { LIVE2D_BUDGETS, Live2dRefusal, insideFolder, validateLive2d, type Live2dModel } from "../validate";
import { useLive2dStyles } from "./styles";
import { boxFromRect, type FigureControl } from "@waifucave/clover-plugin-vrm/control";
import { startFigureCues, type CueModel, type FigureCues } from "./figure-cues";
import { Gaze, paramNames, readTable, type StageTable } from "../cues";

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

/** Frames a second: at rest while the user is about (`quiet`), with no one about for a while (`calm`, nearly still), while speech plays. */
export const AVATAR_FPS = { quiet: 20, typing: 6, calm: 2, speaking: 60 } as const;
/** How long after a keystroke she keeps the typing rate (the glance), before settling back to calm. */
export const TYPING_MS = 2500;
/** How long with no input in this document before the avatar goes calm. */
export const CALM_AFTER_MS = 8000;

/** Mochi2D's view as the avatar uses it: what the tests fake (there is no WebGL without a browser). */
export interface Live2dView {
  load(input: { files: Record<string, Uint8Array> }, options?: { settings?: string }): Promise<Live2dShownModel>;
  advance(seconds: number): void;
  /** Looks at a point in page coordinates (the look effect follows it). */
  lookAt?(clientX: number, clientY: number): void;
  /** The model's rectangle on the page now (client coordinates), or null while nothing is shown. */
  figureRect?(): { left: number; top: number; right: number; bottom: number } | null;
  /** Frames the figure by what is drawn: `crop` of its height from the top (with its headroom), or the whole canvas fitted when null. True when the view changed (it needs a redraw); false when it was already so or there is nothing to frame yet. */
  frame?(crop: Crop | null): boolean;
  resize(): void;
  dispose(): void;
}

export interface Live2dShownModel {
  setParameter(id: string, value: number): boolean;
  setEffect(name: string, on: boolean): void;
  /** Mochi2D's runtime: the live lip-sync input, which motions and expressions can't override with `replace`. */
  setExpression?(name: string, fades?: { fadeIn?: number }): unknown;
  clearExpression?(fades?: { fadeOut?: number }): unknown;
  startMotion?(group: string, index?: number): unknown;
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

const mochiView: ViewFactory = (canvas, options) => {
  const v = new MochiView(canvas, options);
  const view = v as unknown as Live2dView;
  // What is drawn (the union of the shown drawables at rest, kept per model: a motion's swing never moves the frame) and how it is framed now.
  let drawn: { model: unknown; box: Box } | undefined;
  let framed = "";
  view.frame = (crop) => {
    const m = v.model;
    if (!m) return false;
    if (drawn && drawn.model !== m) { drawn = undefined; framed = ""; }
    const el = canvas;
    const px = { width: el.clientWidth, height: el.clientHeight };
    const key = crop ? `${crop.show}/${crop.headroom}/${px.width}x${px.height}` : "";
    if (key === framed) return false;
    if (!crop) { v.resetView(); framed = key; return true; }
    // The view's own scale follows the canvas's size; ask it to have caught up before the frame is worked out from it.
    v.resize();
    if (!drawn) {
      const b = drawnBounds(m.runtime as unknown as DrawnRuntime);
      if (!b) return false;
      drawn = { model: m, box: b };
    }
    const t = v.viewTransform;
    const f = frameFor(drawn.box, m.canvas, crop, px, t.zoom > 0 ? t.pixelsPerUnit / t.zoom : 0);
    if (!f) return false;
    v.setView(f);
    framed = key;
    return true;
  };
  // The figure's rectangle on the page now (client coordinates): the drawn figure where it is known, else the model's canvas rectangle, as the view shows it.
  view.figureRect = () => {
    const m = v.model;
    if (!m) return null;
    const c = drawn && drawn.model === m ? { left: drawn.box.minX, right: drawn.box.maxX, top: drawn.box.maxY, bottom: drawn.box.minY } : m.canvas;
    const a = v.toPage(c.left, c.top);
    const b = v.toPage(c.right, c.bottom);
    return a && b ? { left: Math.min(a.x, b.x), top: Math.min(a.y, b.y), right: Math.max(a.x, b.x), bottom: Math.max(a.y, b.y) } : null;
  };
  return view;
};

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
  /** The app's avatar control (`useAvatarControl()`): the bot plugin's cues in, the model's names and the figure's box
   *  out. Without it the figure only lives (breath, idle, blink, the glance). */
  control?: FigureControl;
  paused?: boolean;
  reducedMotion?: boolean;
  still?: AvatarStill;
  frames?: AvatarFrames;
  maxFps?: { quiet: number; speaking: number; calm?: number; typing?: number };
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
  /** Mochi2D's `textureNotice` (the downscale it applied), for the figure's data attribute. */
  const noticeRef = useRef("");
  /** The last time the user did anything in this document (the avatar draws slowly after a while without). */
  const lastInput = useRef(performance.now());
  const lastKey = useRef(Number.NEGATIVE_INFINITY);
  const calm = useRef(false);
  /** The crop the stage's CSS asks for (`--clover-avatar-crop` and `--clover-avatar-headroom`); none: the whole canvas, fitted. */
  const crop = useRef<Crop | undefined>(undefined);
  /** Frames the figure for the crop now; the view draws again when it moved. */
  const applyFrame = () => {
    const v = view.current;
    if (v?.frame?.(crop.current ?? null)) v.advance(0);
  };

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
      noticeRef.current = String((m as { textureNotice?: unknown }).textureNotice ?? "");
      const lipSyncIds = model.settings.groups.find((g) => g.target === "Parameter" && g.name === "LipSync")?.ids ?? [];
      plan.current = mouthPlan(model.parameterIds, lipSyncIds, motionSyncOf(model));
      // The lip-sync parameters take the speech through Mochi2D's live input, mixed by `replace` per parameter: a motion
      // or an expression that moves the mouth never overrides what the bot is saying. The other mouth parameters (the
      // form, a motion-sync setting's own) are set as base values.
      // A model with no `LipSync` group has no lip sync in Mochi2D (`setLiveLipSync` says false): then its mouth is
      // written with `setParameter` like the rest, and nothing goes through the live input.
      const live = m.runtime.setLiveLipSync({ next: () => mouth.current.open }, (value, _current, id) => mouth.current.values.get(id) ?? value);
      if (!live) plan.current = { ...plan.current, lipSync: new Set<string>() };
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

  // Her stage: the names this model answers to go to the app (`control`), and the bot plugin's cues come back as
  // expressions, motions, outfit changes, a pace and a look-at point. Only a figure with a `control` has them.
  const bridge = useRef<FigureCues | null>(null);
  useEffect(() => {
    const m = shown.current;
    const control = latest.current.control;
    if (status.state !== "ready" || !m || !control) return;
    let gone = false;
    void (async () => {
      const model = status.model;
      const infoPath = model.settings.displayInfo ? insideFolder(model.settingsPath, model.settings.displayInfo) : null;
      const bytes = infoPath ? model.files.get(infoPath) : undefined;
      let params = new Map<string, string>();
      try { if (bytes) params = paramNames(JSON.parse(new TextDecoder().decode(bytes))); } catch { /* none */ }
      let table: StageTable = {};
      try {
        if (!/\.zip(?:[?#]|$)/i.test(src) && !/^(blob|data):/.test(src)) {
          const r = await (latest.current.fetcher ?? ((u: string) => fetch(u)))(new URL("stage-map.json", new URL(src, location.href)).href);
          if (r.ok) {
            // Only a names table is read: more than 256 KiB is not one.
            const text = await r.text();
            if (text.length <= 256 * 1024) table = readTable(JSON.parse(text));
          }
        }
      } catch { /* no table beside the model */ }
      if (gone) return;
      bridge.current = startFigureCues({
        control, model: m as CueModel,
        facts: { expressions: model.settings.expressions.map((e) => e.name ?? "").filter((n) => n !== ""), motionGroups: model.settings.motions.map((g) => g.group), params },
        table,
      });
    })();
    return () => { gone = true; bridge.current?.stop(); bridge.current = null; };
  }, [status.state, props.control]);

  // Where the figure stands, for the app (throttled there; nothing while the window is hidden): the canvas, the model's
  // rectangle and the anchors a portrait has. Said when the model shows, and each second or so while it draws.
  const boxAt = useRef(0);
  const reportBox = (force = false) => {
    const control = latest.current.control;
    const el = figure.current;
    if (!control || !el || status.state !== "ready") return;
    const now = performance.now();
    if (!force && now - boxAt.current < 500) return;
    boxAt.current = now;
    const host = el.getBoundingClientRect();
    const r = view.current?.figureRect?.();
    control.setBox(r ? boxFromRect(host, { x: r.left - host.left, y: r.top - host.top, width: r.right - r.left, height: r.bottom - r.top }) : { canvas: { width: Math.round(host.width), height: Math.round(host.height) } });
  };
  useEffect(() => {
    if (status.state !== "ready") return;
    reportBox(true);
    return () => latest.current.control?.setBox(undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.state, props.control]);

  // The stage's framing, read once the figure is shown and again when its box changes (a layout may switch it with the window's shape).
  useEffect(() => {
    const el = figure.current;
    if (status.state !== "ready" || !el || typeof getComputedStyle !== "function") return;
    const read = () => { crop.current = readCrop(getComputedStyle(el)); applyFrame(); reportBox(true); };
    read();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.state]);

  // Reduced motion and a still: no breath and no idle; a still blinks only as it says.
  useEffect(() => {
    const m = shown.current;
    if (status.state !== "ready" || !m) return;
    const calm = props.reducedMotion === true || still !== undefined;
    m.setEffect("breath", !calm);
    m.setEffect("idle", !calm);
    m.setEffect("eyeBlink", still === undefined);
    // She looks only where the stage tells her (the composer while the user types, the conversation while a turn runs),
    // never at the pointer: the view's own follow stays off.
    m.setEffect("look", !calm);
  }, [status.state, props.reducedMotion, still]);

  // The glance: the user typing in the composer in this document, and a turn running (the stage's cue).
  const gaze = useRef(new Gaze());
  const aimed = useRef("");
  useEffect(() => {
    const doc = figure.current?.ownerDocument;
    if (status.state !== "ready" || !doc) return;
    const editable = (t: EventTarget | null) => t instanceof (doc.defaultView?.HTMLElement ?? HTMLElement) && (t.tagName === "TEXTAREA" || t.isContentEditable);
    const typed = (e: Event) => { if (editable(e.target)) { composer.current = e.target as HTMLElement; gaze.current.typed(performance.now() / 1000); } };
    const touch = () => { lastInput.current = performance.now(); };
    const key = () => { lastKey.current = performance.now(); };
    for (const ev of ["pointermove", "pointerdown", "wheel"]) doc.addEventListener(ev, touch, { capture: true, passive: true });
    for (const ev of ["keydown", "input"]) doc.addEventListener(ev, key, { capture: true, passive: true });
    doc.addEventListener("input", typed, true);
    doc.addEventListener("keydown", typed, true);
    return () => { for (const ev of ["pointermove", "pointerdown", "wheel"]) doc.removeEventListener(ev, touch, true); for (const ev of ["keydown", "input"]) doc.removeEventListener(ev, key, true); doc.removeEventListener("input", typed, true); doc.removeEventListener("keydown", typed, true); };
  }, [status.state]);
  const composer = useRef<HTMLElement | null>(null);
  /** Points the look at where the gaze says, only when that changes. */
  const lookNow = () => {
    const v = view.current;
    const doc = figure.current?.ownerDocument;
    if (!v?.lookAt || !doc || props.reducedMotion === true) return;
    const aim = gaze.current.aim(performance.now() / 1000);
    const cued = bridge.current?.lookAt ?? null;
    const rect = (aim === "composer" ? composer.current : figure.current)?.getBoundingClientRect();
    if (!rect) return;
    // The user typing wins; else a point the bot asked for (in the stage's own square, -1 to 1 from its centre); else ahead.
    const x = aim !== "composer" && cued ? rect.left + ((cued.x + 1) / 2) * rect.width : rect.left + rect.width / 2;
    const y = aim === "composer" ? rect.top + rect.height / 2 : cued ? rect.top + ((cued.y + 1) / 2) * rect.height : rect.top + rect.height * 0.35;
    const key = `${aim}:${Math.round(x)}:${Math.round(y)}`;
    if (key === aimed.current) return;
    aimed.current = key;
    v.lookAt(x, y);
  };

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
    bridge.current?.driver.update(dt);
    lookNow();
    reportBox();
    view.current.advance(dt);
    applyFrame();
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    let id = frames.requestFrame(function tick() {
      const now = frames.now();
      const fps = latest.current.maxFps ?? AVATAR_FPS;
      // The bot may ask for a pace (calm or lively); else the figure's own: calm with no one about for a while.
      const asked = bridge.current?.pace;
      const isCalm = !speaking.current() && (asked !== undefined ? asked : now - lastInput.current > CALM_AFTER_MS && bridge.current?.lookAt == null);
      if (isCalm !== calm.current) { calm.current = isCalm; if (figure.current) figure.current.dataset.pace = isCalm ? "calm" : "lively"; }
      // Typing alone (no pointer) holds a middle rate for the glance, then she settles; the stage stays calm throughout.
      const typingNow = isCalm && now - lastKey.current < TYPING_MS;
      const gap = 1000 / (speaking.current() ? fps.speaking : typingNow ? (fps.typing ?? AVATAR_FPS.typing) : isCalm ? (fps.calm ?? AVATAR_FPS.calm) : fps.quiet);
      if (now >= due - 4) {
        const dt = (now - last) / 1000;
        drawNow(dt, lipsync.current.sample(dt));
        last = now;
        due += gap;
        if (due <= now) due = now + gap;
      }
      // Calm: sleep between frames on a timer, so the page is not woken sixty times a second to do nothing.
      if (isCalm && !typingNow) timer = setTimeout(() => { id = frames.requestFrame(tick); }, Math.max(0, due - frames.now() - 16));
      else id = frames.requestFrame(tick);
    });
    return () => { frames.cancelFrame(id); if (timer) clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, frames]);

  return (
    <figure ref={figure} className="clvl-avatar" data-state={status.state} data-texture-notice={noticeRef.current || undefined} data-running={running || undefined} aria-label={name}>
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
