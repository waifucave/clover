/**
 * living-bots
 *
 * One flat shape, one flat colour, two eyes. Nothing in the drawing is shaded or cut up.
 * The body is treated as a solid that is round about its upright axis, and the eyes sit on its surface:
 * when the bot turns, they slide across the shape, narrow toward the edge and slip round the back.
 * That travel is the whole trick; the outline itself hardly changes.
 *
 * Bodies are built from circles joined by their tangents, so every outline is arcs and straight runs.
 * Eyes are ink ovals. They close by flattening and smile by bowing upward. Nothing ever crops them:
 * not a lid, and not the edge of the body. Near the edge they thin out and shrink until they are gone.
 *
 * The short way, in a web page:
 *
 *   const juniper = mount(canvas, 'Juniper');   // same name, same bot, every time
 *   juniper.setMood('working');
 *
 * The long way, if you run your own loop or draw several bots in one canvas:
 *
 *   const bot = makeBot('Juniper');
 *   const life = wake(bot);                     // one per place the bot is shown
 *   step(bot, life, seconds);                   // every frame
 *   render(ctx, bot, life, { x, y, size, px, dark });
 *
 * No dependencies. Everything except mount() also runs outside a browser.
 */

export const COLORS = { ink: '#1B1D2B', paper: '#F6F4EE', night: '#161A33', accent: '#E5A72E' };
export const PALETTE = [
  ['gold', '#E5A72E'], ['coral', '#F0694C'], ['sky', '#4A9CEC'], ['mint', '#3DBE8B'], ['violet', '#9A7BF0'],
  ['lagoon', '#1FB2BE'], ['lime', '#A2C73B'], ['orchid', '#C86FD6'], ['ember', '#F4893A'], ['iris', '#5F70E2'],
];
export const SHAPES = ['ball', 'drop', 'dome', 'bowl', 'pill', 'loaf', 'tile', 'peak', 'gem', 'cup'];
export const MOODS = ['idle', 'listening', 'thinking', 'working', 'asking', 'stuck', 'done', 'asleep'];
export const EYES = ['round', 'tall', 'dot', 'calm'];
export const TEMPERS = ['steady', 'restless', 'slow', 'bright'];

const TAU = Math.PI * 2;
const YAW = 1.06; // how far the head turns for a look to the side, in radians
const PITCH = 0.6;
const TILT = 0.15; // we see every bot from a little above, so the eyes travel on a curve, not a straight line
const HOP = 235;
const EDGE = 12; // the clear strip kept between an eye and the outline

/** A bot is drawn at this share of its square, about the middle, so that it has room to jump and lean. */
export const FRAME = 0.9;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const mix = (a, b, t) => a + (b - a) * t;
const ease = (t) => t * t * (3 - 2 * t);

function hashText(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function seeded(key) {
  let s = hashText(key) || 1;
  const f = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  f.range = (a, b) => a + (b - a) * f();
  f.pick = (list) => list[Math.floor(f() * list.length) % list.length];
  return f;
}

const rgbOf = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const toward = (from, to, t) => 'rgb(' + from.map((v, i) => Math.round(v + (to[i] - v) * t)).join(',') + ')';

// ---------------------------------------------------------------- bodies

/** The outline round a set of circles: arcs where it touches them, straight runs between. */
function wrap(circles) {
  const pts = [];
  for (const [x, y, r] of circles) for (let i = 0; i < 120; i++) pts.push([x + r * Math.cos((i / 120) * TAU), y + r * Math.sin((i / 120) * TAU)]);
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (list) => {
    const out = [];
    for (const p of list) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], p) <= 1e-12) out.pop();
      out.push(p);
    }
    out.pop();
    return out;
  };
  return half(pts).concat(half(pts.slice().reverse()));
}

/**
 * Each body: the circles it is wrapped round, where the face sits (face, in the same units, y down)
 * and how far the eyes may travel up and down from there (reach).
 */
const BODIES = {
  ball: () => ({ circles: [[0, 0, 1]], face: -0.08, reach: 0.8 }),
  drop: (r) => ({ circles: [[0, 0.3, 0.8], [0, r.range(-0.92, -0.82), r.range(0.14, 0.17)]], face: 0.2, reach: 0.56 }),
  dome: (r) => {
    const c = r.range(0.22, 0.3), w = r.range(0.96, 1.04);
    return { circles: [[0, -0.14, 0.74], [-(w - c), 0.8 - c, c], [w - c, 0.8 - c, c]], face: 0.02, reach: 0.56 };
  },
  pill: (r) => {
    const h = r.range(0.4, 0.54);
    return { circles: [[0, -h, 0.62], [0, h, 0.62]], face: -h + 0.16, reach: 0.5 };
  },
  loaf: (r) => {
    const h = r.range(0.4, 0.52);
    return { circles: [[-h, 0, 0.6], [h, 0, 0.6]], face: -0.04, reach: 0.44 };
  },
  tile: (r) => {
    const c = r.range(0.3, 0.42), w = 0.92 - c;
    return { circles: [[-w, -w, c], [w, -w, c], [-w, w, c], [w, w, c]], face: -0.08, reach: 0.66 };
  },
  bowl: (r) => {
    const c = r.range(0.2, 0.3), w = 0.9;
    return { circles: [[0, 0.1, w], [-(w - c), -0.84 + c, c], [w - c, -0.84 + c, c]], face: -0.12, reach: 0.6 };
  },
  peak: (r) => ({ circles: [[0, r.range(-0.7, -0.6), 0.28], [-0.6, 0.6, 0.34], [0.6, 0.6, 0.34]], face: 0.3, reach: 0.44 }),
  gem: () => ({ circles: [[0, -0.74, 0.22], [0, 0.74, 0.22], [-0.7, 0, 0.24], [0.7, 0, 0.24]], face: -0.04, reach: 0.4 }),
  cup: (r) => {
    const top = r.range(0.62, 0.7), foot = r.range(0.42, 0.5);
    return { circles: [[-top, -0.6, 0.28], [top, -0.6, 0.28], [-foot, 0.64, 0.3], [foot, 0.64, 0.3]], face: -0.1, reach: 0.56 };
  },
};

// what a name draws from. Order and repeats are part of the format: change them and every existing bot changes
const EYE_ODDS = ['round', 'round', 'round', 'round', 'tall', 'tall', 'tall', 'tall', 'dot', 'calm'];
// pairings that could be taken for something else (a smiley, a drop of blood, somebody else's character) take the next colour along
const AVOID = { ball: ['gold', 'orchid'], drop: ['coral'], dome: ['coral'], pill: ['gold'] };
const TEMPER_ODDS = ['steady', 'steady', 'restless', 'slow', 'bright'];

/**
 * Make the bot for a name. The same name always gives the same bot; capitals and outer spaces do not count.
 * Each of these is drawn from the name unless you set it:
 * options.shape   one of SHAPES
 * options.color   a name from PALETTE or any '#RRGGBB'
 * options.eyes    one of EYES
 * options.temper  one of TEMPERS
 */
export function makeBot(name, options = {}) {
  const key = String(name == null ? '' : name).trim().toLowerCase() || 'bot';
  const picked = seeded('flat/' + key + '/body').pick(SHAPES);
  const shape = BODIES[options.shape] ? options.shape : picked;
  let tone = seeded('flat/' + key + '/colour').pick(PALETTE);
  if ((AVOID[shape] || []).includes(tone[0])) tone = PALETTE[(PALETTE.indexOf(tone) + 1) % PALETTE.length];
  const asked = typeof options.color === 'string' ? options.color.trim() : '';
  const named = PALETTE.find((p) => p[0] === asked.toLowerCase());
  if (named) tone = named;
  else if (/^#[0-9a-f]{6}$/i.test(asked)) tone = ['custom', asked.toUpperCase()];
  const spec = BODIES[shape](seeded('flat/' + key + '/' + shape));

  // fit: every body gets about the same area, and none grows past the frame
  let unit = wrap(spec.circles), area = 0, x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0, j = unit.length - 1; i < unit.length; j = i++) area += (unit[j][0] + unit[i][0]) * (unit[j][1] - unit[i][1]) / 2;
  for (const p of unit) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
  const s = Math.min(318 * Math.sqrt(Math.PI / Math.abs(area)), 780 / Math.max(x1 - x0, y1 - y0));
  const my = (y0 + y1) / 2;
  const outline = unit.map((p) => [500 + p[0] * s, 500 + (p[1] - my) * s]);
  const top = 500 + (y0 - my) * s, foot = 500 + (y1 - my) * s, ax = ((x1 - x0) / 2) * s, ay = ((y1 - y0) / 2) * s;

  // how wide the body is at every height, so the eyes can run to its real edge
  const ROWS = 120, rows = [];
  for (let i = 0; i <= ROWS; i++) {
    const y = mix(top + 0.5, foot - 0.5, i / ROWS);
    let lo = Infinity, hi = -Infinity;
    for (let k = 0, j = outline.length - 1; k < outline.length; j = k++) {
      const a = outline[k], b = outline[j];
      if (a[1] > y !== b[1] > y) { const x = a[0] + ((y - a[1]) * (b[0] - a[0])) / (b[1] - a[1]); lo = Math.min(lo, x); hi = Math.max(hi, x); }
    }
    rows.push(lo <= hi ? (hi - lo) / 2 : 0);
  }
  const widthAt = (y) => {
    const f = clamp((y - top) / (foot - top), 0, 1) * ROWS, i = Math.min(ROWS - 1, Math.floor(f));
    return mix(rows[i], rows[i + 1], f - i);
  };

  // the room to either side of the middle for something h tall centred at height y, clear of the edge
  const fitAt = (y, h) => Math.min(widthAt(y - h), widthAt(y - h / 2), widthAt(y), widthAt(y + h / 2), widthAt(y + h)) - EDGE;

  const e = seeded('flat/' + key + '/eyes'), drawnEyes = e.pick(EYE_ODDS), faceY = 500 + (spec.face - my) * s;
  const kind = EYES.includes(options.eyes) ? options.eyes : drawnEyes;
  const want = e.range(0.255, 0.3) * (kind === 'dot' ? 0.78 : 1);
  const tall = kind === 'tall' ? e.range(1.22, 1.34) : kind === 'dot' ? 1 : e.range(1, 1.1);
  const apart = kind === 'dot' ? e.range(0.44, 0.54) : e.range(0.38, 0.47);
  const rest = kind === 'calm' ? 1 - e.range(0.2, 0.28) : 1;
  // eye size goes by the width of the body over the whole height of the eye, so a pointed body gets eyes that suit it
  let size = widthAt(faceY) * want;
  for (let i = 0; i < 3; i++) size = (want * (widthAt(faceY - size * tall) + 2 * widthAt(faceY) + widthAt(faceY + size * tall))) / 4;
  size = clamp(size, 318 * 0.17, Math.min(318 * 0.3, ay * 0.46));
  // two eyes of radius r need a clear half-width of g * r to sit side by side without touching
  const g = Math.sqrt(1 + (1.06 / Math.sin(apart)) ** 2);
  // how far up and down the eyes may go before the body gets too narrow for them
  let lo = faceY, hi = faceY;
  const roomy = (y) => fitAt(y, size * tall * 0.64) >= 0.64 * g * size;
  while (lo - 6 > top && roomy(lo - 6)) lo -= 6;
  while (hi + 6 < foot && roomy(hi + 6)) hi += 6;
  const t = seeded('flat/' + key + '/temper'), drawnTemper = t.pick(TEMPER_ODDS);
  const temper = TEMPERS.includes(options.temper) ? options.temper : drawnTemper;
  return {
    seed: key, version: 1, shape, colorName: tone[0], color: tone[1],
    outline, top, foot, ax, ay, widthAt, fitAt,
    face: { y: faceY, reach: spec.reach * s, lo, hi },
    eye: { kind, r: size, tall, apart, rest, g },
    yawMax: 1.2 - apart, // the furthest it holds a look to the side: both eyes stay in view. Only a full turn takes them round the back
    temper,
    breathSeconds: temper === 'slow' ? t.range(5.5, 6.5) : temper === 'restless' ? t.range(2.4, 3) : t.range(3.6, 4.6),
    blink: temper === 'restless' ? [1.5, 3.2] : temper === 'slow' ? [3.2, 6.4] : [2.2, 5],
    glance: temper === 'restless' ? [0.5, 1.3] : temper === 'slow' ? [2.4, 4.6] : [1.1, 2.8],
    // where it looks when nothing is going on: a little to one side and a little up, never square on
    home: [(t() < 0.5 ? -1 : 1) * t.range(0.2, 0.36), t.range(-0.34, -0.08)],
    tilt: t.range(0.035, 0.07), spring: temper === 'bright' ? 1.25 : temper === 'slow' ? 0.8 : 1,
    play: temper === 'bright' ? [5, 9] : temper === 'restless' ? [6, 11] : temper === 'slow' ? [13, 22] : [8, 15],
  };
}

// ---------------------------------------------------------------- life

/** Start a life for a bot: everything that moves. Keep one for each place the bot is shown. */
export function wake(B, mood = 'idle') {
  const r = seeded('flat/' + B.seed + '/life'), t0 = r.range(0, 20);
  return {
    mood: MOODS.includes(mood) ? mood : 'idle', moodTime: 0, t: t0, r,
    tx: B.home[0], ty: B.home[1], jx: 0, jy: 0, nextDrift: t0, yaw: B.home[0] * YAW, vYaw: 0, pitch: B.home[1] * PITCH, vPitch: 0, roll: B.home[0] * B.tilt, vRoll: 0,
    spin: 0, spinT: 1, spinDir: 1, spinDur: 0.8, look: null, lookUntil: 0,
    lid: 1 - B.eye.rest, smile: 0, wide: 1, skew: 0, perk: 0, slump: 0, dim: 0, nod: 9, nextNod: 0,
    close: 0, peek: 0, peekAmt: 0, blink: -1, blinksLeft: 0, nextBlink: t0 + r.range(0.8, 3), nextGlance: t0 + r.range(0.3, 1.4), nextPlay: t0 + r.range(5, 11),
    hop: 0, vHop: 0, squash: 0, vSquash: 0, crouch: 0, power: 0, turnOnJump: 0, joy: 0,
  };
}

/** Change what the bot is doing: one of MOODS. */
export function setMood(S, mood) {
  if (!MOODS.includes(mood) || S.mood === mood) return;
  S.mood = mood;
  S.moodTime = 0;
  S.peek = 0;
  if (mood !== 'done') S.joy = Math.min(S.joy, 0.2);
  if (mood === 'listening') { S.blink = 0; S.blinksLeft = 1; S.nod = 0; }
}

/** Look at a point for a while: x from -1 (far left) to 1, y from -1 (up) to 1 (down), measured from the bot's middle. */
export function lookAt(S, x, y, seconds = 2.2) {
  S.look = [clamp(x, -1.15, 1.15), clamp(y, -1, 1)];
  S.lookUntil = S.t + seconds;
}

function turnRound(S, dir, seconds) {
  if (S.spinT < 1) return;
  S.spinDir = dir; S.spinT = 0; S.spinDur = seconds;
}

function jump(S, power, turn) {
  if (S.crouch > 0 || S.hop > 0) return;
  S.crouch = 0.09; S.power = power; S.turnOnJump = turn || 0; S.vSquash -= 2.2;
}

/** A tap. Awake, it jumps, turns right round and smiles. Asleep, it opens one eye. */
export function poke(S, calm = false) {
  if (S.mood === 'asleep') { S.peek = 1.3; S.vSquash -= 1.2; return; }
  S.joy = 1.35;
  if (!(S.look && S.t < S.lookUntil)) lookAt(S, 0, -0.04, 1.7); // it looks at whoever tapped it
  if (calm) return;
  jump(S, 3.4, S.r() < 0.5 ? 1 : -1);
}

function spring(x, v, target, k, c, dt) {
  v += (k * (target - x) - c * v) * dt;
  return [x + v * dt, v];
}

/** Move a life on by dt seconds. calm = true leaves out jumps and turns, for people who ask for less motion. */
export function step(B, S, dt, calm = false) {
  dt = Math.min(dt, 0.05);
  S.t += dt;
  S.moodTime += dt;
  const m = S.mood, E = B.eye;
  let wide = 1, lid = 1 - E.rest, smile = 0, rollT = 0, perk = 0, skew = 0, slump = 0, stiff = 1, extraPitch = 0;
  const watching = S.look && S.t < S.lookUntil && m !== 'asleep';

  if (m === 'idle') {
    if (!watching && S.t > S.nextGlance) {
      const roll = S.r(), far = Math.abs(S.tx) > 0.9;
      let nx, ny;
      if (far || roll < 0.3) { nx = B.home[0] + S.r.range(-0.08, 0.08); ny = B.home[1] + S.r.range(-0.08, 0.08); } // back to its usual look
      else if (roll < 0.44) { nx = S.r.range(-0.08, 0.08); ny = S.r.range(-0.05, 0.1); } // straight at you
      else if (roll < 0.86) { nx = S.r.range(0.3, 0.8) * (S.r() < 0.5 ? -1 : 1); ny = S.r.range(-0.55, 0.36); }
      else { nx = S.r.range(0.96, 1.12) * (S.r() < 0.5 ? -1 : 1); ny = S.r.range(-0.2, 0.15); } // right round to one side
      if (Math.abs(nx - S.tx) > 0.7 && S.r() < 0.55 && S.blink < 0) S.blink = 0;
      S.tx = nx;
      S.ty = ny;
      S.nextGlance = S.t + S.r.range(B.glance[0], B.glance[1]) * (Math.abs(nx) > 0.9 ? 0.6 : 1);
    }
    if (!calm && !watching && S.t > S.nextPlay) {
      if (S.r() < (B.temper === 'bright' ? 0.35 : 0.6)) turnRound(S, S.tx < 0 ? -1 : 1, 0.85); else jump(S, 2.3, 0);
      S.nextPlay = S.t + S.r.range(B.play[0], B.play[1]);
    }
    if (S.t > S.nextDrift) { S.jx = S.r.range(-0.035, 0.035); S.jy = S.r.range(-0.035, 0.035); S.nextDrift = S.t + S.r.range(0.3, 0.9); }
    rollT = S.tx * B.tilt;
  } else if (m === 'listening') {
    S.tx = 0; S.ty = -0.1; wide = 1.14; perk = 1; lid = 0;
    if (S.t > S.nextNod) { S.nod = 0; S.nextNod = S.t + S.r.range(1.9, 3.2); }
    S.nod += dt;
    if (!calm) extraPitch = 0.24 * Math.sin(S.nod * TAU * 2.2) * Math.exp(-S.nod * 2.4);
  } else if (m === 'thinking') {
    const side = Math.floor(S.moodTime / 3.4) % 2 ? 1 : -1;
    S.tx = side * 0.52 + 0.1 * Math.cos(S.t * 1.1);
    S.ty = -0.78 + 0.1 * Math.sin(S.t * 1.1);
    rollT = side * 0.1; lid = Math.max(lid, 0.06); skew = side; stiff = 0.3;
  } else if (m === 'working') {
    // reads a line from left to right, then snaps back to the start of the next one
    const line = (S.moodTime % 1.15) / 1.15;
    S.tx = line < 0.86 ? mix(-0.62, 0.62, line / 0.86) : mix(0.62, -0.62, ease((line - 0.86) / 0.14));
    S.ty = 0.3; lid = Math.max(lid, 0.14);
    stiff = 1.6;
    if (!calm && S.moodTime % 1.15 < dt && S.moodTime > 0.5) S.vSquash -= 0.5;
  } else if (m === 'asking') {
    // wants you: faces you, bounces on the spot, tips its head one way then the other
    S.tx = 0; S.ty = -0.14; wide = 1.1; perk = 1; lid = 0;
    rollT = 0.085 * (Math.floor(S.moodTime / 1.5) % 2 ? 1 : -1);
    if (!calm && S.moodTime % 1.5 < dt * 1.5) jump(S, 1.9, 0);
  } else if (m === 'stuck') {
    // shakes its head, then looks at you with heavy eyes
    const beat = S.moodTime % 3.1;
    S.tx = beat < 1.25 ? 0.74 * Math.sin(beat * TAU * 1.9) * (1 - beat / 1.25) : 0;
    S.ty = 0.14; lid = Math.max(lid, 0.3); slump = 0.5; stiff = 1.7;
  } else if (m === 'done') {
    S.tx = 0; S.ty = -0.08;
    if (S.moodTime % 3.4 < dt * 1.5) { S.joy = 1.6; if (!calm) jump(S, 3.5, S.r() < 0.5 ? 1 : -1); }
  } else {
    S.tx = 0.16; S.ty = 0.5; rollT = -0.1; slump = 1; stiff = 0.15;
  }
  if (watching) { S.tx = S.look[0]; S.ty = S.look[1]; stiff = Math.max(stiff, 1); if (m === 'idle') rollT = S.tx * B.tilt; }

  const reach = calm ? 0.65 : 1, k = 150 * B.spring * stiff, c = 2 * 0.66 * Math.sqrt(k);
  [S.yaw, S.vYaw] = spring(S.yaw, S.vYaw, clamp((S.tx + (m === 'idle' ? S.jx : 0)) * YAW * reach, -B.yawMax, B.yawMax), k, c, dt);
  [S.pitch, S.vPitch] = spring(S.pitch, S.vPitch, (S.ty + (m === 'idle' ? S.jy : 0)) * PITCH * reach + extraPitch, k, c * 1.04, dt);
  [S.roll, S.vRoll] = spring(S.roll, S.vRoll, calm ? rollT * 0.4 : rollT, 40, 8.5, dt);
  if (S.spinT < 1) {
    S.spinT = Math.min(1, S.spinT + dt / S.spinDur);
    S.spin = S.spinT >= 1 ? 0 : S.spinDir * TAU * ease(S.spinT);
  }

  S.joy = Math.max(0, S.joy - dt);
  if (S.crouch > 0) {
    S.crouch -= dt;
    if (S.crouch <= 0) { S.vHop = S.power; S.vSquash += 3.4; if (S.turnOnJump) turnRound(S, S.turnOnJump, 0.62); }
  }
  if (S.hop > 0 || S.vHop > 0) {
    S.vHop -= 14 * dt;
    S.hop += S.vHop * dt;
    if (S.hop <= 0) { S.hop = 0; S.vSquash -= Math.min(3.2, Math.abs(S.vHop)) * 0.95; S.vHop = 0; }
  }
  [S.squash, S.vSquash] = spring(S.squash, S.vSquash, 0, 230, 13, dt);

  if (S.joy > 0.14) { smile = 1; lid = 0; wide = 1.06; skew = 0; }
  const rate = 1 - Math.exp(-dt * 13);
  S.lid += (lid - S.lid) * rate;
  S.smile += (smile - S.smile) * (1 - Math.exp(-dt * (smile > S.smile ? 12 : 9)));
  S.wide += (wide - S.wide) * rate;
  S.skew += (skew - S.skew) * rate * 0.4;
  S.perk += (perk - S.perk) * (1 - Math.exp(-dt * 8));
  S.slump += (slump - S.slump) * (1 - Math.exp(-dt * 2.5));
  S.dim += ((m === 'asleep' ? 1 : 0) - S.dim) * (1 - Math.exp(-dt * 3));

  if (m === 'asleep') {
    S.close += (1 - S.close) * (1 - Math.exp(-dt * 3.2));
    S.blink = -1;
    S.peek = Math.max(0, S.peek - dt);
    S.peekAmt += ((S.peek > 0.25 ? 0.62 : 0) - S.peekAmt) * (1 - Math.exp(-dt * 9));
  } else {
    S.peekAmt = 0;
    if (S.blink < 0 && S.t > S.nextBlink) { S.blink = 0; S.blinksLeft = S.r() < 0.16 ? 1 : 0; }
    let shut = 0;
    if (S.blink >= 0) {
      S.blink += dt / 0.19;
      if (S.blink >= 1) {
        if (S.blinksLeft > 0) { S.blinksLeft--; S.blink = 0; } else { S.blink = -1; S.nextBlink = S.t + S.r.range(B.blink[0], B.blink[1]) * (m === 'listening' ? 1.5 : 1); }
      } else shut = S.blink < 0.36 ? ease(S.blink / 0.36) : S.blink < 0.5 ? 1 : 1 - ease((S.blink - 0.5) / 0.5);
    }
    S.close = S.close > 0.5 && S.blink < 0 ? Math.max(0, S.close - dt * 5) : shut;
  }
}

// ---------------------------------------------------------------- drawing

function trace(ctx, pts) {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
}

/**
 * Where one eye is right now (side -1 is its right eye, on our left; 1 the other), or null while it is round the back.
 * x, y is its middle, hx and hy its half-width and half-height when wide open, r its size before the turn narrows it.
 * The eye is placed so that all of it stays inside the body with a clear strip to the edge.
 */
export function eyeOf(B, S, side, boost = 1) {
  const E = B.eye, P = S.pitch + TILT, lon = S.yaw + S.spin + side * E.apart;
  const x1 = Math.sin(lon), z1 = Math.cos(lon), y2 = z1 * Math.sin(P), z2 = z1 * Math.cos(P);
  if (z2 <= 0.015) return null;
  const fx = Math.pow(z2 / Math.hypot(x1, z2), 0.86), fy = Math.sqrt(1 - y2 * y2 * 0.8);
  const full = E.r * boost * S.wide * (0.87 + 0.13 * z2);
  const y = clamp(B.face.y + y2 * B.face.reach, B.face.lo, B.face.hi);
  const tall = full * E.tall * fy * (0.62 + 0.38 * fx); // an eye gets shorter as well as thinner on its way round
  // in a tight spot the eyes get smaller, so they never touch each other or the edge
  const room = clamp(B.fitAt(y, tall) / (E.g * full), 0.3, 1);
  const r = full * room, hy = tall * room, fit = B.fitAt(y, hy);
  return { x: 500 + x1 * Math.sqrt(Math.max(fit * fit - r * r, 0)), y, hx: r * fx, hy, r };
}

const EYE_POINTS = 48;

/**
 * An eye is an oval. It closes by flattening into a soft bar, and the bar can bow: up for a smile, down for sleep.
 * Writes its outline into out as x0, y0, x1, y1 ... around the point ox, oy.
 * hx, hy  half-width and half-height now;  bar  half the thickness it keeps when shut;  bend  how far the middle bows up.
 */
function eyeOutline(hx, hy, bar, bend, ox, oy, out) {
  const h = Math.max(hy, Math.min(bar, hx * 0.9)), e = 2 / (2 + 3 * clamp(1 - h / (0.55 * hx), 0, 1));
  for (let i = 0; i < EYE_POINTS; i++) {
    const a = (i / EYE_POINTS) * TAU, c = Math.cos(a), sn = Math.sin(a);
    const x = hx * Math.sign(c) * Math.pow(Math.abs(c), e);
    out[2 * i] = ox + x;
    out[2 * i + 1] = oy + h * Math.sign(sn) * Math.pow(Math.abs(sn), e) - bend * (1 - (x * x) / (hx * hx));
  }
  return out;
}

const boostFor = (px) => (px < 26 ? 1.36 : px < 44 ? 1.16 : 1); // small pictures get larger eyes

/** One eye as it is drawn this instant: eyeOf plus how far it is open (h), its shut thickness (bar) and its bow (bend). */
function eyeNow(B, S, side, boost) {
  const p = eyeOf(B, S, side, boost);
  if (!p || p.hx < 0.5) return null;
  const sm = S.smile, bow = ease(clamp((sm - 0.3) / 0.7, 0, 1)), down = sm > 0.05 ? 0 : 0.1 * clamp(S.pitch / PITCH, 0, 1);
  const shut = clamp(S.close - (side > 0 ? S.peekAmt : 0), 0, 1);
  // a smile first narrows the eye to a bar, then bows the bar upward
  p.h = p.hy * (1 - clamp(S.lid + down + 0.07 * S.skew * side, 0, 0.6)) * (1 - shut) * (1 - clamp(sm * 2.4, 0, 1));
  p.bar = p.r * 0.2 * (1 + 0.2 * bow);
  p.bend = p.hx * (0.55 * bow - 0.26 * S.dim * shut);
  return p;
}

/** How the body sits this instant: its colour, and the move that carries it (and the eyes) from rest. */
function bodyNow(B, S, view) {
  const Y = S.yaw + S.spin, slow = S.dim > 0.5;
  const breath = (slow ? 0.024 : 0.012) * Math.sin((S.t * TAU) / (B.breathSeconds * (slow ? 1.6 : 1)));
  const sq = S.squash - 0.07 * S.slump + 0.035 * S.perk;
  const surface = rgbOf(/^#[0-9a-f]{6}$/i.test(view.surface || '') ? view.surface : view.dark ? '#20254A' : '#FFFFFF');
  return {
    fill: S.dim > 0.01 ? toward(rgbOf(B.color), surface, S.dim * (view.dark ? 0.28 : 0.4)) : B.color,
    x: 500 + B.ax * 0.05 * Math.sin(S.yaw), y: B.foot - S.hop * HOP, roll: S.roll,
    sx: (1 - sq * 0.72) * (1 - 0.05 * Math.abs(Math.sin(Y))), sy: (1 + sq) * (1 + breath),
  };
}

const scratch = new Array(EYE_POINTS * 2);

/**
 * Draw one bot.
 * view.x, view.y, view.size  the square to draw in, in canvas units
 * view.px                    its size on screen in CSS pixels (small sizes get larger eyes; under 12 the eyes are left out)
 * view.dark                  true on a dark surface
 * view.surface               the colour behind the bot as '#RRGGBB' (a sleeping bot fades toward it)
 * view.eye                   eye colour, ink by default
 */
export function render(ctx, B, S, view) {
  const px = view.px || view.size, k = (view.size / 1000) * FRAME, b = bodyNow(B, S, view);
  ctx.save();
  ctx.translate((view.x || 0) + view.size / 2, (view.y || 0) + view.size / 2);
  ctx.scale(k, k);
  ctx.translate(b.x - 500, b.y - 500);
  ctx.rotate(b.roll);
  ctx.scale(b.sx, b.sy);
  ctx.translate(-500, -B.foot);
  ctx.fillStyle = b.fill;
  trace(ctx, B.outline);
  ctx.fill();
  if (px >= 12) {
    ctx.clip(); // never needed while the eyes fit, which they are placed to do; kept as a guard
    ctx.fillStyle = view.eye || COLORS.ink;
    for (const side of [-1, 1]) {
      const p = eyeNow(B, S, side, boostFor(px));
      if (!p) continue;
      eyeOutline(p.hx, p.h, p.bar, p.bend, p.x, p.y, scratch);
      ctx.beginPath();
      ctx.moveTo(scratch[0], scratch[1]);
      for (let i = 2; i < scratch.length; i += 2) ctx.lineTo(scratch[i], scratch[i + 1]);
      ctx.closePath();
      ctx.fill();
    }
  }
  ctx.restore();
}

/**
 * The picture as plain numbers, for drawing a bot with something other than a canvas.
 * Everything is in a 1000 by 1000 square. Move the outline and the eyes together, in this order:
 * translate(-500, -foot), scale(sx, sy), rotate(roll), translate(x, y). Then fit the square to your box,
 * drawn at FRAME of the box's size about its middle, which leaves the bot room to jump.
 * px is the size on screen in CSS pixels; view is { dark, surface } as for render.
 */
export function poseOf(B, S, px = 96, view = {}) {
  const b = bodyNow(B, S, view), eyes = [];
  if (px >= 12) {
    for (const side of [-1, 1]) {
      const p = eyeNow(B, S, side, boostFor(px));
      if (p) eyes.push(eyeOutline(p.hx, p.h, p.bar, p.bend, p.x, p.y, new Array(EYE_POINTS * 2)));
    }
  }
  return { fill: b.fill, outline: B.outline, foot: B.foot, x: b.x, y: b.y, roll: b.roll, sx: b.sx, sy: b.sy, eyes };
}

const escapeXML = (text) => String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * A still picture of a bot as SVG markup, for places a canvas cannot go.
 * options.size     width and height in pixels, 96 by default
 * options.scale    1 leaves room to jump; about 1.25 fills an avatar slot
 * options.life     the life to picture; a fresh one by default, which shows the bot's usual look
 * options.label    what a screen reader says; the bot's name by default. '' marks the picture as decoration
 * options.dark, options.surface, options.eye   as for render
 */
export function botSVG(B, options = {}) {
  const size = options.size > 0 ? options.size : 96, p = poseOf(B, options.life || wake(B), size, options);
  const n = (v) => String(Math.round(v * 10) / 10), m = (v) => String(Math.round(v * 10000) / 10000);
  let body = '';
  for (let i = 0; i < p.outline.length; i++) body += (i ? 'L' : 'M') + n(p.outline[i][0]) + ' ' + n(p.outline[i][1]);
  let eyes = '';
  for (const pts of p.eyes) {
    eyes += '<path d="';
    for (let i = 0; i < pts.length; i += 2) eyes += (i ? 'L' : 'M') + n(pts[i]) + ' ' + n(pts[i + 1]);
    eyes += 'Z"/>';
  }
  const label = options.label == null ? B.seed : options.label, f = (1 - FRAME) * 500;
  const side = 1000 / (options.scale > 0 ? options.scale : 1), edge = n(500 - side / 2);
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="' + edge + ' ' + edge + ' ' + n(side) + ' ' + n(side) + '" width="' + n(size) + '" height="' + n(size) + '"' +
    (label === '' ? ' aria-hidden="true">' : ' role="img" aria-label="' + escapeXML(label) + '">') +
    '<g transform="translate(' + n(f) + ' ' + n(f) + ') scale(' + FRAME + ') translate(' + n(p.x) + ' ' + n(p.y) + ') rotate(' + m((p.roll * 180) / Math.PI) + ') scale(' + m(p.sx) + ' ' + m(p.sy) + ') translate(-500 ' + n(-p.foot) + ')">' +
    '<path fill="' + escapeXML(p.fill) + '" d="' + body + 'Z"/><g fill="' + escapeXML(options.eye || COLORS.ink) + '">' + eyes + '</g></g></svg>';
}

// ---------------------------------------------------------------- in a web page

const mounted = new Set(), handleOf = new WeakMap();
let frame = 0, before = 0, watcher = null, pointing = false;

function tick(now) {
  const dt = Math.min(0.05, Math.max(0, (now - before) / 1000));
  before = now;
  for (const h of mounted) h.draw(dt);
  frame = mounted.size ? requestAnimationFrame(tick) : 0;
}

function onPointer(e) {
  for (const h of mounted) if (h.follow) h.lookAtPoint(e.clientX, e.clientY);
}

/**
 * Put a bot in a canvas and keep it alive: sizing for sharp screens, one shared loop, resting while off screen,
 * and less motion for people who ask their system for it. Give the canvas a size in CSS. Returns a handle:
 *
 *   handle.setMood(mood)   handle.poke()   handle.lookAt(x, y, seconds)   handle.lookAtPoint(clientX, clientY)
 *   handle.setBot(nameOrBot, options)   handle.set({ scale, dark, surface, eye, follow, calm })   handle.destroy()
 *   handle.bot   handle.life   handle.canvas
 *
 * who              a name, or a bot from makeBot
 * options.mood     one of MOODS, 'idle' by default
 * options.scale    1 leaves room to jump; about 1.25 fills an avatar slot
 * options.dark, options.surface, options.eye   as for render
 * options.follow   true to watch the mouse, or a finger while it is down
 * options.tap      true to answer a click or tap on the canvas
 * options.calm     true or false to decide about reduced motion yourself; left out, the system setting decides
 * options.shape, .color, .eyes, .temper   passed to makeBot when who is a name
 */
export function mount(canvas, who, options = {}) {
  const ctx = canvas.getContext('2d');
  const quiet = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  const botFor = (w, o) => (w && typeof w === 'object' && w.outline ? w : makeBot(w, o || {}));
  const h = {
    canvas, bot: botFor(who, options), life: null, seen: true,
    scale: options.scale > 0 ? options.scale : 1, dark: !!options.dark, surface: options.surface, eye: options.eye, follow: !!options.follow, calm: options.calm,
    isCalm: () => (h.calm == null ? !!(quiet && quiet.matches) : !!h.calm),
    setMood(mood) { setMood(h.life, mood); return h; },
    poke() { poke(h.life, h.isCalm()); return h; },
    lookAt(x, y, seconds) { lookAt(h.life, x, y, seconds); return h; },
    lookAtPoint(clientX, clientY, seconds) {
      const r = canvas.getBoundingClientRect(), dx = clientX - (r.left + r.width / 2), dy = clientY - (r.top + r.height / 2);
      // toward the point, further the further away it is, levelling off before the look gets extreme
      const d = Math.hypot(dx, dy), far = d ? ((d / (d + Math.max(r.width, r.height, 60) * 1.1)) * 0.95) / d : 0;
      lookAt(h.life, dx * far, dy * far * 0.8, seconds);
      return h;
    },
    setBot(w, o) {
      const mood = h.life ? h.life.mood : options.mood;
      h.bot = botFor(w, o);
      h.life = wake(h.bot, mood);
      if (!labelled) canvas.setAttribute('aria-label', h.bot.seed);
      return h;
    },
    set(o) {
      for (const key of ['dark', 'surface', 'eye', 'follow', 'calm']) if (key in o) h[key] = o[key];
      if (o.scale > 0) h.scale = o.scale;
      if (h.follow) point();
      return h;
    },
    draw(dt) {
      const w = canvas.clientWidth, t = canvas.clientHeight;
      if (!h.seen || !w || !t) return;
      const ratio = Math.min(window.devicePixelRatio || 1, 3), W = Math.round(w * ratio), H = Math.round(t * ratio);
      if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
      step(h.bot, h.life, dt, h.isCalm());
      const s = Math.min(W, H) * h.scale;
      ctx.clearRect(0, 0, W, H);
      render(ctx, h.bot, h.life, { x: (W - s) / 2, y: (H - s) / 2, size: s, px: Math.min(w, t) * h.scale, dark: h.dark, surface: h.surface, eye: h.eye });
    },
    destroy() {
      mounted.delete(h);
      handleOf.delete(canvas);
      if (watcher) watcher.unobserve(canvas);
      canvas.removeEventListener('click', onTap);
    },
  };
  const onTap = () => h.poke();
  const point = () => {
    if (pointing) return;
    pointing = true;
    window.addEventListener('pointermove', onPointer, { passive: true });
    window.addEventListener('pointerdown', onPointer, { passive: true });
  };
  const labelled = canvas.hasAttribute('aria-label') || canvas.hasAttribute('aria-hidden');
  if (!canvas.hasAttribute('role') && !canvas.hasAttribute('aria-hidden')) canvas.setAttribute('role', 'img');
  h.setBot(h.bot);
  if (options.tap) canvas.addEventListener('click', onTap);
  if (h.follow) point();
  if (typeof IntersectionObserver === 'function') {
    if (!watcher) watcher = new IntersectionObserver((entries) => { for (const e of entries) { const m = handleOf.get(e.target); if (m) m.seen = e.isIntersecting; } }, { rootMargin: '64px' });
    watcher.observe(canvas);
  }
  mounted.add(h);
  handleOf.set(canvas, h);
  if (!frame) { before = performance.now(); frame = requestAnimationFrame(tick); }
  return h;
}
