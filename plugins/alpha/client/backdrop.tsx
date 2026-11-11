// Alpha's living scene: a part of her own layer that fills the whole tab behind everything (the layout stacks it first and
// the engine gives it no pointer events). It draws the scene her server says she is in (`stage.scene`), tinted by her
// mood, and a burst of confetti when she celebrates:
// * the meadow ("Her room": the night meadow in the dark, the day meadow in the light), also for a scene another plugin
//   adds through her `alpha.scenes` point: a still layer and a few sprites that only move (meadow-art.ts, meadow-layer.ts);
// * study, starry and rain: their own sky and drifting particles on the canvas, as before.
// It is also her figure's bridge: the avatar part in the shell's document and this part trade messages (the avatar sends
// the names of the model it loaded, this part hands them to her server, and each new expression or motion in the stage
// document goes back as a cue), each side checking who sent it.
//
// Frame budget: 12 frames a second while someone is about, 2 once the avatar part says no one is (no input for a while) or
// with her "Stage effects" setting at subtle, 30 only while confetti falls, none while hidden or unsized, one still frame
// with reduced motion or her stage effects off (and no confetti then). A frame moves the meadow's sprites (a transform and
// an opacity each) and draws the canvas only when it has something on it; nothing animates on its own.
import { useEffect, useRef, useState } from "react";
import { usePluginApi } from "@waifucave/clover-plugin-sdk/ui";
import { useStageState, type Mood } from "./stage-store";
import { heardFromShell, shellOriginOf } from "./stage-doc";
import { drawsMeadow } from "./meadow-art";
import { MeadowLayer } from "./meadow-layer";

const TINT: Record<Mood, [number, number, number, number]> = {
  calm: [0, 0, 0, 0],
  focused: [70, 110, 210, 0.1],
  alert: [225, 80, 70, 0.13],
  joy: [255, 196, 90, 0.16],
  sad: [70, 92, 150, 0.2],
};

/** The sky of her scenes that aren't the meadow (the meadow draws its own: meadow-art.ts). */
const SKY: Record<string, string> = {
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

/** One frame of the canvas: a scene's particles (none for the meadow, whose sprites move themselves), then confetti. */
function draw(c: CanvasRenderingContext2D, scene: string, ps: P[], cf: Confetti[], t: number, dt: number, w: number, h: number): void {
  c.clearRect(0, 0, w, h);
  if (scene === "study") {
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
    if (scene === "study") {
      c.fillStyle = `rgba(255,214,160,${p.a * (0.35 + 0.35 * Math.sin(t * 0.8 + p.ph))})`;
      c.beginPath(); c.arc(p.x + Math.sin(t * 0.5 + p.ph) * 6, p.y, p.r * 0.7, 0, 6.28); c.fill();
    } else if (scene === "starry") {
      c.fillStyle = `rgba(255,255,240,${p.a * (0.45 + 0.55 * Math.sin(t * 1.6 + p.ph))})`;
      c.beginPath(); c.arc(p.x, p.y, p.r, 0, 6.28); c.fill();
    } else if (scene === "rain") {
      c.beginPath(); c.moveTo(p.x, p.y); c.lineTo(p.x + p.vx * 0.03, p.y - p.r); c.stroke();
    }
  }
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
const darkNow = () => typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;

/** Her "Stage effects" setting: off (still, no confetti), subtle (the calm pace always), full. */
type Effects = "off" | "subtle" | "full";

export function AlphaScene({ props }: { props: { bot: { id: string; name: string } } }) {
  const api = usePluginApi();
  const stage = useStageState();
  const canvas = useRef<HTMLCanvasElement>(null);
  const meadowHost = useRef<HTMLDivElement>(null);
  const [dark, setDark] = useState(darkNow);
  const live = useRef({ scene: stage.scene, mood: stage.mood, nonce: stage.nonce, celebrate: false, dark, effects: "full" as Effects, kick: () => {} });
  const mountedAt = useRef(Date.now());
  const celebrated = useRef(stage.celebrations);
  /** No one is about (the avatar part says so): the scene draws a few frames a second. */
  const livelyUntil = useRef(0);
  const calm = useRef(true); // calm until the avatar part says someone is about (with no avatar it stays calm)
  const botId = props.bot.id;

  // The loop: frames while visible, at the rate the window's focus allows.
  useEffect(() => {
    const cv = canvas.current;
    const ctx = cv?.getContext("2d");
    const host = meadowHost.current;
    if (!cv || !ctx || !host) return;
    const meadow = new MeadowLayer(host);
    let ps: P[] = [];
    let sceneNow = "";
    const cf: Confetti[] = [];
    let w = 0, h = 0, raf = 0, last = 0, t = 0, running = false, painted = false;
    let wake: ReturnType<typeof setTimeout> | undefined;
    let settle: ReturnType<typeof setTimeout> | undefined;
    const fit = () => {
      const dpr = 1; // soft particles and gradients: one pixel a pixel is plenty, and a quarter of the fill
      w = cv.clientWidth; h = cv.clientHeight;
      cv.width = Math.max(1, Math.round(w * dpr)); cv.height = Math.max(1, Math.round(h * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      sceneNow = ""; // reseeds
      painted = true; // a resized canvas is blank; the next frame clears what it must
    };
    const frame = (now: number) => {
      raf = 0;
      if (document.hidden || w === 0 || h === 0) { running = false; return; }
      // 12 frames a second while someone is about, 2 when the avatar part says no one is; a celebration is always lively.
      if (!calm.current && Date.now() > livelyUntil.current) { calm.current = true; document.documentElement.dataset.pace = "calm"; }
      const s = live.current;
      const still = reduced() || s.effects === "off";
      const slow = calm.current || s.effects === "subtle";
      const step = cf.length > 0 ? 1000 / 30 : slow ? 500 : 1000 / 12;
      // A (re)started loop draws at once: a still frame must not wait out a step it then never takes.
      if (last === 0 || now - last >= step - 1) {
        const dt = Math.min(0.1, last === 0 ? 0.016 : (now - last) / 1000);
        last = now;
        if (!still) t += dt;
        if (s.celebrate) { s.celebrate = false; if (!still) cf.push(...burst(w)); }
        if (drawsMeadow(s.scene)) {
          if (sceneNow !== "meadow") { sceneNow = "meadow"; ps = []; }
          meadow.draw(w, h, s.dark);
          meadow.move(t, slow);
          // The canvas only for confetti; cleared once after the last piece.
          if (cf.length > 0 || painted) { draw(ctx, "meadow", ps, cf, t, still ? 0 : dt, w, h); painted = cf.length > 0; }
        } else {
          meadow.clear();
          if (sceneNow !== s.scene) { sceneNow = s.scene; ps = seed(s.scene in SKY ? s.scene : "starry", w, h); }
          draw(ctx, sceneNow, ps, cf, t, still ? 0 : dt, w, h);
          painted = true;
        }
      }
      if (still && cf.length === 0) { running = false; return; }
      // Calm: wait on a timer between frames rather than waking every display refresh.
      if (slow && cf.length === 0) { wake = setTimeout(() => { wake = undefined; raf = requestAnimationFrame(frame); }, step - 20); }
      else raf = requestAnimationFrame(frame);
    };
    const start = () => { if (!running && !document.hidden) { running = true; last = 0; raf = requestAnimationFrame(frame); } };
    live.current.kick = start;
    fit();
    // A resize redraws once it settles, not at each step of a drag.
    const ro = new ResizeObserver(() => { if (settle) clearTimeout(settle); settle = setTimeout(() => { settle = undefined; fit(); last = 0; start(); }, 120); });
    ro.observe(cv);
    const vis = () => { if (!document.hidden) start(); };
    document.addEventListener("visibilitychange", vis);
    start();
    return () => { if (raf) cancelAnimationFrame(raf); if (wake) clearTimeout(wake); if (settle) clearTimeout(settle); ro.disconnect(); document.removeEventListener("visibilitychange", vis); running = false; meadow.clear(); };
  }, []);

  // The scheme: the night meadow in the dark, the day meadow in the light.
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const q = matchMedia("(prefers-color-scheme: dark)");
    const on = () => setDark(q.matches);
    q.addEventListener("change", on);
    return () => q.removeEventListener("change", on);
  }, []);
  useEffect(() => { live.current.dark = dark; live.current.kick(); }, [dark]);

  // Her "Stage effects" setting, read and followed while the scene shows.
  useEffect(() => {
    if (!("settings" in api)) return;
    let on = true;
    const read = () => void api.settings.get("effects").then((v: unknown) => {
      if (!on) return;
      live.current.effects = v === "off" || v === "subtle" ? v : "full";
      live.current.kick();
    }, () => undefined);
    read();
    const stop = api.settings.watch("effects", read);
    return () => { on = false; stop(); };
  }, [api]);

  useEffect(() => {
    const s = live.current;
    s.scene = stage.scene; s.mood = stage.mood;
    // One burst each time she starts celebrating (not for each write while she still is).
    // One burst each time her stage's celebration counter goes up (a counter read at load is history, not a party).
    if (Date.now() - mountedAt.current > 1500 && stage.celebrations > celebrated.current) s.celebrate = true;
    celebrated.current = stage.celebrations;
    s.kick();
  }, [stage.scene, stage.mood, stage.celebrations]);

  // The figure's bridge. The avatar sends the names of the model it loaded; only the shell document (our parent) is
  // heard, and her server checks the names before keeping them. Each new expression, motion or outfit goes up as a cue.
  useEffect(() => {
    const shell = shellOriginOf(window.location.ancestorOrigins);
    const on = (e: MessageEvent) => {
      if (!heardFromShell(e, window.parent, shell)) return;
      const d = e.data as { type?: unknown; v?: unknown; calm?: unknown; expressions?: unknown; motions?: unknown; outfit?: unknown } | null;
      if (d?.type === "clover.avatar.pace" && d.v === 1) { calm.current = d.calm === true; livelyUntil.current = calm.current ? 0 : Date.now() + 10000; document.documentElement.dataset.pace = calm.current ? "calm" : "lively"; if (!calm.current) live.current.kick(); return; }
      if (d?.type !== "clover.avatar.catalog" || d.v !== 1) return;
      void api.host.call("setCatalog", { v: 1, expressions: d.expressions, motions: d.motions, outfit: d.outfit }).catch(() => undefined);
    };
    window.addEventListener("message", on);
    if (shell !== undefined) window.parent.postMessage({ type: "clover.avatar.hello", bot: botId }, shell);
    return () => window.removeEventListener("message", on);
  }, [api, botId]);
  const working = stage.activity?.kind === "thinking" || stage.activity?.kind === "tool";
  const cueKey = `${working}|${stage.celebrations}|${stage.nonce}|${stage.expression ?? ""}|${stage.motion ?? ""}|${JSON.stringify(stage.outfit)}`;
  const cueCelebrations = useRef(stage.celebrations);
  useEffect(() => {
    const shell = shellOriginOf(window.location.ancestorOrigins);
    if (shell === undefined) return;
    window.parent.postMessage({ type: "clover.avatar.cue", bot: botId, nonce: stage.nonce, expression: stage.expression, motion: stage.motion, outfit: stage.outfit, celebrate: Date.now() - mountedAt.current > 1500 && stage.celebrations > cueCelebrations.current, working }, shell);
    cueCelebrations.current = stage.celebrations;
  }, [cueKey, botId]);

  const [r, g, b, a] = TINT[stage.mood];
  return (
    <div className="as" data-scene={stage.scene} data-mood={stage.mood} data-art={drawsMeadow(stage.scene) ? (dark ? "night-meadow" : "day-meadow") : stage.scene} style={{ background: drawsMeadow(stage.scene) ? "transparent" : SKY[stage.scene] }}>
      <div ref={meadowHost} className="as__meadow" aria-hidden="true" />
      <div className="as__tint" aria-hidden="true" style={{ background: `rgba(${r},${g},${b},${a})`, opacity: a > 0 ? 1 : 0 }} />
      <canvas ref={canvas} className="as__canvas" aria-hidden="true" />
      <style>{`html, body { background: transparent !important; margin: 0; height: 100%; overflow: hidden; } .as, .as__meadow, .as__tint, .as__canvas { position: fixed; inset: 0; width: 100%; height: 100%; display: block; pointer-events: none; } .as__meadow { overflow: hidden; contain: strict; } .as, .as__tint { transition: background 0.8s ease, opacity 0.8s ease; }`}</style>
    </div>
  );
}
