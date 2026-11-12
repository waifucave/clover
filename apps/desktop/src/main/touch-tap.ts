// The four-finger tap (the old app's gesture that puts the Dispatch pill away and brings it back), ported from
// apple/Winter/Sources/Gesture/TapRecognizer.swift and MultitouchTrigger.swift. The recognizer is pure: it is fed one frame of
// the trackpad's touching fingers at a time and says when a tap has happened, so it is tested on recorded frames. The touches
// themselves come from the macOS add-on (native/input/macos/touches.mm), which reads the trackpad and nothing else.
import { createRequire } from "node:module";

export interface TapConfig {
  /** Seconds a tap lasts, at least and at most (a longer touch is a rest, not a tap). */
  minDuration: number;
  maxDuration: number;
  /** The farthest any one finger may drift, in the trackpad's normalised units (0 to 1 across), and the centroid. */
  maxFingerTravel: number;
  maxCentroidTravel: number;
  /** Frames with exactly four fingers a tap needs: a palm brushing down and up inside one report is never a tap. */
  minFourFingerSamples: number;
}

export const TAP_V1: TapConfig = { minDuration: 0.025, maxDuration: 0.18, maxFingerTravel: 0.018, maxCentroidTravel: 0.012, minFourFingerSamples: 2 };

export interface TouchSample {
  id: number;
  x: number;
  y: number;
}

const dist = (a: { x: number; y: number }, b: { x: number; y: number }): number => Math.hypot(a.x - b.x, a.y - b.y);
const centroid = (ps: readonly { x: number; y: number }[]): { x: number; y: number } => ({ x: ps.reduce((s, p) => s + p.x, 0) / ps.length, y: ps.reduce((s, p) => s + p.y, 0) / ps.length });

export class TapRecognizer {
  private touchingSince = 0;
  private armed = false;
  private invalidated = false;
  private samples = 0;
  private maxFinger = 0;
  private maxCentroid = 0;
  private anchorCentroid = { x: 0, y: 0 };
  private anchors = new Map<number, { x: number; y: number }>();

  constructor(private readonly config: TapConfig = TAP_V1) {}

  /** One frame of the fingers touching now (empty when none is). True exactly when the tap fires, on the lift. */
  ingest(active: readonly TouchSample[], time: number): boolean {
    if (active.length === 0) {
      let fired = false;
      if (this.armed && !this.invalidated) {
        const duration = time - this.touchingSince;
        const tapDuration = duration >= this.config.minDuration && duration < this.config.maxDuration;
        const still = this.maxFinger <= this.config.maxFingerTravel && this.maxCentroid <= this.config.maxCentroidTravel;
        fired = tapDuration && still && this.samples >= this.config.minFourFingerSamples;
      }
      this.reset(); // always on all-lift, so a latched state can never carry into the next touch
      return fired;
    }
    if (active.length > 4) this.invalidated = true;
    if (!this.armed) {
      if (active.length !== 4) return false; // the first touching frame must be exactly four
      this.armed = true;
      this.touchingSince = time;
      this.samples = 1;
      this.anchors = new Map(active.map((t) => [t.id, { x: t.x, y: t.y }]));
      if (this.anchors.size !== 4) { this.invalidated = true; return false; }
      this.anchorCentroid = centroid(active);
      return false;
    }
    if (active.length !== 4) return false;
    const current = new Map(active.map((t) => [t.id, { x: t.x, y: t.y }]));
    if (current.size !== 4 || [...current.keys()].some((id) => !this.anchors.has(id))) { this.invalidated = true; return false; }
    this.samples += 1;
    this.maxCentroid = Math.max(this.maxCentroid, dist(this.anchorCentroid, centroid(active)));
    for (const [id, pos] of current) this.maxFinger = Math.max(this.maxFinger, dist(this.anchors.get(id)!, pos));
    if (this.maxFinger > this.config.maxFingerTravel || this.maxCentroid > this.config.maxCentroidTravel) this.invalidated = true;
    return false;
  }

  private reset(): void {
    this.armed = false;
    this.invalidated = false;
    this.samples = 0;
    this.maxFinger = 0;
    this.maxCentroid = 0;
    this.anchors.clear();
    this.anchorCentroid = { x: 0, y: 0 };
  }
}

/** The add-on's three calls. */
export interface TouchAddon {
  start(onFrame: (time: number, flat: number[]) => void): boolean;
  reattach(): boolean;
  stop(): void;
}

/** The add-on, if this OS has one and it was built; undefined otherwise (and the app does without the gesture). Loading it
 *  opens nothing: the trackpad is read only once `start` is called. */
export function loadTouches(path: string, log: (line: string) => void, platform: NodeJS.Platform = process.platform): TouchAddon | undefined {
  if (platform !== "darwin") return undefined;
  try {
    const m = createRequire(import.meta.url)(path) as Partial<TouchAddon>;
    return typeof m.start === "function" && typeof m.reattach === "function" && typeof m.stop === "function" ? (m as TouchAddon) : undefined;
  } catch (err) {
    log(`touches: no add-on (${err instanceof Error ? err.message.split("\n")[0] : String(err)}); no four-finger tap`);
    return undefined;
  }
}

/** The add-on's flat `[id, x, y, …]` list as touch samples. */
export function samplesOf(flat: readonly number[]): TouchSample[] {
  const out: TouchSample[] = [];
  for (let i = 0; i + 2 < flat.length; i += 3) out.push({ id: flat[i]!, x: flat[i + 1]!, y: flat[i + 2]! });
  return out;
}

/** The gesture, running: frames from the add-on into a recognizer, one call of `onTap` per tap. */
export class FourFingerTap {
  private readonly recognizer = new TapRecognizer();
  private running = false;
  constructor(private readonly addon: TouchAddon, private readonly onTap: () => void, private readonly log: (line: string) => void) {}

  start(): boolean {
    if (this.running) return true;
    this.running = true;
    const ok = this.addon.start((time, flat) => {
      if (this.recognizer.ingest(samplesOf(flat), time)) this.onTap();
    });
    this.log(`touches: four-finger tap ${ok ? "listening" : "found no trackpad"}`);
    return ok;
  }

  /** After a wake or a trackpad reconnecting: the framework stops sending frames and is registered again. */
  reattach(): void {
    if (this.running) this.addon.reattach();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.addon.stop();
  }
}
