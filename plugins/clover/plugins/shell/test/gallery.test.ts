// The whole gallery, as CI renders it: built with one React for every part (as the screenshot job
// builds it, but in development mode so React's warnings show), then run under happy-dom. Every
// story must mount, none may fail, and nothing may log an error.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { fireEvent, within } from "@testing-library/dom";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGallery } from "../gallery/build";
import { CATALOG_SNAPSHOT } from "../gallery/catalog";
import { M2_SCREENS, screenStories } from "../gallery/screens";
import { a11yFindings } from "../runtime/a11y";
import { shellStories } from "../gallery/stories";
import { stories as composerStories } from "../../composer/gallery/stories";
import { stories as conversationStories } from "../../conversation/gallery/stories";
import { diffStories } from "../../panel-diff/gallery/stories";
import { filesStories } from "../../panel-files/gallery/stories";
import { terminalStories } from "../../panel-terminal/gallery/stories";
import { panelStories } from "../../panel/gallery/stories";
import { settingsStories } from "../../settings/gallery/stories";
import { stories as sidebarStories } from "../../sidebar/gallery/stories";
import { botEditorStories } from "../../bot-editor/gallery/stories";
import { pluginIndexStories } from "../../plugin-index/gallery/stories";
import { archiveStories } from "../../archive/gallery/stories";
import * as archiveTokens from "../../archive/client/tokens";
import * as botEditorTokens from "../../bot-editor/client/tokens";
import * as pluginIndexTokens from "../../plugin-index/client/tokens";
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
// The gallery pins the clock to its fixtures' day; the other test files get theirs back.
const realNow = Date.now;

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
    await until(() => root!.querySelector("[data-gallery-ready]") !== null, 30_000);
  } finally {
    console.error = original;
  }
});

// Every test file shares one document: take the gallery out of it, so no other file finds it.
afterAll(() => {
  Date.now = realNow;
  root?.remove();
  document.documentElement.removeAttribute("data-theme");
  rmSync(outdir, { recursive: true, force: true });
});

// A failing check here names its selector and a boolean, never an element: printing one prints the whole gallery,
// which is big enough to look like a hang (F-M3).
describe("the gallery", () => {
  const all = [
    ...screenStories, ...conversationStories, ...composerStories, ...sidebarStories, ...panelStories,
    ...terminalStories, ...diffStories, ...filesStories, ...settingsStories, ...botEditorStories, ...pluginIndexStories,
    ...archiveStories, ...shellStories,
  ];
  /** The screens of a tab (a bot's, an agent's, a coding session's), not a page of its own. */
  const PAGES = ["screen/plugin-index-1440", "screen/plugin-index-for-panel-1440", "screen/bot-editor-1440", "screen/archive-1440", "screen/archive-session-1440"];
  const tabScreens = screenStories.filter((s) => !PAGES.includes(s.id));

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
  });

  test("accessibility (F-M3): every control in every story has a name and is in the tab order, and every image an alt", () => {
    const found = [...root!.querySelectorAll("[data-story]")].flatMap((story) => a11yFindings(story).map((f) => `${story.getAttribute("data-story")}: ${f}`));
    expect([...new Set(found)]).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("every whole-window screen holds the sidebar; every tab's, the toggles, the conversation and the composer", () => {
    expect(screenStories.length).toBe(44);
    expect(M2_SCREENS).toHaveLength(11);
    expect(screenStories.filter((s) => s.width === 1512 && s.height === 950)).toHaveLength(3);
    for (const story of screenStories) expect([story.id, root!.querySelector(`[data-story="${story.id}"] .cl-window .cl-sidebar`) !== null]).toEqual([story.id, true]);
    for (const story of tabScreens) {
      const frame = root!.querySelector(`[data-story="${story.id}"]`);
      expect([".cl-window .cl-sidebar", !!frame?.querySelector(".cl-window .cl-sidebar")]).toEqual([".cl-window .cl-sidebar", true]);
      expect([".cl-window__toggles .cl-panel-toggles", !!frame?.querySelector(".cl-window__toggles .cl-panel-toggles")]).toEqual([".cl-window__toggles .cl-panel-toggles", true]);
      expect([".cl-window__content .cl-conv", !!frame?.querySelector(".cl-window__content .cl-conv")]).toEqual([".cl-window__content .cl-conv", true]);
      expect([".cl-window__content .cl-composer", !!frame?.querySelector(".cl-window__content .cl-composer")]).toEqual([".cl-window__content .cl-composer", true]);
    }
  });

  test("each panel screen shows its panel; two-panels shows two; the dialogs and the card are there", () => {
    const frame = (id: string) => root!.querySelector(`[data-story="screen/${id}-1440"]`)!;
    expect([".cl-panel .cl-term", !!frame("terminal").querySelector(".cl-panel .cl-term")]).toEqual([".cl-panel .cl-term", true]);
    expect([".cl-panel .cl-diff", !!frame("diff").querySelector(".cl-panel .cl-diff")]).toEqual([".cl-panel .cl-diff", true]);
    // The browser panel is lane L's: the host's placeholder holds its place.
    expect(['.cl-panel [data-empty-view="browser"]', !!frame("browser").querySelector('.cl-panel [data-empty-view="browser"]')]).toEqual(['.cl-panel [data-empty-view="browser"]', true]);
    expect([".cl-panel .cl-files", !!frame("files").querySelector(".cl-panel .cl-files")]).toEqual([".cl-panel .cl-files", true]);
    expect(frame("two-panels").querySelectorAll(".cl-panel__view").length).toBe(2);
    expect([".cl-window__side .cl-session", !!frame("code").querySelector(".cl-window__side .cl-session")]).toEqual([".cl-window__side .cl-session", true]);
    expect([".cl-window__dialog .cl-settings", !!frame("settings").querySelector(".cl-window__dialog .cl-settings")]).toEqual([".cl-window__dialog .cl-settings", true]);
    expect([".cl-window__dialog .cl-languages", !!frame("languages").querySelector(".cl-window__dialog .cl-languages")]).toEqual([".cl-window__dialog .cl-languages", true]);
    // Settings asked for while a card waits: no dialog, and the bar says why.
    const held = frame("settings-pending-card");
    expect([".cl-window__dialog", !!held.querySelector(".cl-window__dialog")]).toEqual([".cl-window__dialog", false]);
    expect(held.querySelector(".cl-window__note")?.textContent).toBe("Answer the waiting card first, then open it again.");
    expect(held.querySelectorAll("[data-sealed-button]").length).toBe(3);
    const approval = frame("approval");
    expect(approval.querySelectorAll("[data-sealed-button]").length).toBe(3);
    expect((approval.querySelector(".cl-composer__pill") as HTMLButtonElement).disabled).toBe(true);
    // The code side folds the session's work into one summary line.
    expect(frame("code").querySelector(".cl-conv-tools__sentence")?.textContent).toBe("Ran a command, made 2 edits, and 3 more");
    // The Files panel is the session's folder, named in its header with the computer that holds it.
    expect(frame("files").querySelector(".cl-panel__head .cl-files-title")?.getAttribute("aria-label")).toBe("Files in clover, on Studio");
  });

  test("a bot's tab never shows the terminal, the changes or the files; a code session has them all (the owner's scope ruling)", () => {
    const toggles = (story: Element) => [...story.querySelectorAll(".cl-window__toggles .cl-panel-toggles .cl-panel-toggle")].map((b) => b.getAttribute("aria-label"));
    for (const story of screenStories) {
      const frame = root!.querySelector(`[data-story="${story.id}"]`)!;
      const kind = frame.querySelector(".cl-panel-toggles")?.getAttribute("data-kind");
      if (PAGES.includes(story.id)) {
        expect([story.id, kind]).toEqual([story.id, undefined]);
      } else if (kind === "bot") {
        expect([story.id, toggles(frame)]).toEqual([story.id, ["Details", "Browser"]]);
        // (An output opened from the column isn't the Files panel: it is only that file, read only.)
        expect([story.id, !!frame.querySelector(".cl-term, .cl-diff, .cl-files:not(.cl-files--output)")]).toEqual([story.id, false]);
        // The slim column, if open, has nothing about a folder.
        expect([story.id, !!frame.querySelector('.cl-session[data-kind="coding"]')]).toEqual([story.id, false]);
      } else if (kind === "agent") {
        expect([story.id, toggles(frame)]).toEqual([story.id, ["Session", "Browser"]]);
      } else {
        expect([story.id, toggles(frame)]).toEqual([story.id, ["Session", "Terminal", "Changes", "Browser", "Files"]]);
      }
    }
    const kinds = (k: string) => screenStories.filter((s) => root!.querySelector(`[data-story="${s.id}"] .cl-panel-toggles[data-kind="${k}"]`)).length;
    expect([kinds("bot"), kinds("agent"), kinds("coding")]).toEqual([21, 1, 17]);
    // An output opened from a bot's column shows in the right panel, read from its session's outputs folder.
    const out = root!.querySelector('[data-story="screen/bot-output-1440"] .cl-files--output');
    expect(out?.textContent).toContain("# This week in the clover repo");
  });

  test("a bot's slim column shows its agents, and one opens in the panel with its own composer and model picker", () => {
    const column = root!.querySelector('[data-story="screen/bot-column-1440"] .cl-window__side .cl-session[data-kind="bot"]')!;
    expect(column.textContent).toContain("Fix the CSV export's dates");
    expect(column.textContent).not.toContain("Where it runs");
    const agent = root!.querySelector('[data-story="screen/bot-agent-1440"]')!;
    const panel = agent.querySelector('.cl-panel[data-kind="bot"] .cl-panel__view[data-view="agent"]')!;
    expect([".cl-conv", !!panel.querySelector(".cl-conv")]).toEqual([".cl-conv", true]);
    expect([".cl-composer", !!panel.querySelector(".cl-composer")]).toEqual([".cl-composer", true]);
    expect([".cl-composer__pill", !!panel.querySelector(".cl-composer__pill")]).toEqual([".cl-composer__pill", true]);
    // No column of its own, and no code-side panel beside it.
    expect([".cl-session, .cl-panel-toggles", !!panel.querySelector(".cl-session, .cl-panel-toggles")]).toEqual([".cl-session, .cl-panel-toggles", false]);
    expect(agent.querySelectorAll(".cl-panel__view").length).toBe(1);
  });

  test("the card-under-bar screen has a waiting card with more of the transcript after it", () => {
    const frame = root!.querySelector('[data-story="screen/card-under-bar-1512"]')!;
    const units = [...frame.querySelectorAll(".cl-window__content .cl-conv__unit")];
    const pending = units.findIndex((u) => u.hasAttribute("data-pending"));
    expect(pending).toBeGreaterThan(0);
    expect(units.length - pending).toBeGreaterThan(3);
    expect(frame.querySelectorAll("[data-sealed-button]").length).toBe(3);
  });

  test("every catalog token a part names is in lane B's catalog; the rest are part-local requests", () => {
    const parts = { composerTokens, conversationTokens, diffTokens, filesTokens, terminalTokens, panelTokens, settingsTokens, shellTokens, sidebarTokens, botEditorTokens, pluginIndexTokens, archiveTokens };
    for (const [part, t] of Object.entries(parts)) {
      expect([part, t.CATALOG_TOKENS.filter((n: string) => !CATALOG_SNAPSHOT.has(n))]).toEqual([part, []]);
      expect([part, t.PART_TOKENS.filter((n: string) => !n.startsWith("plugin.clover."))]).toEqual([part, []]);
    }
  });

  test("the gallery theme sets every token any part wears", () => {
    const theme = readFileSync(join(import.meta.dir, "../gallery/theme.css"), "utf8");
    const parts = [composerTokens, conversationTokens, diffTokens, filesTokens, terminalTokens, panelTokens, settingsTokens, shellTokens, sidebarTokens, botEditorTokens, pluginIndexTokens, archiveTokens];
    const missing = parts.flatMap((t) => t.TOKENS.map(t.cssVariable)).filter((v) => !theme.includes(`${v}:`));
    expect(missing).toEqual([]);
  });

  test("no part's source holds a raw hidden character (bidi controls, zero-width ones, tags, variation selectors): escapes only", () => {
    const parts = join(import.meta.dir, "../..");
    const hidden = /[\u00AD\u061C\u115F\u1160\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\u3164\uFE00-\uFE0F\uFEFF\uFFA0\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/u;
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

describe("F-M2's screens: the pages the runtime adds, and add-ons", () => {
  const frame = (id: string) => root!.querySelector(`[data-story="screen/${id}-1440"]`)!;

  test("each page fills `main` from its own part", () => {
    expect([".cl-window__content .cl-plugin-index .cl-plugin-index__result", !!frame("plugin-index").querySelector(".cl-window__content .cl-plugin-index .cl-plugin-index__result")]).toEqual([".cl-window__content .cl-plugin-index .cl-plugin-index__result", true]);
    expect(frame("plugin-index-for-panel").querySelector(".cl-plugin-index__looking")?.textContent).toContain("the terminal panel");
    expect(frame("bot-editor").querySelector(".cl-window__content .cl-bot-editor__title")?.textContent).toBe("Edit Alpha");
    expect(frame("bot-editor").querySelectorAll(".cl-bot-editor__avatar").length).toBe(4);
    expect(frame("archive").querySelectorAll(".cl-archive__session").length).toBe(5);
    // The old session reads through the conversation part, its approval as a note.
    const old = frame("archive-session").querySelector(".cl-archive__transcript .cl-conv")!;
    expect(old.textContent).toContain("Draft the release notes for 0.123");
    expect(old.textContent).toContain("Asked to use Bash");
  });

  test("Settings shows the plugins' states and each computer's level from the core", () => {
    const plugins = frame("settings-plugins").querySelector(".cl-window__dialog .cl-settings")!;
    expect(plugins.textContent).toContain("Waits for your OK");
    expect(plugins.textContent).toContain("Stopped after three crashes in two minutes");
    expect(plugins.textContent).toContain("Reaches api.weather.example");
    const levels = [...frame("settings-levels").querySelectorAll(".cl-window__dialog select")].map((s) => (s as HTMLSelectElement).value);
    expect(levels).toEqual(["ask-risky", "ask", "automatic"]);
    const devices = frame("settings-devices").querySelector(".cl-window__dialog .cl-settings")!;
    expect(['[aria-label="Make Laptop the main computer"]', !!devices.querySelector('[aria-label="Make Laptop the main computer"]')]).toEqual(['[aria-label="Make Laptop the main computer"]', true]);
    expect(['[aria-label="Pair a device"]', !!devices.querySelector('[aria-label="Pair a device"]')]).toEqual(['[aria-label="Pair a device"]', true]);
    const atItem = frame("settings-device-item").querySelector(".cl-window__dialog .cl-settings")!;
    expect([...atItem.querySelectorAll<HTMLElement>("[data-marked]")].map((el) => el.textContent)).toEqual([expect.stringContaining("Laptop")]);
  });

  test("an agent's live tab: its status over its composer", () => {
    const tab = frame("agent-tab").querySelector('.cl-window__content .cl-agent-tab[data-place="main"]')!;
    expect(tab.querySelector(".cl-agent-tab__status")?.textContent).toContain("Codex on Studio");
    expect([".cl-composer", !!tab.querySelector(".cl-composer")]).toEqual([".cl-composer", true]);
  });

  test("add-ons: a header button, reactions under answers, a status line and an app button, beside the parts", () => {
    const f = frame("addons");
    expect(['.cl-window__toggles [aria-label="Draw a card"]', !!f.querySelector('.cl-window__toggles [aria-label="Draw a card"]')]).toEqual(['.cl-window__toggles [aria-label="Draw a card"]', true]);
    expect(f.querySelectorAll(".story-addon-reactions").length).toBeGreaterThan(0);
    expect(f.querySelector(".cl-window__status")?.textContent).toContain("Usage today");
    expect([...f.querySelectorAll(".cl-sidebar button")].some((b) => b.textContent?.includes("Tarot"))).toBe(true);
  });
});

// Last, since they change two screens' state: the real Settings, in the window, raising its cards.
describe("cards raised from Settings close Settings (review round 3, C)", () => {
  const note = "Answer the waiting card first, then open it again.";

  test("asking for a level change", async () => {
    const frame = root!.querySelector('[data-story="screen/settings-1024"]') as HTMLElement;
    expect([".cl-window__dialog .cl-settings", !!frame.querySelector(".cl-window__dialog .cl-settings")]).toEqual([".cl-window__dialog .cl-settings", true]);
    // The gallery's own React renders on its own schedule: wait for each step to land.
    fireEvent.click(within(frame).getByRole("button", { name: "Levels" }));
    await until(() => within(frame).queryByRole("combobox", { name: "Studio's level" }) !== null, 2000);
    fireEvent.change(within(frame).getByRole("combobox", { name: "Studio's level" }), { target: { value: "automatic" } });
    await until(() => frame.querySelector(".cl-window__note")?.textContent === note, 2000);
    expect([".cl-window__dialog", !!frame.querySelector(".cl-window__dialog")]).toEqual([".cl-window__dialog", false]);
  });

  test("asking to remove a device", async () => {
    const frame = root!.querySelector('[data-story="screen/settings-1440"]') as HTMLElement;
    fireEvent.click(within(frame).getByRole("button", { name: "Devices" }));
    await until(() => within(frame).queryByRole("button", { name: "Remove Laptop" }) !== null, 2000);
    fireEvent.click(within(frame).getByRole("button", { name: "Remove Laptop" }));
    await until(() => frame.querySelector(".cl-window__note")?.textContent === note, 2000);
    expect([".cl-window__dialog", !!frame.querySelector(".cl-window__dialog")]).toEqual([".cl-window__dialog", false]);
  });
});
