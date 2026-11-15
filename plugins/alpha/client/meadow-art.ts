// Alpha's meadow, drawn: the art of her "Her room" scene (the night meadow in the dark, the day meadow in the light),
// as markup her backdrop and her foreground put in their documents. Pure and deterministic (a seeded random), so her
// tab's suite tests it and a render of the scene is exactly what the app draws. No React here.
//
// The backdrop is two things:
// * a STILL layer, drawn once per size and scheme: the sky, the moon (or sun) with its rays, the distant hills, the
//   meadow with its clovers, most stars and fireflies;
// * a few SPRITES on top, each its own small element that only ever changes transform and opacity (`spriteFrame`): the
//   moon's soft light breathing, some stars twinkling, some fireflies glowing, the petals drifting. The still layer is
//   never repainted by them.
// The foreground (`grassMarkup`) is the grass and clovers in front of the figure, along the bottom of its own frame, so
// she stands in the meadow wherever the figure is cut off. It never moves.

export interface Palette {
  sky: [string, string, string, string];
  /** The moon's (or sun's) light: centre, edge, and how strong. */
  halo: [string, number, string, number];
  orb: string;
  ray: [string, number];
  hills: [[string, string], [string, string], [string, string]];
  midClover: string;
  firefly: string;
  petal: string;
  grass: [string, string, string];
  clover: string;
}

const NIGHT: Palette = {
  sky: ["#0a1030", "#1a2259", "#3a3a78", "#5b4c86"],
  halo: ["#fff4d8", 0.55, "#b9c4ff", 0.16],
  orb: "#f4ecd2",
  ray: ["#e9e3ff", 0.22],
  hills: [["#2b4f6a", "#1d3a4e"], ["#235648", "#173e37"], ["#2f7457", "#163f35"]],
  midClover: "#3f9a74",
  firefly: "#ffe9a6",
  petal: "#f3b9cf",
  grass: ["#215a47", "#2c7458", "#3b8b69"],
  clover: "#5fd29a",
};

const DAY: Palette = {
  sky: ["#9fcbf0", "#cfe4f6", "#f6ecf0", "#fde9e2"],
  halo: ["#fffbe8", 1, "#fff4d0", 0.45],
  orb: "#fffdf3",
  ray: ["#fffbe6", 0.55],
  hills: [["#b9dcc0", "#9fceaa"], ["#8fcc95", "#6fb57f"], ["#6dbb7e", "#4e9d66"]],
  midClover: "#4aa86e",
  firefly: "#ffffff",
  petal: "#f5a9c2",
  grass: ["#4f9f68", "#62b47a", "#7cc78e"],
  clover: "#3ea86c",
};

export const palette = (dark: boolean): Palette => (dark ? NIGHT : DAY);

/** The scenes the meadow art draws: hers, and any scene another plugin adds (they stand in the meadow too). Her other
 *  scenes keep their own art (backdrop.tsx). */
export const OTHER_ART = new Set(["study", "starry", "rain"]);
export const drawsMeadow = (scene: string): boolean => !OTHER_ART.has(scene);

/** At most this many sprites, whatever the size. */
export const SPRITES_MAX = 40;

/** A seeded random in [0, 1) (Park–Miller), so the same size and scheme draw the same scene. */
export function seeded(seed: number): () => number {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

const f = (n: number) => (Math.round(n * 10) / 10).toString();
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Where the moon (or sun) is: above the middle of a wide window, above the stage's side of a narrow one. */
export function orbOf(w: number, h: number): { x: number; y: number; r: number } {
  const x = w >= 1100 ? w * 0.515 : w * 0.8;
  const y = clamp(h * 0.115, 80, 170);
  const r = Math.round(clamp(74 * Math.sqrt(Math.min(w / 2000, h / 1300)), 44, 74));
  return { x, y, r };
}

/** The clover: four heart leaves round a point, 40 units across. */
const CLOVER = `<symbol id="am-clover" viewBox="-20 -20 40 40"><g id="am-leaf"><path d="M0 0C-7-4-10-12-5-15.5C-2-17.5 0-15 0-12.5C0-15 2-17.5 5-15.5C10-12 7-4 0 0Z"/></g><use href="#am-leaf" transform="rotate(90)"/><use href="#am-leaf" transform="rotate(180)"/><use href="#am-leaf" transform="rotate(270)"/></symbol>`;

const clover = (x: number, y: number, s: number, rot: number, fill: string, opacity: number) =>
  `<use href="#am-clover" x="-20" y="-20" width="40" height="40" transform="translate(${f(x)} ${f(y)}) scale(${f(s * 100) === "0" ? "0" : (Math.round(s * 100) / 100).toString()}) rotate(${f(rot)})" fill="${fill}" opacity="${opacity}"/>`;

/** The still layer of the backdrop, `w` by `h` CSS pixels: one SVG. */
export function backdropSvg(w: number, h: number, dark: boolean): string {
  const p = palette(dark);
  const rnd = seeded(7);
  const sx = w / 2000, sy = h / 1300;
  const orb = orbOf(w, h);
  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true" style="position:absolute;inset:0;display:block">`);
  out.push(`<defs>${CLOVER}`);
  out.push(`<linearGradient id="am-sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${p.sky[0]}"/><stop offset=".45" stop-color="${p.sky[1]}"/><stop offset=".78" stop-color="${p.sky[2]}"/><stop offset="1" stop-color="${p.sky[3]}"/></linearGradient>`);
  out.push(`<radialGradient id="am-pool" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="${p.halo[0]}" stop-opacity="${p.halo[1]}"/><stop offset=".35" stop-color="${p.halo[2]}" stop-opacity="${p.halo[3]}"/><stop offset="1" stop-color="${p.halo[2]}" stop-opacity="0"/></radialGradient>`);
  out.push(`<linearGradient id="am-ray" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${p.ray[0]}" stop-opacity="${p.ray[1]}"/><stop offset="1" stop-color="${p.ray[0]}" stop-opacity="0"/></linearGradient>`);
  p.hills.forEach(([a, b], i) => out.push(`<linearGradient id="am-hill${i}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient>`));
  out.push(`<filter id="am-blur8" x="-20%" y="-5%" width="140%" height="110%"><feGaussianBlur stdDeviation="8"/></filter><filter id="am-soft"><feGaussianBlur stdDeviation="2"/></filter></defs>`);
  out.push(`<rect width="${w}" height="${h}" fill="url(#am-sky)"/>`);
  // Stars, fading toward the hills (the night only).
  if (dark) {
    const n = Math.round(clamp(140 * (w * h) / (2000 * 1300), 40, 180));
    const top = h * 0.585;
    for (let i = 0; i < n; i++) {
      const x = rnd() * w, y = rnd() * top, big = rnd() < 0.12, o = (0.25 + rnd() * 0.6) * (1 - y / (h * 0.69));
      out.push(`<circle cx="${f(x)}" cy="${f(y)}" r="${big ? 1.6 : 0.9}" fill="#fff" opacity="${f(Math.max(0.05, o))}"/>`);
    }
  }
  // The light's rays, down to the meadow.
  out.push(`<g opacity=".55">`);
  for (const [a, spread] of [[-40, 90], [-28, 60], [-16, 110], [-4, 70], [10, 50]] as const) {
    const at = (deg: number) => orb.x + Math.tan((deg * Math.PI) / 180) * (h - orb.y);
    out.push(`<path d="M${f(orb.x)} ${f(orb.y)} L${f(at(a - spread / 14))} ${h} L${f(at(a + spread / 14))} ${h}Z" fill="url(#am-ray)" filter="url(#am-blur8)"/>`);
  }
  out.push(`</g>`);
  // A soft pool of the light where she stands (left of the middle in a wide window).
  out.push(`<circle cx="${f(700 * sx)}" cy="${f(470 * sy)}" r="${f(420 * Math.max(sx, sy))}" fill="url(#am-pool)" opacity=".4"/>`);
  out.push(`<circle cx="${f(orb.x)}" cy="${f(orb.y)}" r="${orb.r}" fill="${p.orb}"/>`);
  if (dark) {
    const k = orb.r / 74;
    for (const [dx, dy, r] of [[-22, -22, 13], [22, 15, 9], [0, 38, 6], [30, -22, 5]] as const) out.push(`<circle cx="${f(orb.x + dx * k)}" cy="${f(orb.y + dy * k)}" r="${f(r * k)}" fill="#d9d0b2" opacity=".35"/>`);
  }
  // The hills, stretched to the window (their own space is the mockup's 2000 by 1300).
  out.push(`<svg x="0" y="0" width="${w}" height="${h}" viewBox="0 0 2000 1300" preserveAspectRatio="none">`);
  out.push(`<path d="M0 880 C 260 820 520 840 760 875 S 1260 900 1500 860 S 1850 830 2000 850 V1300 H0Z" fill="url(#am-hill0)"/>`);
  out.push(`<path d="M0 990 C 300 930 600 960 900 990 S 1500 1010 2000 960 V1300 H0Z" fill="url(#am-hill1)"/>`);
  out.push(`</svg>`);
  // Clovers on the second hill.
  const mids = Math.round(clamp(46 * (w / 2000), 14, 60));
  for (let i = 0; i < mids; i++) {
    const x = rnd() * w, y = (990 + rnd() * 120) * sy, s = 0.35 + rnd() * 0.5;
    out.push(clover(x, y, s, rnd() * 90, p.midClover, 0.75));
  }
  out.push(`<svg x="0" y="0" width="${w}" height="${h}" viewBox="0 0 2000 1300" preserveAspectRatio="none"><path d="M0 1110 C 400 1070 800 1090 1150 1120 S 1700 1130 2000 1100 V1300 H0Z" fill="url(#am-hill2)"/></svg>`);
  // Still fireflies (the night) or glints (the day) over the meadow.
  const flies = Math.round(clamp(18 * (w / 2000), 8, 24));
  for (let i = 0; i < flies; i++) {
    const x = rnd() * w, y = (700 + rnd() * 520) * sy;
    out.push(`<circle cx="${f(x)}" cy="${f(y)}" r="${f(2 + rnd() * 2.2)}" fill="${p.firefly}" opacity="${dark ? 0.85 : 0.7}" filter="url(#am-soft)"/>`);
  }
  out.push(`</svg>`);
  return out.join("");
}

/** One moving thing: where it rests, and how it moves (`spriteFrame`). */
export interface Sprite {
  kind: "glow" | "twinkle" | "firefly" | "petal";
  x: number;
  y: number;
  /** Its own size: the glow's diameter, a dot's or a petal's width. */
  size: number;
  /** A petal's height. */
  size2?: number;
  /** Phase and speed of its own rhythm. */
  ph: number;
  sp: number;
  /** A petal's drift, CSS pixels a second, and its turn. */
  vx?: number;
  vy?: number;
  rot?: number;
  color: string;
  /** Its strongest opacity. */
  o: number;
}

/** The sprites of a `w` by `h` backdrop: the light's breathing glow, the night's twinkling stars, some glowing
 *  fireflies (glints by day), and the drifting petals. At most SPRITES_MAX. */
export function spritesOf(w: number, h: number, dark: boolean): Sprite[] {
  const p = palette(dark);
  const rnd = seeded(11);
  const orb = orbOf(w, h);
  const out: Sprite[] = [];
  const glow = Math.round(orb.r * 8);
  out.push({ kind: "glow", x: orb.x, y: orb.y, size: glow, ph: 0, sp: 0.5, color: p.halo[0], o: 1 });
  if (dark) {
    const n = Math.round(clamp(12 * Math.sqrt((w * h) / (2000 * 1300)), 6, 12));
    for (let i = 0; i < n; i++) out.push({ kind: "twinkle", x: rnd() * w, y: rnd() * h * 0.45, size: 2.4 + rnd() * 1.4, ph: rnd() * 6.28, sp: 0.8 + rnd() * 1.4, color: "#ffffff", o: 0.95 });
  }
  const flies = Math.round(clamp(8 * Math.sqrt(w / 2000), 4, 8));
  for (let i = 0; i < flies; i++) out.push({ kind: "firefly", x: rnd() * w, y: (720 + rnd() * 480) * (h / 1300), size: 7 + rnd() * 4, ph: rnd() * 6.28, sp: 0.5 + rnd() * 0.7, color: p.firefly, o: dark ? 0.9 : 0.75 });
  const petals = Math.round(clamp(16 * Math.sqrt((w * h) / (2000 * 1300)), 8, 16));
  for (let i = 0; i < petals; i++) {
    out.push({
      kind: "petal", x: rnd() * w, y: rnd() * h * 0.88, size: 10 + rnd() * 8, size2: 5.2 + rnd() * 3.2, ph: rnd() * 6.28, sp: 0.6 + rnd() * 0.6,
      vx: 7 + rnd() * 12, vy: 5 + rnd() * 9, rot: rnd() * 180, color: p.petal, o: 0.55 + rnd() * 0.35,
    });
  }
  return out.slice(0, SPRITES_MAX);
}

/** The sprites' elements, at rest. Each is positioned by its transform alone (`spriteFrame`), so moving it never lays
 *  anything out or repaints the still layer. */
export function spritesHtml(sprites: readonly Sprite[]): string {
  return sprites.map((s) => {
    const fr = spriteFrame(s, 0, 0, 0);
    const base = `position:absolute;left:0;top:0;pointer-events:none;will-change:transform,opacity;transform:${fr.transform};opacity:${fr.opacity};`;
    switch (s.kind) {
      case "glow":
        return `<i data-sprite="glow" style="${base}width:${s.size}px;height:${s.size}px;border-radius:50%;background:radial-gradient(circle, ${hexA(s.color, 0.42)} 0%, ${hexA(s.color, 0.12)} 30%, ${hexA(s.color, 0)} 70%)"></i>`;
      case "twinkle":
        return `<i data-sprite="twinkle" style="${base}width:${f(s.size)}px;height:${f(s.size)}px;border-radius:50%;background:${s.color};box-shadow:0 0 ${f(s.size * 2.5)}px ${f(s.size * 0.6)}px ${hexA(s.color, 0.55)}"></i>`;
      case "firefly":
        return `<i data-sprite="firefly" style="${base}width:${f(s.size)}px;height:${f(s.size)}px;border-radius:50%;background:radial-gradient(circle, ${s.color} 0%, ${hexA(s.color, 0.55)} 35%, ${hexA(s.color, 0)} 70%)"></i>`;
      case "petal":
        return `<i data-sprite="petal" style="${base}width:${f(s.size)}px;height:${f(s.size2 ?? s.size / 2)}px;border-radius:50%;background:${s.color}"></i>`;
    }
  }).join("");
}

/** A sprite at time `t` (seconds of the scene's own clock) in a `w` by `h` backdrop: only a transform and an opacity.
 *  At t = 0 it rests where `spritesOf` put it. `w` and `h` 0: no drift (a still frame). */
export function spriteFrame(s: Sprite, t: number, w: number, h: number): { transform: string; opacity: string } {
  const centre = (x: number, y: number) => `translate3d(${f(x - s.size / 2)}px, ${f(y - (s.size2 ?? s.size) / 2)}px, 0)`;
  switch (s.kind) {
    case "glow":
      return { transform: centre(s.x, s.y), opacity: f(s.o * (0.86 + 0.14 * Math.sin(t * s.sp))) };
    case "twinkle":
      return { transform: centre(s.x, s.y), opacity: f(s.o * (0.6 + 0.4 * Math.sin(t * s.sp + s.ph))) };
    case "firefly":
      return { transform: centre(s.x + 6 * Math.sin(t * 0.4 + s.ph), s.y + 4 * Math.cos(t * 0.5 + s.ph)), opacity: f(s.o * (0.45 + 0.55 * (0.5 + 0.5 * Math.sin(t * s.sp + s.ph)))) };
    case "petal": {
      const W = w > 0 ? w + 40 : 0, H = h > 0 ? h + 40 : 0;
      const wrap = (v: number, span: number) => (span > 0 ? ((((v + 20) % span) + span) % span) - 20 : v);
      const x = wrap(s.x + (s.vx ?? 0) * t, W) + Math.sin(t * s.sp + s.ph) * 8;
      const y = wrap(s.y + (s.vy ?? 0) * t, H);
      return { transform: `${centre(x, y)} rotate(${f((s.rot ?? 0) + t * 24 * s.sp)}deg)`, opacity: f(s.o) };
    }
  }
}

function hexA(hex: string, a: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** The grass and clovers in front of the figure, filling a `w` by `h` frame from its bottom: a strip of ground, three
 *  layers of blades (the tallest about 60% of the frame), clovers among them. One SVG, still. */
export function grassMarkup(w: number, h: number, dark: boolean): string {
  const p = palette(dark);
  const rnd = seeded(13);
  const k = h / 300;
  const out: string[] = [`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true" style="position:absolute;inset:0;display:block;pointer-events:none"><defs>${CLOVER}</defs>`];
  out.push(`<path d="M0 ${f(h - 32 * k)} C ${f(w * 0.24)} ${f(h - 42 * k)} ${f(w * 0.56)} ${f(h - 36 * k)} ${w} ${f(h - 40 * k)} V${h} H0Z" fill="${p.grass[0]}"/>`);
  for (let layer = 0; layer < 3; layer++) {
    const d: string[] = [];
    for (let x = -10; x < w + 10; x += 5 + rnd() * 6) {
      const tall = (70 + rnd() * 110) * (1 - layer * 0.2) * k, lean = (rnd() - 0.5) * 24 * Math.max(0.6, k);
      d.push(`M${f(x)} ${h} Q${f(x + lean * 0.4)} ${f(h - tall * 0.6)} ${f(x + lean)} ${f(h - tall)} Q${f(x + 4 + lean * 0.3)} ${f(h - tall * 0.5)} ${f(x + 8)} ${h}Z`);
    }
    out.push(`<path d="${d.join("")}" fill="${p.grass[layer]}"/>`);
  }
  const n = Math.round(30 * (w / 1240));
  for (let i = 0; i < n; i++) {
    const x = rnd() * w, y = h - (85 - rnd() * 80) * k, s = (0.5 + rnd() * 0.7) * clamp(k, 0.6, 1);
    out.push(clover(x, y, s, rnd() * 90, p.clover, 0.95));
  }
  out.push(`</svg>`);
  return out.join("");
}
