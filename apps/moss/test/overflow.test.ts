// No page of MOSS overflows sideways at any supported width (lane MT: the bot's Settings page showed a horizontal bar on
// GitHub's macOS runner, which draws classic, always-visible scroll bars, and its Archive button sat under it). MOSS is
// drawn in a real Electron, offscreen, against the fake engine (scripts/render.ts, in its layout mode: every scene of the
// renders, at the usual width, 1000, 901 (one past the narrow layout), the narrow width and the window's minimum), with
// classic scroll bars styled onto that one page (a ::-webkit-scrollbar rule; never a system setting), and measures that
// the page and every scroll container has scrollWidth <= clientWidth.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const ci = process.env.CI === "true" && process.env.MOSS_UI_TESTS === "1";
const localElectron = process.env.MOSS_UI_LOCAL_ELECTRON;
const enabled = ci || (localElectron !== undefined && localElectron !== "");

interface Measured { scene: string; size: string; error?: string; over: { el: string; scrollWidth: number; clientWidth: number; wide: string[] }[]; page: { scrollWidth: number; clientWidth: number } }

describe.skipIf(!enabled)("MOSS never overflows sideways (real Electron, offscreen, classic scroll bars)", () => {
  test("every page, the side panel and the new-bot form at the usual, medium, narrow and minimum widths", () => {
    const dir = mkdtempSync(join(tmpdir(), "moss-overflow-"));
    try {
      const env: NodeJS.ProcessEnv = { ...process.env, MOSS_RENDER_MEASURE: "1" };
      delete env.ELECTRON_RUN_AS_NODE;
      const r = spawnSync(process.execPath, ["run", "scripts/render.ts", dir], { cwd: root, env, encoding: "utf8", timeout: 280_000 });
      expect(existsSync(join(dir, "measure.json")), `${r.stdout ?? ""}${r.stderr ?? ""}`.slice(-3000)).toBe(true);
      const got = JSON.parse(readFileSync(join(dir, "measure.json"), "utf8")) as Measured[];
      const sizes = ["usual", "w1000", "w901", "narrow", "w640"];
      // Every scene at every width was measured (the Plugins page, both Settings pages and a bot's memory, the side panel with a
      // routine edited, and the new-bot form are scenes).
      const scenes = [...new Set(got.map((m) => m.scene))];
      expect(got.length).toBe(scenes.length * sizes.length);
      for (const name of ["ma2-plugins", "ma2-settings-account", "ma2-settings-bot", "memory", "ma2-panel", "routine-edit", "new-bot"]) {
        for (const size of sizes) expect(got.some((m) => m.scene === name && m.size === size), `${name} at ${size}`).toBe(true);
      }
      const bad = got.flatMap((m) => [
        ...(m.error !== undefined ? [`${m.scene} at ${m.size}: ${m.error}`] : []),
        ...m.over.map((o) => `${m.scene} at ${m.size}: ${o.el} scrolls sideways (${o.scrollWidth} > ${o.clientWidth}; too wide: ${o.wide.join(", ")})`),
        ...(m.page.scrollWidth > m.page.clientWidth ? [`${m.scene} at ${m.size}: the page is wider than its window (${m.page.scrollWidth} > ${m.page.clientWidth})`] : []),
      ]);
      expect(bad).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 300_000);
});
