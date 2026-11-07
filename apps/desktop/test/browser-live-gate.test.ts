// The browser's live gate (`scripts/browser-live-gate.ts`) is run by the owner and never here; this tests what can be:
// the checklist's shape, its doc, the refusals, the recording, and that the two programs it starts still build.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { newRun, parseAnswer, record, refusal, renderChecklist, SECTIONS, STEPS, stepsFor, summarize } from "../scripts/browser-live-gate-lib";
import { BROWSER_ASSETS } from "../src/main/browser/assets";

const root = join(import.meta.dir, "..");

describe("the browser's live gate", () => {
  test("every step has a unique id, a section, an OS, instructions and a pass condition", () => {
    expect(new Set(STEPS.map((s) => s.id)).size).toBe(STEPS.length);
    for (const s of STEPS) {
      expect(Object.keys(SECTIONS)).toContain(s.section);
      expect(s.os.length).toBeGreaterThan(0);
      expect(s.do.length).toBeGreaterThan(0);
      expect(s.expect.length).toBeGreaterThan(10);
    }
  });

  test("it covers what the plan lists: macOS, Windows scaling, Wayland, the companion, the proxy and a server", () => {
    const ids = STEPS.map((s) => s.id).join(" ");
    for (const part of ["mac-viewport-roundtrip", "mac-ime", "mac-trackpad", "mac-display", "mac-voiceover", "mac-select-copy", "win-scale", "win-ime", "win-reader", "wl-no-window", "wl-host-pixel", "wl-orca", "comp-stream", "proxy-explicit", "proxy-pac", "server-install"]) {
      expect(ids).toContain(part);
    }
  });

  test("a machine takes its own OS's steps and the any-OS ones", () => {
    const mac = stepsFor("darwin").map((s) => s.section);
    expect(mac).toContain("macos");
    expect(mac).not.toContain("windows");
    expect(stepsFor("win32").some((s) => s.id === "win-scale")).toBe(true);
    expect(stepsFor("linux", { section: "linux-wayland" }).length).toBe(3);
    expect(stepsFor("darwin", { all: true }).length).toBe(STEPS.length);
  });

  test("docs/live-gates/browser.md is the list as the script writes it", () => {
    expect(readFileSync(join(root, "..", "..", "docs", "live-gates", "browser.md"), "utf8")).toBe(renderChecklist());
  });

  test("it won't run in CI, under an agent or without a terminal", () => {
    expect(refusal({ CI: "true" }, true)).toMatch(/CI/);
    expect(refusal({ CLAUDECODE: "1" }, true)).toMatch(/agent/);
    expect(refusal({ CLOVER_AGENT: "1" }, true)).toMatch(/agent/);
    expect(refusal({}, false)).toMatch(/terminal/);
    expect(refusal({ CI: "false" }, true)).toBeUndefined();
    expect(refusal({}, true)).toBeUndefined();
  });

  test("answers are recorded to JSON, a later answer replacing an earlier one", () => {
    let run = newRun({ platform: "darwin", arch: "arm64", electron: "45.2.3" }, new Date("2026-11-07T10:00:00Z"));
    run = record(run, STEPS[0]!, "fail", { note: "flashed", auto: { sameDocumentEveryTime: true } }, new Date("2026-11-07T10:01:00Z"));
    run = record(run, STEPS[1]!, "skip", {}, new Date("2026-11-07T10:02:00Z"));
    run = record(run, STEPS[0]!, "pass", {}, new Date("2026-11-07T10:03:00Z"));
    expect(run.steps.map((s) => [s.id, s.answer])).toEqual([[STEPS[1]!.id, "skip"], [STEPS[0]!.id, "pass"]]);
    expect(summarize(run)).toEqual({ pass: 1, fail: 0, skip: 1 });
    expect(JSON.parse(JSON.stringify(run))).toEqual(run);
    expect(parseAnswer("P")).toBe("pass");
    expect(parseAnswer("no")).toBe("fail");
    expect(parseAnswer("")).toBe("skip");
    expect(parseAnswer("maybe")).toBeUndefined();
  });

  test("the script's refusal holds when it is run here (no terminal)", () => {
    const r = Bun.spawnSync(["bun", "run", join(root, "scripts", "browser-live-gate.ts")], { env: { ...process.env, CI: "" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toMatch(/browser-live-gate:/);
  });

  test("the app it starts, and the viewport it uses, build", async () => {
    const main = await Bun.build({ entrypoints: [join(root, "scripts", "browser-live-main.ts")], target: "node", format: "esm", external: ["electron"], write: false });
    expect(main.success, main.logs.map(String).join("\n")).toBe(true);
    const preload = await Bun.build({ entrypoints: [join(root, BROWSER_ASSETS.preload.entry)], target: "node", format: "cjs", external: ["electron"], write: false });
    expect(preload.success).toBe(true);
  });
});
