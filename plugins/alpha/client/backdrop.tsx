// Alpha's living scene: a part of her own layer that fills the whole tab behind everything (the layout stacks it first and
// the engine gives it no pointer events). It draws the scene her server says she is in (`stage.scene`: meadow, study,
// starry, rain, or one another plugin adds through her `alpha.scenes` point), tinted by her mood, with drifting particles, and a
// burst of confetti when she celebrates. It does not talk to her figure: her server does, through the public avatar calls.
//
// Frame budget: 12 frames a second while a turn runs or just after her stage changed, 2 otherwise, 30 only while confetti
// falls, none while hidden, one still frame with reduced motion.
import { useEffect, useRef } from "react";
import { useStageState, type Mood } from "./stage-store";

const TINT: Record<Mood, [number, number, number, number]> = {
  calm: [0, 0, 0, 0],
  focused: [70, 110, 210, 0.1],
  alert: [225, 80, 70, 0.13],
  joy: [255, 196, 90, 0.16],
  sad: [70, 92, 150, 0.2],
};

/** A scene's sky, for scenes that replace the theme's meadow; the meadow itself is the theme's. */
const SKY: Record<string, string> = {
  meadow: "transparent",
  study: "linear-gradient(180deg, #4a3526 0%, #2a1d16 70%, #1d130e 100%)",
  starry: "linear-gradient(180deg, #0c1033 0%, #1b1f55 60%, #2c2a63 100%)",
  rain: "linear-gradient(180deg, #5b6a7c 0%, #3d4a5c 70%, #2e3948 100%)",
};
export const DARK_SCENES = new Set(["study", "starry", "rain"]);

interface P { x: number; y: number; vx: number; vy: number; r: number; a: number; ph: number; hue: number }
interface Confetti { x: number; y: number; vx: number; vy: number; rot: number; vr: number; w: number; h: number; hue: number; life: number }

function seed(scene: string, w: number, h: number): P[] {
  const n = scene === "rain" ? 70 : scene === "starry" ? 50 : scene === "study" ? 24 : 18;
  return Array.from({ length: n }, () => ({
    x: Math.random() * w, y: Math.random() * h,
    vx: scene === "meadow" ? 8 + Math.random() * 14 : scene === "rain" ? -22 : (Math.random() - 0.5) * 6,
    vy: scene === "meadow" ? 6 + Math.random() * 10 : scene === "rain" ? 520 + Math.random() * 280 : scene === "study" ? -3 - Math.random() * 4 : 0,
    r: scene === "rain" ? 8 + Math.random() * 12 : scene === "starry" ? 0.6 + Math.random() * 1.6 : 1.5 + Math.random() * 3.5,
    a: 0.35 + Math.random() * 0.6, ph: Math.random() * 6.28, hue: 300 + Math.random() * 40,
  }));
}

function draw(c: CanvasRenderingContext2D, scene: string, mood: Mood, ps: P[], cf: Confetti[], t: number, dt: number, w: number, h: number): void {
  c.clearRect(0, 0, w, h);
  if (scene === "meadow") {
    const g = c.createRadialGradient(w * 0.86, h * 0.1, 0, w * 0.86, h * 0.1, Math.max(w, h) * 0.7);
    g.addColorStop(0, "rgba(255,238,190,0.45)"); g.addColorStop(1, "rgba(255,238,190,0)");
    c.fillStyle = g; c.fillRect(0, 0, w, h);
  } else if (scene === "study") {
    const g = c.createRadialGradient(w * 0.82, h * 0.18, 0, w * 0.82, h * 0.18, Math.max(w, h) * 0.65);
    g.addColorStop(0, `rgba(255,190,110,${0.5 + Math.sin(t * 1.3) * 0.04})`); g.addColorStop(1, "rgba(255,190,110,0)");
    c.fillStyle = g; c.fillRect(0, 0, w, h);
  } else if (scene === "rain") {
    c.strokeStyle = "rgba(210,225,245,0.35)"; c.lineWidth = 1;
  }
  for (const p of ps) {
    p.x += p.vx * dt; p.y += p.vy * dt;
    if (p.y > h + 20) { p.y = -20; p.x = Math.random() * w; }
    if (p.y < -20) p.y = h + 10;
    if (p.x > w + 20) p.x = -20;
    if (p.x < -20) p.x = w + 10;
    if (scene === "meadow") {
      c.fillStyle = `hsla(${p.hue}, 70%, 86%, ${p.a * 0.8})`;
      c.beginPath(); c.ellipse(p.x + Math.sin(t + p.ph) * 8, p.y, p.r * 1.5, p.r * 0.8, p.ph + t * 0.6, 0, 6.28); c.fill();
    } else if (scene === "study") {
      c.fillStyle = `rgba(255,214,160,${p.a * (0.35 + 0.35 * Math.sin(t * 0.8 + p.ph))})`;
      c.beginPath(); c.arc(p.x + Math.sin(t * 0.5 + p.ph) * 6, p.y, p.r * 0.7, 0, 6.28); c.fill();
    } else if (scene === "starry") {
      c.fillStyle = `rgba(255,255,240,${p.a * (0.45 + 0.55 * Math.sin(t * 1.6 + p.ph))})`;
      c.beginPath(); c.arc(p.x, p.y, p.r, 0, 6.28); c.fill();
    } else if (scene === "rain") {
      c.beginPath(); c.moveTo(p.x, p.y); c.lineTo(p.x + p.vx * 0.03, p.y - p.r); c.stroke();
    }
  }
  const [r, g, b, a] = TINT[mood];
  if (a > 0) { c.fillStyle = `rgba(${r},${g},${b},${a})`; c.fillRect(0, 0, w, h); }
  for (const k of cf) {
    k.life -= dt; k.x += k.vx * dt; k.y += k.vy * dt; k.vy += 360 * dt; k.rot += k.vr * dt; k.vx *= 0.995;
    c.save(); c.translate(k.x, k.y); c.rotate(k.rot);
    c.fillStyle = `hsla(${k.hue}, 85%, 62%, ${Math.min(1, k.life)})`; c.fillRect(-k.w / 2, -k.h / 2, k.w, k.h); c.restore();
  }
  for (let i = cf.length - 1; i >= 0; i--) if (cf[i]!.life <= 0 || cf[i]!.y > h + 30) cf.splice(i, 1);
}

function burst(w: number): Confetti[] {
  return Array.from({ length: 110 }, () => ({
    x: w * (0.52 + Math.random() * 0.45), y: -10 - Math.random() * 60, vx: (Math.random() - 0.5) * 260, vy: 60 + Math.random() * 200,
    rot: Math.random() * 6.28, vr: (Math.random() - 0.5) * 10, w: 6 + Math.random() * 7, h: 3 + Math.random() * 5, hue: Math.random() * 360, life: 3.2 + Math.random() * 1.2,
  }));
}

const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

export function AlphaScene({ props }: { props: { bot: { id: string; name: string } } }) {
  const stage = useStageState();
  const canvas = useRef<HTMLCanvasElement>(null);
  const live = useRef({ scene: stage.scene, mood: stage.mood, nonce: stage.nonce, celebrate: false, kick: () => {} });
  const mountedAt = useRef(Date.now());
  const celebrated = useRef(stage.celebrations);
  /** Nothing is happening on her stage: the scene draws a few frames a second. */
  const livelyUntil = useRef(0);
  const calm = useRef(true); // calm until a turn runs or her stage changes

  // The loop: frames while visible, at the rate the window's focus allows.
  useEffect(() => {
    const cv = canvas.current;
    const ctx = cv?.getContext("2d");
    if (!cv || !ctx) return;
    let ps: P[] = [];
    let sceneNow = "";
    const cf: Confetti[] = [];
    let w = 0, h = 0, raf = 0, last = 0, t = 0, running = false;
    let wake: ReturnType<typeof setTimeout> | undefined;
    const fit = () => {
      const dpr = 1; // soft particles and gradients: one pixel a pixel is plenty, and a quarter of the fill
      w = cv.clientWidth; h = cv.clientHeight;
      cv.width = Math.max(1, Math.round(w * dpr)); cv.height = Math.max(1, Math.round(h * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      sceneNow = ""; // reseeds
    };
    const frame = (now: number) => {
      raf = 0;
      if (document.hidden) { running = false; return; }
      // 15 frames a second while someone is about, 4 when the avatar part says no one is; a celebration is always lively.
      if (!calm.current && Date.now() > livelyUntil.current) { calm.current = true; document.documentElement.dataset.pace = "calm"; }
      const step = cf.length > 0 ? 1000 / 30 : calm.current ? 500 : 1000 / 12;
      if (now - last >= step - 1) {
        const dt = Math.min(0.1, last === 0 ? 0.016 : (now - last) / 1000);
        last = now; t += dt;
        const s = live.current;
        if (sceneNow !== s.scene) { sceneNow = s.scene; ps = seed(s.scene === "meadow" || s.scene in SKY ? s.scene : "meadow", w, h); }
        if (s.celebrate) { s.celebrate = false; if (!reduced()) cf.push(...burst(w)); }
        draw(ctx, sceneNow in SKY ? sceneNow : "meadow", s.mood, ps, cf, t, reduced() ? 0 : dt, w, h);
      }
      if (reduced() && cf.length === 0) { running = false; return; }
      // Calm: wait on a timer between frames rather than waking every display refresh.
      if (calm.current && cf.length === 0) { wake = setTimeout(() => { wake = undefined; raf = requestAnimationFrame(frame); }, step - 20); }
      else raf = requestAnimationFrame(frame);
    };
    const start = () => { if (!running && !document.hidden) { running = true; last = 0; raf = requestAnimationFrame(frame); } };
    live.current.kick = start;
    fit();
    const ro = new ResizeObserver(() => { fit(); last = 0; start(); });
    ro.observe(cv);
    const vis = () => { if (!document.hidden) start(); };
    document.addEventListener("visibilitychange", vis);
    start();
    return () => { if (raf) cancelAnimationFrame(raf); if (wake) clearTimeout(wake); ro.disconnect(); document.removeEventListener("visibilitychange", vis); running = false; };
  }, []);

  useEffect(() => {
    const s = live.current;
    s.scene = stage.scene; s.mood = stage.mood;
    // One burst each time she starts celebrating (not for each write while she still is).
    // One burst each time her stage's celebration counter goes up (a counter read at load is history, not a party).
    if (Date.now() - mountedAt.current > 1500 && stage.celebrations > celebrated.current) s.celebrate = true;
    celebrated.current = stage.celebrations;
    s.kick();
  }, [stage.scene, stage.mood, stage.celebrations]);

  // Pace without a word from the figure: the scene is lively while a turn runs and for a few seconds after her stage
  // changes (a cue, a celebration, a new scene), then it settles to a few frames a second.
  const working = stage.activity?.kind === "thinking" || stage.activity?.kind === "tool";
  const paceKey = `${working}|${stage.nonce}|${stage.celebrations}|${stage.scene}|${stage.mood}`;
  useEffect(() => {
    if (Date.now() - mountedAt.current < 1500) return;
    livelyUntil.current = Date.now() + (working ? 60000 : 10000);
    calm.current = false;
    document.documentElement.dataset.pace = "lively";
    live.current.kick();
  }, [paceKey]);

  return (
    <div className="as" data-scene={stage.scene} data-mood={stage.mood} style={{ background: SKY[stage.scene] ?? "transparent" }}>
      <canvas ref={canvas} className="as__canvas" aria-hidden="true" />
      <style>{`html, body { background: transparent !important; margin: 0; height: 100%; overflow: hidden; } .as, .as__canvas { position: fixed; inset: 0; width: 100%; height: 100%; display: block; } .as { transition: background 0.8s ease; }`}</style>
    </div>
  );
}
