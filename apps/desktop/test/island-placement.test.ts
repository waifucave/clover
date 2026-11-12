// Where macOS puts the island's window (the owner's try 12b: its top edge sat at the bottom of the menu bar). A background-only
// Electron makes the window the way the app does (the plan from `surfaceWindowPlan`, opacity 0 and deaf to the mouse so nothing
// is seen), asks for the top edge of the display, and reads the bounds back: macOS must not have pushed it down.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { surfaceWindowPlan, webPreferences } from "../src/main/window";

const localElectron = process.env.CLOVER_UI_LOCAL_ELECTRON;
const enabled = process.platform === "darwin" && localElectron !== undefined && localElectron !== "";
const dirs: string[] = [];
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function refuseForegroundElectron(): void {
  const plist = join(dirname(dirname(localElectron!)), "Info.plist");
  const value = spawnSync("plutil", ["-extract", "LSBackgroundOnly", "raw", plist], { encoding: "utf8" });
  if (value.status !== 0 || value.stdout.trim() !== "true") throw new Error("CLOVER_UI_LOCAL_ELECTRON is not a background-only Electron");
}

function readBack(withOption: boolean): { display: { bounds: { y: number; height: number }; workArea: { y: number } }; y: number; height: number } {
  refuseForegroundElectron();
  const dir = mkdtempSync(join(tmpdir(), "clv-island-place-"));
  dirs.push(dir);
  const plan = surfaceWindowPlan({ surface: { type: "overlay", alwaysOnTop: true, transparent: true }, title: "island", webPreferences: webPreferences({ preload: "/none.cjs", partition: "persist:ui", headless: true, offscreen: false }), platform: "darwin" });
  const { webPreferences: _prefs, ...options } = plan;
  void _prefs;
  if (!withOption) delete (options as Record<string, unknown>).enableLargerThanScreen;
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "p", main: "main.js" }));
  writeFileSync(join(dir, "main.js"), `
const { app, BrowserWindow, screen } = require("electron");
app.dock?.hide();
app.on("window-all-closed", () => {});
app.whenReady().then(async () => {
  const d = screen.getPrimaryDisplay();
  const w = new BrowserWindow(${JSON.stringify(options)});
  w.setAlwaysOnTop(true, "status");
  w.setOpacity(0);
  w.setIgnoreMouseEvents(true);
  const width = 400, height = 164;
  w.setBounds({ x: Math.round(d.bounds.x + (d.bounds.width - width) / 2), y: d.bounds.y, width, height });
  w.showInactive();
  await new Promise((r) => setTimeout(r, 500));
  w.setBounds({ x: w.getBounds().x, y: d.bounds.y, width, height });
  await new Promise((r) => setTimeout(r, 300));
  console.log("READBACK " + JSON.stringify({ display: { bounds: d.bounds, workArea: d.workArea }, y: w.getBounds().y, height: w.getBounds().height }));
  app.exit(0);
});
`);
  const run = spawnSync(localElectron!, [dir], { encoding: "utf8", timeout: 60_000 });
  const line = `${run.stdout}${run.stderr}`.split("\n").find((l) => l.startsWith("READBACK "));
  if (line === undefined) throw new Error(`no read-back: ${run.stdout}${run.stderr}`.slice(0, 600));
  return JSON.parse(line.slice("READBACK ".length));
}

describe.if(enabled)("the island's window on macOS", () => {
  test("hangs from the very top edge of the display, not below the menu bar", () => {
    const r = readBack(true);
    console.log(`island window read back: ${JSON.stringify(r)}`);
    expect(r.y, JSON.stringify(r)).toBe(r.display.bounds.y);
  }, 90_000);
  test("without the plan's option macOS pushes it below the menu bar (the bug this guards)", () => {
    const r = readBack(false);
    console.log(`without the option: ${JSON.stringify(r)}`);
    // A display with no menu bar inset has nothing to push against; then the two readings agree.
    if (r.display.workArea.y > r.display.bounds.y) expect(r.y).toBe(r.display.workArea.y);
  }, 90_000);
});
