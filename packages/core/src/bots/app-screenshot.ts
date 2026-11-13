// `AppScreenshot` (the owner's ask, 14e: "bots should also be able to screenshot tabs, this for when they are designing
// plugins or fixing stuff user tells them, otherwise they have no way to see"): a bot looks at a place in this
// computer's app — a plugin's page, a bot's tab, Plugins, Archive, the coding side — drawn in a render window the user
// never sees (the app's `app.window.render`, render.ts), at the width it asks (wide, narrow or a size), or at the
// user's own window as it is now (`window`, never while Settings shows there). The picture comes back as an image in
// the result and is saved in the bot's scratch (`shots/`); with it, the place's frames (ids and sizes) and, for a
// plugin this bot built, the console errors and warnings its pages wrote while drawing.
//
// For a bot's own sessions (its conversation and side threads), never an agent's; the daemon asks only the app that
// runs on this computer. A read: no card at the default level. Settings is never drawn for a bot, and a card in the
// rendered place is a plain placeholder there, never a live control (the render window's rule).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppRenderResult, AppWindowRenderParams } from "@waifucave/clover-protocol";
import type { CoreToolDef, CoreToolResult } from "../runtime-sdk/turn-loop/servers";
import { botPaths } from "./paths";

export const APP_SCREENSHOT_TOOL = "AppScreenshot";
/** The sizes a bot names: the app's main window as it opens, and under the 900 px rule (narrow). */
export const SCREENSHOT_SIZES = { wide: { width: 1280, height: 820 }, narrow: { width: 860, height: 820 } } as const;
export const SCREENSHOT_MAX = { width: 2560, height: 1640 } as const;
export const SCREENSHOT_MIN = { width: 320, height: 240 } as const;
/** How many frames the text lists. */
const FRAME_LINES = 40;

export interface AppScreenshotDeps {
  /** Clover's home: the bot's scratch is under it. */
  home: string;
  /** Asks this computer's app to draw the place (`app.window.render`). */
  render(params: AppWindowRenderParams): Promise<AppRenderResult>;
  /** The top-level ids of the plugins this bot built (their console lines are its to read). */
  ownPlugins(bot: string): readonly string[];
  now?(): Date;
}

export interface ScreenshotCaller {
  bot: string;
}

type Size = { width: number; height: number };

/** The size asked, or why it isn't one. */
export function screenshotSize(raw: unknown): { size: Size; name: string } | { refused: string } {
  if (raw === undefined || raw === "wide") return { size: SCREENSHOT_SIZES.wide, name: "wide" };
  if (raw === "narrow") return { size: SCREENSHOT_SIZES.narrow, name: "narrow" };
  if (raw !== null && typeof raw === "object") {
    const { width, height } = raw as { width?: unknown; height?: unknown };
    const ok = (v: unknown, min: number, max: number) => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
    if (ok(width, SCREENSHOT_MIN.width, SCREENSHOT_MAX.width) && ok(height, SCREENSHOT_MIN.height, SCREENSHOT_MAX.height)) return { size: { width: width as number, height: height as number }, name: `${width as number}x${height as number}` };
  }
  return { refused: `size is "wide" (1280x820), "narrow" (860x820) or { width, height } from ${SCREENSHOT_MIN.width}x${SCREENSHOT_MIN.height} to ${SCREENSHOT_MAX.width}x${SCREENSHOT_MAX.height}` };
}

const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
const slug = (target: string) => target.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "place";

/** The tool for one bot session. */
export function appScreenshotToolDef(deps: AppScreenshotDeps, caller: ScreenshotCaller): CoreToolDef {
  const fail = (text: string): CoreToolResult => ({ text, isError: true });
  return {
    name: APP_SCREENSHOT_TOOL,
    description: [
      "See what a place in Clover's app looks like: a picture of it, drawn in a hidden window the user never sees, so",
      "their own window stays where it is. Use it after you build or change a plugin's page (look at it wide and narrow),",
      "and when the user says something looks wrong. Targets: `app:<plugin id or page key>` (a plugin's page), `bot:<id>`",
      "(a bot's tab), `plugins`, `archive`, `code` (the coding side), or `window` (the user's own window as it is now;",
      "refused while Settings shows there). Settings is never drawn. `size` is \"wide\" (1280x820, the default),",
      "\"narrow\" (860x820, where the app's 900 px rule folds a layout) or { width, height } up to 2560x1640. The picture",
      "is saved in your scratch folder under shots/ and comes back as an image, with the place's frames (origin, mount,",
      "size) and, for a plugin you built, the console errors and warnings its pages wrote while it drew. A plugin's page",
      "drawn here mounts again, so what it does when it opens runs again; a card waiting there shows as a plain",
      "placeholder.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "app:<plugin id or page key>, bot:<id>, plugins, archive, code, or window." },
        size: {
          description: "\"wide\" (1280x820, default), \"narrow\" (860x820), or { width, height } in pixels, up to 2560x1640. Not used for `window`.",
          anyOf: [
            { type: "string", enum: ["wide", "narrow"] },
            { type: "object", properties: { width: { type: "integer" }, height: { type: "integer" } }, required: ["width", "height"], additionalProperties: false },
          ],
        },
      },
      required: ["target"],
      additionalProperties: false,
    },
    run: async (input) => {
      const o = (input !== null && typeof input === "object" ? input : {}) as { target?: unknown; size?: unknown };
      const target = typeof o.target === "string" ? o.target.trim() : "";
      if (target === "" || target.length > 200 || !/^[A-Za-z0-9._:#/-]+$/.test(target)) return fail("AppScreenshot needs `target`: app:<plugin id or page key>, bot:<id>, plugins, archive, code, or window.");
      if (target === "settings" || target.startsWith("settings:")) return fail("Settings isn't drawn for a bot.");
      const sized = screenshotSize(o.size);
      if ("refused" in sized) return fail(`AppScreenshot: ${sized.refused}.`);
      let r: AppRenderResult;
      try {
        r = await deps.render({ target, size: sized.size, frames: true });
      } catch (err) {
        return fail(`Couldn't draw ${target}: ${(err instanceof Error ? err.message : String(err)).slice(0, 500)}`);
      }
      const lines: string[] = [];
      const own = new Set(deps.ownPlugins(caller.bot).map((id) => id.split("/")[0]!));
      const consoleLines = (r.console ?? []).filter((c) => own.has(c.plugin.split("/")[0]!));
      const otherLines = (r.console ?? []).length - consoleLines.length;
      const where = r.where === undefined ? undefined : `${r.where.tab.kind}${r.where.tab.id !== undefined ? ` ${r.where.tab.id}` : ""}`;
      if (!r.shown || r.png === undefined) {
        lines.push(`${target} wasn't drawn: ${r.reason ?? r.note ?? "nothing came back"}.${where !== undefined ? ` The window showed ${where}.` : ""}`);
        if (consoleLines.length > 0) lines.push("Console lines from your plugin while it tried:", ...consoleLines.map((c) => `${c.level}: [${c.plugin}] ${c.message}`));
        return { text: lines.join("\n"), isError: true };
      }
      const dir = join(botPaths(deps.home, caller.bot).scratch, "shots");
      const file = join(dir, `${slug(target)}-${target === "window" ? "window" : sized.name}-${stamp(deps.now?.() ?? new Date())}.png`);
      let saved: string | undefined;
      try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(file, Buffer.from(r.png, "base64"));
        saved = file;
      } catch (err) {
        lines.push(`(The picture couldn't be saved: ${err instanceof Error ? err.message : String(err)}.)`);
      }
      const px = r.pixels !== undefined ? `${r.pixels.width}x${r.pixels.height}` : "?";
      lines.push(target === "window"
        ? `The user's window as it is now${where !== undefined ? ` (${where})` : ""}: ${px} pixels.`
        : `${target} drawn at ${r.size.width}x${r.size.height} (${sized.name})${where !== undefined ? `, showing ${where}` : ""}: ${px} pixels.`);
      if (saved !== undefined) lines.push(`Saved: ${saved}`);
      if (r.preview !== undefined) lines.push(`The image here is a smaller copy (${r.preview.width}x${r.preview.height}); the saved file is full size.`);
      if (r.frames !== undefined && r.frames.length > 0) {
        lines.push(`Frames (${r.frames.length}):`);
        for (const f of r.frames.slice(0, FRAME_LINES)) lines.push(`- ${f.sealed === "placeholder" ? "card placeholder" : f.sealed === "card" ? "live card frame" : f.origin}${f.mount !== undefined ? ` mount ${f.mount}` : ""}${f.width !== undefined ? ` ${f.width}x${f.height ?? 0}` : f.silent ? " (didn't answer)" : ""}${f.visibility !== undefined && f.visibility !== "visible" ? ` ${f.visibility}` : ""}`);
      }
      // A card waiting in the place is drawn as a plain placeholder there, never its live buttons (the render window's
      // rule): said with the count, so the picture's boxes read as what they are.
      const sealed = (r.frames ?? []).filter((f) => f.sealed !== undefined);
      if (sealed.length > 0) {
        const held = sealed.filter((f) => f.sealed === "placeholder").length;
        lines.push(`Card frames: ${held} placeholder(s)${sealed.length > held ? `, ${sealed.length - held} other` : ""} (a card waiting here is drawn as a plain box, not its buttons).`);
      }
      if (consoleLines.length > 0) lines.push(`Console lines from your plugin (${consoleLines.length}):`, ...consoleLines.map((c) => `${c.level}: [${c.plugin}] ${c.message}`));
      else if (own.size > 0 && target.startsWith("app:")) lines.push("No console errors or warnings from your plugin while it drew.");
      if (otherLines > 0) lines.push(`(${otherLines} console line(s) from plugins you didn't build left out.)`);
      const image = r.preview ?? { png: r.png };
      return { text: lines.join("\n"), isError: false, images: [{ data: image.png, mimeType: "image/png" }] };
    },
  };
}
