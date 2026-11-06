// What a PTY's output means on screen (review S6): a small model of a terminal's lines, enough for shells and the
// tools people run in them. It keeps the text and its look (SGR: the colours, bold, dim, italic, underline, inverse),
// follows a carriage return, backspace and tab, erases a line or the screen, and drops every other escape sequence
// (cursor moves, titles, modes) instead of printing it. Full-screen programs (an editor, `top`) need a real terminal
// emulator, which is the runtime's to bring; here they show their text without the layout.
//
// Colours follow the theme: the eight ANSI hues (and their bright twins, and 256-colour and true-colour values,
// sorted to the nearest hue) map to the tokens the part wears, so a theme dresses the terminal too.

export type Hue = "black" | "red" | "green" | "yellow" | "blue" | "magenta" | "cyan" | "white";

export interface Look {
  fg?: Hue;
  bold?: true;
  dim?: true;
  italic?: true;
  underline?: true;
  inverse?: true;
}

export interface Run extends Look {
  text: string;
}

const HUES: readonly Hue[] = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];

/** The nearest of the eight hues to an RGB colour. */
export function nearestHue(r: number, g: number, b: number): Hue {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max - min < 40) return max < 96 ? "black" : "white";
  const bit = (v: number) => (v > (max + min) / 2 ? 1 : 0);
  return HUES[bit(r) | (bit(g) << 1) | (bit(b) << 2)]!;
}

/** The RGB of an xterm 256-colour index (16–255; 0–15 are the hues themselves). */
function rgb256(n: number): [number, number, number] {
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return [v, v, v];
  }
  const i = n - 16;
  const step = (x: number) => (x === 0 ? 0 : 55 + x * 40);
  return [step(Math.floor(i / 36)), step(Math.floor(i / 6) % 6), step(i % 6)];
}

interface Cell {
  ch: string;
  look: Look;
}

/** At most this many lines are kept; older ones scroll away. */
export const SCROLLBACK = 5000;

/** The widest a line gets: a cursor move past it stops at its edge, and text past it wraps (review N2: `ESC[500000C`
 *  must not fill half a million cells). */
export const MAX_COLUMNS = 1024;

/** The longest an unfinished escape sequence is held for the next chunk. Past it the sequence is dropped and what
 *  follows shows as text, so a sequence that never ends can't hide a program's output or grow without bound (N2). */
export const MAX_PENDING = 4096;

export class Screen {
  /** `columns`: the terminal's width, at most `MAX_COLUMNS`. */
  constructor(private readonly columns = MAX_COLUMNS) {
    this.columns = Math.max(1, Math.min(MAX_COLUMNS, Math.floor(columns) || MAX_COLUMNS));
  }

  private lines: Cell[][] = [[]];
  private col = 0;
  private look: Look = {};
  /** An escape sequence cut off at the end of a chunk, finished by the next. */
  private pending = "";

  write(data: string): void {
    const s = this.pending + data;
    this.pending = "";
    let i = 0;
    while (i < s.length) {
      const c = s[i]!;
      if (c === "\x1b") {
        const used = this.escape(s, i);
        if (used === 0) {
          if (s.length - i <= MAX_PENDING) {
            this.pending = s.slice(i);
            return;
          }
          // Too long to be a real sequence: drop its introducer and show the rest.
          i += 2;
          continue;
        }
        i += used;
        continue;
      }
      i += 1;
      if (c === "\r") this.col = 0;
      else if (c === "\n") this.newline();
      else if (c === "\b") this.col = Math.max(0, this.col - 1);
      else if (c === "\t") {
        const to = (Math.floor(this.col / 8) + 1) * 8;
        while (this.col < to) this.put(" ");
      } else if (c >= " " || c > "\x7f") this.put(c);
      // Any other control character (the bell, shift in and out) shows nothing.
    }
  }

  /** The screen as lines of runs of the same look. */
  view(): Run[][] {
    return this.lines.map((line) => {
      const runs: Run[] = [];
      for (const cell of line) {
        const last = runs[runs.length - 1];
        if (last && sameLook(last, cell.look)) last.text += cell.ch;
        else runs.push({ ...cell.look, text: cell.ch });
      }
      return runs;
    });
  }

  private put(ch: string): void {
    if (this.col >= this.columns) this.newline();
    const line = this.lines[this.lines.length - 1]!;
    while (line.length < this.col) line.push({ ch: " ", look: {} });
    line[this.col] = { ch, look: this.look };
    this.col += 1;
  }

  private newline(): void {
    this.lines.push([]);
    this.col = 0;
    if (this.lines.length > SCROLLBACK) this.lines.splice(0, this.lines.length - SCROLLBACK);
  }

  /** Reads one escape sequence at `i`: how many characters it used, or 0 when it is cut off. */
  private escape(s: string, i: number): number {
    const kind = s[i + 1];
    if (kind === undefined) return 0;
    if (kind === "[") {
      let j = i + 2;
      while (j < s.length && !(s.charCodeAt(j) >= 0x40 && s.charCodeAt(j) <= 0x7e)) j += 1;
      if (j >= s.length) return 0;
      this.csi(s.slice(i + 2, j), s[j]!);
      return j - i + 1;
    }
    if (kind === "]" || kind === "P" || kind === "_" || kind === "^") {
      // A string (a window title, a hyperlink): up to BEL or ESC \, and shown as nothing.
      for (let j = i + 2; j < s.length; j += 1) {
        if (s[j] === "\x07") return j - i + 1;
        if (s[j] === "\x1b") {
          if (j + 1 >= s.length) return 0;
          if (s[j + 1] === "\\") return j - i + 2;
        }
      }
      return 0;
    }
    if (kind === "(" || kind === ")" || kind === "#") return i + 2 < s.length ? 3 : 0;
    return 2;
  }

  private csi(params: string, final: string): void {
    if (params.startsWith("?") || params.startsWith(">") || params.startsWith("=")) return;
    const nums = params.split(";").map((p) => (p === "" ? 0 : Number.parseInt(p, 10) || 0));
    if (final === "m") this.sgr(nums);
    else if (final === "K") {
      const line = this.lines[this.lines.length - 1]!;
      if ((nums[0] ?? 0) === 0) line.length = Math.min(line.length, this.col);
      else if (nums[0] === 2) line.length = 0;
    } else if (final === "J" && (nums[0] === 2 || nums[0] === 3)) {
      this.lines = [[]];
      this.col = 0;
    } else if ((final === "H" || final === "f") && this.lines.length === 1 && this.lines[0]!.length === 0) {
      this.col = 0;
    } else if (final === "G") {
      this.col = Math.min(this.columns - 1, Math.max(0, (nums[0] ?? 1) - 1));
    } else if (final === "D") {
      this.col = Math.max(0, this.col - Math.max(1, nums[0] ?? 1));
    } else if (final === "C") {
      this.col = Math.min(this.columns - 1, this.col + Math.max(1, nums[0] ?? 1));
    }
    // Other moves need a grid this model doesn't keep.
  }

  private sgr(nums: number[]): void {
    const look: Look = { ...this.look };
    for (let k = 0; k < nums.length; k += 1) {
      const n = nums[k]!;
      if (n === 0) for (const key of Object.keys(look) as (keyof Look)[]) delete look[key];
      else if (n === 1) look.bold = true;
      else if (n === 2) look.dim = true;
      else if (n === 3) look.italic = true;
      else if (n === 4) look.underline = true;
      else if (n === 7) look.inverse = true;
      else if (n === 22) {
        delete look.bold;
        delete look.dim;
      } else if (n === 23) delete look.italic;
      else if (n === 24) delete look.underline;
      else if (n === 27) delete look.inverse;
      else if (n === 39) delete look.fg;
      else if ((n >= 30 && n <= 37) || (n >= 90 && n <= 97)) look.fg = HUES[n % 10]!;
      else if (n === 38) {
        if (nums[k + 1] === 5 && nums[k + 2] !== undefined) {
          const c = nums[k + 2]!;
          look.fg = c < 16 ? HUES[c % 8]! : nearestHue(...rgb256(c));
          k += 2;
        } else if (nums[k + 1] === 2 && nums[k + 4] !== undefined) {
          look.fg = nearestHue(nums[k + 2]!, nums[k + 3]!, nums[k + 4]!);
          k += 4;
        }
      } else if (n === 48) {
        // Backgrounds aren't drawn: skip a 256-colour or true-colour one's values.
        k += nums[k + 1] === 5 ? 2 : nums[k + 1] === 2 ? 4 : 0;
      }
    }
    this.look = look;
  }
}

function sameLook(a: Look, b: Look): boolean {
  return a.fg === b.fg && a.bold === b.bold && a.dim === b.dim && a.italic === b.italic && a.underline === b.underline && a.inverse === b.inverse;
}
