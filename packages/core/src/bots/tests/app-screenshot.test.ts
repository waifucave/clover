// `AppScreenshot` (bots/app-screenshot.ts): a bot asks this computer's app to draw a place; the picture is saved in its
// scratch's shots/ and comes back as an image the model sees (the core tools' server passes `images` on as MCP image
// items), with the place's frames and the console lines of a plugin the bot built (never another's). Settings is never
// asked for; a bad size is refused before the app is asked; a place that didn't draw is an error that says why. A read
// at the default level (no card).
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppRenderResult, AppWindowRenderParams } from "@waifucave/clover-protocol";
import type { WinterMcpServerInstance } from "@waifucave/clover-agent-sdk";
import { CORE_TOOL_RULES } from "../../approvals/bot-check";
import { coreToolsServer } from "../../runtime-sdk/turn-loop/servers";
import { APP_SCREENSHOT_TOOL, appScreenshotToolDef, screenshotSize, type AppScreenshotDeps } from "../app-screenshot";
import { botPaths } from "../paths";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64").toString("base64");
const homes: string[] = [];
afterEach(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });

function setup(answer: (p: AppWindowRenderParams) => AppRenderResult | Promise<AppRenderResult>) {
  const home = mkdtempSync(join(tmpdir(), "clover-shot-"));
  homes.push(home);
  const asked: AppWindowRenderParams[] = [];
  const deps: AppScreenshotDeps = {
    home,
    render: async (p) => { asked.push(p); return answer(p); },
    ownPlugins: (bot) => (bot === "alpha" ? ["reel"] : []),
    now: () => new Date("2026-11-13T01:02:03Z"),
  };
  return { home, asked, tool: appScreenshotToolDef(deps, { bot: "alpha" }) };
}

const drawn = (p: AppWindowRenderParams, extra: Partial<AppRenderResult> = {}): AppRenderResult => ({
  target: p.target, size: p.size, shown: true, drawn: true, png: PNG, pixels: p.size,
  where: { tab: { kind: "app", id: "reel" }, side: "bots" },
  frames: [{ origin: "clover-core://app", width: p.size.width, height: p.size.height, visibility: "visible" }, { origin: "clover-plugin://reel", mount: "m1", width: 1000, height: 820, visibility: "visible" }],
  console: [{ plugin: "reel", level: "error", message: "TypeError: track is undefined" }, { plugin: "clover", level: "warning", message: "the shell's own" }],
  ...extra,
});

describe("AppScreenshot", () => {
  test("a plugin's page, wide: asked of the app, saved under shots/, the picture as an image, frames and the bot's own plugin's console", async () => {
    const s = setup((p) => drawn(p));
    const r = await s.tool.run({ target: "app:reel" });
    expect(s.asked).toEqual([{ target: "app:reel", size: { width: 1280, height: 820 }, frames: true }]);
    expect(r.isError).toBe(false);
    const file = join(botPaths(s.home, "alpha").scratch, "shots", "app-reel-wide-20261113-010203.png");
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file).toString("base64")).toBe(PNG);
    expect(r.images).toEqual([{ data: PNG, mimeType: "image/png" }]);
    expect(r.text).toContain("app:reel drawn at 1280x820 (wide), showing app reel: 1280x820 pixels.");
    expect(r.text).toContain(`Saved: ${file}`);
    expect(r.text).toContain("- clover-plugin://reel mount m1 1000x820");
    expect(r.text).toContain("error: [reel] TypeError: track is undefined");
    expect(r.text).not.toContain("the shell's own");
    expect(r.text).toContain("(1 console line(s) from plugins you didn't build left out.)");
  });

  test("narrow and a size of its own; a size out of bounds is refused before the app is asked", async () => {
    const s = setup((p) => drawn(p));
    await s.tool.run({ target: "bot:alpha", size: "narrow" });
    await s.tool.run({ target: "plugins", size: { width: 2560, height: 1640 } });
    expect(s.asked.map((a) => a.size)).toEqual([{ width: 860, height: 820 }, { width: 2560, height: 1640 }]);
    for (const size of [{ width: 4000, height: 800 }, { width: 100, height: 100 }, "huge", { width: 1280.5, height: 820 }]) {
      const r = await s.tool.run({ target: "plugins", size });
      expect({ size, isError: r.isError, text: r.text.slice(0, 30) }).toEqual({ size, isError: true, text: "AppScreenshot: size is \"wide\" " });
    }
    expect(s.asked.length).toBe(2);
    expect(screenshotSize(undefined)).toEqual({ size: { width: 1280, height: 820 }, name: "wide" });
  });

  test("Settings is never asked for, and a bad target is refused", async () => {
    const s = setup((p) => drawn(p));
    for (const target of ["settings", "settings:devices"]) expect(await s.tool.run({ target })).toEqual({ text: "Settings isn't drawn for a bot.", isError: true });
    for (const input of [{}, { target: "" }, { target: "a b" }]) expect((await s.tool.run(input)).isError).toBe(true);
    expect(s.asked).toEqual([]);
  });

  test("a large picture: the model gets the smaller copy, the file is full size", async () => {
    const s = setup((p) => drawn(p, { preview: { png: "c21hbGw=", width: 1568, height: 1005 } }));
    const r = await s.tool.run({ target: "app:reel", size: { width: 2560, height: 1640 } });
    expect(r.images).toEqual([{ data: "c21hbGw=", mimeType: "image/png" }]);
    expect(r.text).toContain("The image here is a smaller copy (1568x1005); the saved file is full size.");
  });

  test("a place that didn't draw is an error with the app's reason; one the app can't answer says so", async () => {
    const s = setup((p) => ({ target: p.target, size: p.size, shown: false, drawn: false, reason: "the page reel didn't show within 20 s", console: [{ plugin: "reel", level: "error", message: "boom" }] }));
    const r = await s.tool.run({ target: "app:reel" });
    expect(r).toMatchObject({ isError: true });
    expect(r.text).toBe("app:reel wasn't drawn: the page reel didn't show within 20 s.\nConsole lines from your plugin while it tried:\nerror: [reel] boom");
    expect(r.images).toBeUndefined();
    const t = setup(() => { throw new Error("the app isn't running on this computer"); });
    expect(await t.tool.run({ target: "plugins" })).toEqual({ text: "Couldn't draw plugins: the app isn't running on this computer", isError: true });
  });

  test("window: the user's own window, named so", async () => {
    const s = setup((p) => drawn(p, { where: { tab: { kind: "bot", id: "alpha" } }, console: [] }));
    const r = await s.tool.run({ target: "window", size: "narrow" });
    expect(r.text.split("\n")[0]).toBe("The user's window as it is now (bot alpha): 860x820 pixels.");
    expect(existsSync(join(botPaths(s.home, "alpha").scratch, "shots", "window-window-20261113-010203.png"))).toBe(true);
  });

  test("a card waiting in the place: its frames are counted as placeholders", async () => {
    const s = setup((p) => drawn(p, { frames: [{ origin: "clover-plugin://clover", width: 900, height: 820 }, { origin: "null", width: 80, height: 30, sealed: "placeholder" }, { origin: "null", width: 300, height: 40, sealed: "placeholder" }] }));
    const r = await s.tool.run({ target: "bot:alpha" });
    expect(r.text).toContain("Card frames: 2 placeholder(s) (a card waiting here is drawn as a plain box, not its buttons).");
    expect(r.text).toContain("- card placeholder 80x30");
    // The user's own window: its live frames are said so.
    const w = setup((p) => drawn(p, { frames: [{ origin: "null", width: 80, height: 30, sealed: "card" }, { origin: "null", width: 80, height: 30, sealed: "placeholder" }] }));
    const t = await w.tool.run({ target: "window" });
    expect(t.text).toContain("- live card frame 80x30");
    expect(t.text).toContain("Card frames: 1 placeholder(s), 1 other");
  });

  test("a read at the default level: no card", () => {
    expect(CORE_TOOL_RULES.get(APP_SCREENSHOT_TOOL)).toBe("read");
  });

  test("the core tools' server passes a result's images on as MCP image items after the text", async () => {
    const s = setup((p) => drawn(p));
    const server = coreToolsServer(() => [s.tool]);
    const out = await (server.instance as WinterMcpServerInstance).callTool(APP_SCREENSHOT_TOOL, { target: "app:reel" }) as { content: { type: string; data?: string; mimeType?: string; text?: string }[]; isError: boolean };
    expect(out.content.map((c) => c.type)).toEqual(["text", "image"]);
    expect(out.content[1]).toEqual({ type: "image", data: PNG, mimeType: "image/png" });
    expect(out.content[0]!.text).not.toContain(PNG);
    // An item that isn't an image, or isn't base64, is left out.
    const bad = coreToolsServer(() => [{ name: "X", description: "", inputSchema: {}, run: async () => ({ text: "t", isError: false, images: [{ data: "<svg>", mimeType: "image/png" }, { data: "AAAA", mimeType: "text/html" }] }) }]);
    expect(((await (bad.instance as WinterMcpServerInstance).callTool("X", {})) as { content: unknown[] }).content).toEqual([{ type: "text", text: "t" }]);
  });
});
