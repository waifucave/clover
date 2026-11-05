// The whole gallery, as CI renders it: built with one React for every part (as the screenshot job
// builds it, but in development mode so React's warnings show), then run under happy-dom. Every
// story must mount, none may fail, and nothing may log an error.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGallery } from "../gallery/build";
import { CATALOG_SNAPSHOT } from "../gallery/catalog";
import { screenStories } from "../gallery/screens";
import { stories as composerStories } from "../../composer/gallery/stories";
import { stories as conversationStories } from "../../conversation/gallery/stories";
import { diffStories } from "../../panel-diff/gallery/stories";
import { filesStories } from "../../panel-files/gallery/stories";
import { terminalStories } from "../../panel-terminal/gallery/stories";
import { panelStories } from "../../panel/gallery/stories";
import { settingsStories } from "../../settings/gallery/stories";
import { stories as sidebarStories } from "../../sidebar/gallery/stories";
import * as composerTokens from "../../composer/client/tokens";
import * as conversationTokens from "../../conversation/client/tokens";
import * as diffTokens from "../../panel-diff/client/tokens";
import * as filesTokens from "../../panel-files/client/tokens";
import * as terminalTokens from "../../panel-terminal/client/tokens";
import * as panelTokens from "../../panel/client/tokens";
import * as settingsTokens from "../../settings/client/tokens";
import * as sidebarTokens from "../../sidebar/client/tokens";
import * as shellTokens from "../client/tokens";

const outdir = mkdtempSync(join(tmpdir(), "lane-f-gallery-"));
const errors: string[] = [];
let root: HTMLElement | undefined;

async function until(check: () => boolean, ms = 10_000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("the gallery did not finish rendering");
    await new Promise((r) => setTimeout(r, 20));
  }
}

beforeAll(async () => {
  await buildGallery(outdir, { production: false });
  root = document.createElement("div");
  root.id = "root";
  document.body.append(root);
  const original = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
  try {
    (0, eval)(readFileSync(join(outdir, "main.js"), "utf8"));
    await until(() => root!.querySelector("[data-gallery-ready]") !== null);
  } finally {
    console.error = original;
  }
});

// Every test file shares one document: take the gallery out of it, so no other file finds it.
afterAll(() => {
  root?.remove();
  document.documentElement.removeAttribute("data-theme");
  rmSync(outdir, { recursive: true, force: true });
});

describe("the gallery", () => {
  const all = [
    ...screenStories, ...conversationStories, ...composerStories, ...sidebarStories, ...panelStories,
    ...terminalStories, ...diffStories, ...filesStories, ...settingsStories,
  ];

  test("builds a page, a script and a stylesheet", () => {
    const html = readFileSync(join(outdir, "index.html"), "utf8");
    expect(html).toContain('<script src="main.js" defer></script>');
    expect(readFileSync(join(outdir, "main.css"), "utf8")).toContain(".cl-conv-approval__card");
  });

  test("shows every story of every part, ids unique", () => {
    const shown = [...root!.querySelectorAll("[data-story]")].map((s) => s.getAttribute("data-story"));
    expect(shown).toEqual(all.map((s) => s.id));
    expect(new Set(shown).size).toBe(shown.length);
  });

  test("no story failed, and nothing logged an error", () => {
    expect([...root!.querySelectorAll("[data-story-error]")].map((e) => e.getAttribute("data-story-error"))).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("every whole-window screen holds the sidebar, the toggles, the conversation and the composer", () => {
    expect(screenStories.length).toBe(24);
    expect(screenStories.filter((s) => s.width === 1512 && s.height === 950)).toHaveLength(2);
    for (const story of screenStories) {
      const frame = root!.querySelector(`[data-story="${story.id}"]`);
      expect(frame?.querySelector(".cl-window .cl-sidebar")).toBeTruthy();
      expect(frame?.querySelector(".cl-window__toggles .cl-panel-toggles")).toBeTruthy();
      expect(frame?.querySelector(".cl-window__content .cl-conv")).toBeTruthy();
      expect(frame?.querySelector(".cl-window__content .cl-composer")).toBeTruthy();
    }
  });

  test("each panel screen shows its panel; two-panels shows two; the dialogs and the card are there", () => {
    const frame = (id: string) => root!.querySelector(`[data-story="screen/${id}-1440"]`)!;
    expect(frame("terminal").querySelector(".cl-panel .cl-term")).toBeTruthy();
    expect(frame("diff").querySelector(".cl-panel .cl-diff")).toBeTruthy();
    // The browser panel is lane L's: the host's placeholder holds its place.
    expect(frame("browser").querySelector('.cl-panel [data-empty-view="browser"]')).toBeTruthy();
    expect(frame("files").querySelector(".cl-panel .cl-files")).toBeTruthy();
    expect(frame("two-panels").querySelectorAll(".cl-panel__view")).toHaveLength(2);
    expect(frame("code").querySelector(".cl-window__side .cl-session")).toBeTruthy();
    expect(frame("settings").querySelector(".cl-window__dialog .cl-settings")).toBeTruthy();
    expect(frame("languages").querySelector(".cl-window__dialog .cl-languages")).toBeTruthy();
    // Settings asked for while a card waits: no dialog, and the bar says why.
    const held = frame("settings-pending-card");
    expect(held.querySelector(".cl-window__dialog")).toBeNull();
    expect(held.querySelector(".cl-window__note")?.textContent).toBe("Answer the waiting card first, then open it again.");
    expect(held.querySelectorAll("[data-sealed-button]").length).toBe(3);
    const approval = frame("approval");
    expect(approval.querySelectorAll("[data-sealed-button]").length).toBe(3);
    expect((approval.querySelector(".cl-composer__pill") as HTMLButtonElement).disabled).toBe(true);
    // The code side folds the session's work into one summary line.
    expect(frame("code").querySelector(".cl-conv-tools__sentence")?.textContent).toBe("Ran a command, made 2 edits, and 3 more");
  });

  test("every catalog token a part names is in lane B's catalog; the rest are part-local requests", () => {
    const parts = { composerTokens, conversationTokens, diffTokens, filesTokens, terminalTokens, panelTokens, settingsTokens, shellTokens, sidebarTokens };
    for (const [part, t] of Object.entries(parts)) {
      expect([part, t.CATALOG_TOKENS.filter((n: string) => !CATALOG_SNAPSHOT.has(n))]).toEqual([part, []]);
      expect([part, t.PART_TOKENS.filter((n: string) => !n.startsWith("plugin.clover."))]).toEqual([part, []]);
    }
  });

  test("the gallery theme sets every token any part wears", () => {
    const theme = readFileSync(join(import.meta.dir, "../gallery/theme.css"), "utf8");
    const parts = [composerTokens, conversationTokens, diffTokens, filesTokens, terminalTokens, panelTokens, settingsTokens, shellTokens, sidebarTokens];
    const missing = parts.flatMap((t) => t.TOKENS.map(t.cssVariable)).filter((v) => !theme.includes(`${v}:`));
    expect(missing).toEqual([]);
  });

  test("no part's source holds a raw hidden character (bidi controls, zero-width ones): escapes only", () => {
    const parts = join(import.meta.dir, "../..");
    const hidden = /[\u00AD\u061C\u115F\u1160\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\u3164\uFEFF\uFFA0]/u;
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name === "dist") continue;
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(tsx?|css|json|md|mjs)$/.test(name) && hidden.test(readFileSync(path, "utf8"))) offenders.push(path.slice(parts.length + 1));
      }
    };
    walk(parts);
    expect(offenders).toEqual([]);
  });
});
