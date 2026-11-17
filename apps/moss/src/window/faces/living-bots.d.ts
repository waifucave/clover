/** Types for living-bots.js */

export type Shape = 'ball' | 'drop' | 'dome' | 'bowl' | 'pill' | 'loaf' | 'tile' | 'peak' | 'gem' | 'cup';
export type Mood = 'idle' | 'listening' | 'thinking' | 'working' | 'asking' | 'stuck' | 'done' | 'asleep';
export type Eyes = 'round' | 'tall' | 'dot' | 'calm';
export type Temper = 'steady' | 'restless' | 'slow' | 'bright';
export type ColorName = 'gold' | 'coral' | 'sky' | 'mint' | 'violet' | 'lagoon' | 'lime' | 'orchid' | 'ember' | 'iris';

/** The colours shared with the Shards icon. Eyes are ink. */
export const COLORS: { ink: string; paper: string; night: string; accent: string };
/** Body colours a name draws from, as [name, '#RRGGBB']. */
export const PALETTE: [ColorName, string][];
export const SHAPES: Shape[];
export const MOODS: Mood[];
export const EYES: Eyes[];
export const TEMPERS: Temper[];
/** A bot is drawn at this share of its square, about the middle, so that it has room to jump and lean. */
export const FRAME: number;

/** Each trait is drawn from the name unless it is set here. */
export interface BotOptions {
  shape?: Shape;
  /** A name from PALETTE or any '#RRGGBB'. */
  color?: ColorName | string;
  eyes?: Eyes;
  temper?: Temper;
}

/** One bot. Make it again from its name and options when you need it; it holds functions, so it does not survive JSON. */
export interface Bot {
  /** The name it was made from, trimmed and in lower case. */
  seed: string;
  /** Goes up if a later file draws names differently. */
  version: number;
  shape: Shape;
  colorName: ColorName | 'custom';
  /** '#RRGGBB' */
  color: string;
  /** The body, as points in a 1000 by 1000 square. */
  outline: [number, number][];
  top: number;
  foot: number;
  /** Half the body's width and height. */
  ax: number;
  ay: number;
  /** Half the body's width at height y. */
  widthAt(y: number): number;
  /** The clear room to either side of the middle for something h tall centred at height y. */
  fitAt(y: number, h: number): number;
  face: { y: number; reach: number; lo: number; hi: number };
  eye: { kind: Eyes; r: number; tall: number; apart: number; rest: number; g: number };
  /** The furthest it holds a look to the side, in radians. */
  yawMax: number;
  temper: Temper;
  breathSeconds: number;
  blink: [number, number];
  glance: [number, number];
  /** Where it looks when nothing is going on. */
  home: [number, number];
  tilt: number;
  spring: number;
  play: [number, number];
}

/** Everything that moves. Read what you like, but change it only through setMood, lookAt, poke and step. */
export interface Life {
  mood: Mood;
  /** Seconds since this mood began. */
  moodTime: number;
  [key: string]: any;
}

export interface View {
  /** The square to draw in, in canvas units. x and y default to 0. */
  x?: number;
  y?: number;
  size: number;
  /** Its size on screen in CSS pixels. Small sizes get larger eyes; under 12 the eyes are left out. Defaults to size. */
  px?: number;
  /** True on a dark surface. */
  dark?: boolean;
  /** The colour behind the bot as '#RRGGBB'. A sleeping bot fades toward it. */
  surface?: string;
  /** Eye colour. Ink by default. */
  eye?: string;
}

/** Where one eye is: its middle, its half-width and half-height when wide open, and its size before the turn narrows it. */
export interface EyePlace { x: number; y: number; hx: number; hy: number; r: number }

/** The picture as plain numbers. See the comment above poseOf in the file for how to place them. */
export interface Pose {
  fill: string;
  outline: [number, number][];
  foot: number;
  x: number;
  y: number;
  /** Radians. */
  roll: number;
  sx: number;
  sy: number;
  /** One outline for each eye in view, as x0, y0, x1, y1 and so on. */
  eyes: number[][];
}

export interface StillOptions {
  /** Width and height in pixels. 96 by default. */
  size?: number;
  /** 1 leaves room to jump; about 1.25 fills an avatar slot. */
  scale?: number;
  /** The life to picture. A fresh one by default, which shows the bot's usual look. */
  life?: Life;
  /** What a screen reader says. The bot's name by default; '' marks the picture as decoration. */
  label?: string;
  dark?: boolean;
  surface?: string;
  eye?: string;
}

export interface MountOptions extends BotOptions {
  mood?: Mood;
  /** 1 leaves room to jump; about 1.25 fills an avatar slot. */
  scale?: number;
  dark?: boolean;
  surface?: string;
  eye?: string;
  /** True to watch the mouse, or a finger while it is down. */
  follow?: boolean;
  /** True to answer a click or tap on the canvas. */
  tap?: boolean;
  /** True or false to decide about reduced motion yourself. Left out, the system setting decides. */
  calm?: boolean;
}

export interface Handle {
  readonly canvas: HTMLCanvasElement;
  readonly bot: Bot;
  readonly life: Life;
  setMood(mood: Mood): Handle;
  /** A tap. Awake, it jumps, turns right round and smiles. Asleep, it opens one eye. */
  poke(): Handle;
  /** x from -1 (far left) to 1, y from -1 (up) to 1 (down), measured from the bot's middle. */
  lookAt(x: number, y: number, seconds?: number): Handle;
  /** Look toward a place on the page, in the coordinates of a pointer event. */
  lookAtPoint(clientX: number, clientY: number, seconds?: number): Handle;
  /** Swap in another bot and keep the mood. */
  setBot(who: string | Bot, options?: BotOptions): Handle;
  set(options: { scale?: number; dark?: boolean; surface?: string; eye?: string; follow?: boolean; calm?: boolean | null }): Handle;
  /** Stop drawing it. Call this when you remove the canvas. */
  destroy(): void;
}

/** Make the bot for a name. The same name always gives the same bot; capitals and outer spaces do not count. */
export function makeBot(name: string, options?: BotOptions): Bot;
/** Start a life for a bot. Keep one for each place the bot is shown. */
export function wake(bot: Bot, mood?: Mood): Life;
export function setMood(life: Life, mood: Mood): void;
/** Look at a point for a while: x from -1 (far left) to 1, y from -1 (up) to 1 (down). */
export function lookAt(life: Life, x: number, y: number, seconds?: number): void;
/** A tap. calm = true leaves out the jump. */
export function poke(life: Life, calm?: boolean): void;
/** Move a life on by dt seconds. calm = true leaves out jumps and turns. */
export function step(bot: Bot, life: Life, dt: number, calm?: boolean): void;
export function render(ctx: CanvasRenderingContext2D, bot: Bot, life: Life, view: View): void;
/** Where one eye is right now (side -1 is on our left), or null while it is round the back. */
export function eyeOf(bot: Bot, life: Life, side: -1 | 1, boost?: number): EyePlace | null;
export function poseOf(bot: Bot, life: Life, px?: number, view?: { dark?: boolean; surface?: string }): Pose;
/** A still picture of a bot as SVG markup. Runs without a browser. */
export function botSVG(bot: Bot, options?: StillOptions): string;
/** Put a bot in a canvas and keep it alive. Size the canvas in CSS. */
export function mount(canvas: HTMLCanvasElement, who: string | Bot, options?: MountOptions): Handle;
