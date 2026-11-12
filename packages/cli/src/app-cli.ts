// `clover-core app screenshot` and `clover-core app frames`: what this computer's app draws, for the user at a terminal
// (the owner's ask for 14d, so whoever helps him can see the app without being sent screenshots). The daemon asks the
// app (`app.capture` → `app.window.capture`), whose main process takes Electron's own picture of each window's page,
// never the screen: no Screen Recording permission, no prompt, and no window shown, raised, focused or resized.
//
//   clover-core app screenshot [--window main|island|pill|all] --out <dir> [--frames]
//   clover-core app frames [--window …]            (the frame list alone, no pictures)
//
// One PNG per window drawn, `<dir>/<window>.png`; then JSON on stdout: each window's name, bounds, display scale,
// whether it is visible, whether it was drawn (a hidden or minimised window is "not drawn", with no file), the file,
// and with `--frames` each document's origin, mount, size and visibility (ids and sizes only, no page text).
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AppCaptureResult, CapturedWindow } from "@waifucave/clover-protocol";

export const APP_USAGE = "usage: clover-core app screenshot [--window main|island|pill|all] --out <dir> [--frames]\n       clover-core app frames [--window main|island|pill|all]";

export interface AppCliDeps {
  request(method: "app.capture", params: { window: string; image?: boolean; frames?: boolean }): Promise<AppCaptureResult>;
  writeFile?(path: string, bytes: Uint8Array): void;
  mkdir?(path: string): void;
  log(line: string): void;
  error(line: string): void;
}

export interface AppArgs { sub: "screenshot" | "frames"; window: string; out?: string; frames: boolean }

/** The command's words after `app`; a string is the problem with them. */
export function parseAppArgs(argv: readonly string[]): AppArgs | string {
  const [sub, ...rest] = argv;
  if (sub !== "screenshot" && sub !== "frames") return APP_USAGE;
  let window = "main";
  let out: string | undefined;
  let frames = sub === "frames";
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--frames") frames = true;
    else if (a === "--window" || a === "--out") {
      const v = rest[++i];
      if (v === undefined || v.startsWith("--")) return `${a} takes a value\n${APP_USAGE}`;
      if (a === "--window") window = v; else out = v;
    } else return `unknown argument ${a}\n${APP_USAGE}`;
  }
  if (!/^[A-Za-z0-9._#/-]{1,128}$/.test(window)) return `--window takes main, island, pill, another window's name, or all\n${APP_USAGE}`;
  if (sub === "screenshot" && out === undefined) return `screenshot needs --out <dir>, the folder its PNGs go in\n${APP_USAGE}`;
  if (sub === "frames" && out !== undefined) return `frames takes no --out (it draws no pictures; screenshot --frames does both)\n${APP_USAGE}`;
  return { sub, window, ...(out !== undefined ? { out } : {}), frames };
}

/** What the command prints for one window. */
export interface WindowLine {
  name: string;
  bounds: CapturedWindow["bounds"];
  scale: number;
  visible: boolean;
  drawn: boolean;
  file?: string;
  pixels?: { width: number; height: number };
  reduced?: true;
  note?: string;
  views: CapturedWindow["views"];
  frames?: CapturedWindow["frames"];
}

/** Runs the command; its exit code. */
export async function runApp(argv: readonly string[], deps: AppCliDeps): Promise<number> {
  const args = parseAppArgs(argv);
  if (typeof args === "string") { deps.error(args); return 2; }
  const write = deps.writeFile ?? ((p, b) => writeFileSync(p, b));
  const mkdir = deps.mkdir ?? ((p) => mkdirSync(p, { recursive: true }));
  const pictures = args.sub === "screenshot";
  const out = args.out !== undefined ? resolve(args.out) : undefined;
  try {
    // `all`: the list first (no pictures), then each window on its own, so every answer stays one message.
    const names = args.window === "all" ? (await deps.request("app.capture", { window: "all" })).windows.map((w) => w.name) : [args.window];
    if (out !== undefined) mkdir(out);
    const lines: WindowLine[] = [];
    for (const name of names) {
      const r = await deps.request("app.capture", { window: name, ...(pictures ? {} : { image: false }), ...(args.frames ? { frames: true } : {}) });
      for (const w of r.windows) {
        let file: string | undefined;
        if (pictures && w.png !== undefined && out !== undefined) {
          file = join(out, `${w.name.replace(/[^A-Za-z0-9._-]/g, "_")}.png`);
          write(file, Buffer.from(w.png, "base64"));
        }
        lines.push({
          name: w.name, bounds: w.bounds, scale: w.scale, visible: w.visible, drawn: w.drawn,
          ...(file !== undefined ? { file } : {}),
          ...(w.pixels !== undefined && file !== undefined ? { pixels: w.pixels } : {}),
          ...(w.reduced === true ? { reduced: true as const } : {}),
          ...(w.note !== undefined ? { note: w.note } : !w.drawn ? { note: "not drawn" } : {}),
          views: w.views,
          ...(w.frames !== undefined ? { frames: w.frames } : {}),
        });
      }
    }
    deps.log(JSON.stringify({ windows: lines }, null, 2));
    return 0;
  } catch (err) {
    deps.error(`app ${args.sub}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
