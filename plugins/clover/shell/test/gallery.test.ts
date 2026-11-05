// The whole gallery, as CI renders it: built with one React for every part (as the screenshot job
// builds it, but in development mode so React's warnings show), then run under happy-dom. Every
// story must mount, none may fail, and nothing may log an error.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGallery } from "../gallery/build";
import { composedStories } from "../gallery/composed";
import { stories as sidebarStories } from "../gallery/stories";
import { stories as composerStories } from "../../composer/gallery/stories";
import { stories as conversationStories } from "../../conversation/gallery/stories";

const outdir = mkdtempSync(join(tmpdir(), "lane-f-gallery-"));
const errors: string[] = [];

async function until(check: () => boolean, ms = 10_000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("the gallery did not finish rendering");
    await new Promise((r) => setTimeout(r, 20));
  }
}

beforeAll(async () => {
  await buildGallery(outdir, { production: false });
  const root = document.createElement("div");
  root.id = "root";
  document.body.append(root);
  const original = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
  try {
    (0, eval)(readFileSync(join(outdir, "main.js"), "utf8"));
    await until(() => document.querySelector("[data-gallery-ready]") !== null);
  } finally {
    console.error = original;
  }
});

afterAll(() => rmSync(outdir, { recursive: true, force: true }));

describe("the gallery", () => {
  const all = [...conversationStories, ...composerStories, ...sidebarStories, ...composedStories];

  test("builds a page, a script and a stylesheet", () => {
    const html = readFileSync(join(outdir, "index.html"), "utf8");
    expect(html).toContain('<script src="main.js" defer></script>');
    expect(readFileSync(join(outdir, "main.css"), "utf8")).toContain(".cl-conv-approval__card");
  });

  test("shows every story of every part, ids unique", () => {
    const shown = [...document.querySelectorAll("[data-story]")].map((s) => s.getAttribute("data-story"));
    expect(shown).toEqual(all.map((s) => s.id));
    expect(new Set(shown).size).toBe(shown.length);
  });

  test("no story failed, and nothing logged an error", () => {
    expect([...document.querySelectorAll("[data-story-error]")].map((e) => e.getAttribute("data-story-error"))).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("the composed stories hold all three parts", () => {
    for (const story of composedStories) {
      const frame = document.querySelector(`[data-story="${story.id}"]`);
      expect(frame?.querySelector(".cl-sidebar")).toBeTruthy();
      expect(frame?.querySelector(".cl-conv")).toBeTruthy();
      expect(frame?.querySelector(".cl-composer")).toBeTruthy();
    }
  });
});
