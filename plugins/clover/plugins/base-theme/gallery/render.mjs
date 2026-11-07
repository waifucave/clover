// Renders every gallery story to a PNG with headless Chromium (software WebGL for the avatar), one page
// load per story, and checks every sealed part drawn at rest with IntersectionObserver v2 (the visibility
// check spec §5.5's frames rely on). CI ONLY: it refuses to run anywhere else, so it can never put a
// browser on someone's desk. Output: out/png/<story>.png, out/index.html (every picture with its title),
// out/report.json.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.GITHUB_ACTIONS !== "true") {
  console.error("render.mjs runs in CI only (GITHUB_ACTIONS=true); it launches a browser.");
  process.exit(2);
}

const { chromium } = await import("playwright");

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "dist");
const out = join(here, "out");
mkdirSync(join(out, "png"), { recursive: true });

const ORIGIN = "http://gallery.test";
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".vrm": "model/gltf-binary", ".glb": "model/gltf-binary", ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".wav": "audio/wav" };

const browser = await chromium.launch({
  channel: "chromium",
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required", "--force-color-profile=srgb", "--font-render-hinting=none"],
});
const context = await browser.newContext({ deviceScaleFactor: 2, viewport: { width: 1400, height: 900 }, colorScheme: "light" });
await context.route(`${ORIGIN}/**`, async (route) => {
  const path = normalize(decodeURIComponent(new URL(route.request().url()).pathname)).replace(/^\/+/, "");
  const file = join(dist, path || "index.html");
  if (!file.startsWith(dist) || !existsSync(file)) return route.fulfill({ status: 404, body: "not found" });
  await route.fulfill({ status: 200, body: readFileSync(file), contentType: TYPES[extname(file)] ?? "application/octet-stream" });
});
// Nothing else is reachable: the gallery is self-contained.
await context.route((url) => !url.href.startsWith(ORIGIN), (route) => route.abort());

const report = { started: new Date().toISOString(), stories: [], errors: [], webgl: null };

const index = await context.newPage();
await index.goto(`${ORIGIN}/index.html?list=1`);
await index.waitForFunction(() => Array.isArray(window.__galleryStories), null, { timeout: 30_000 });
const stories = await index.evaluate(() => window.__galleryStories);
report.webgl = await index.evaluate(() => {
  const gl = document.createElement("canvas").getContext("webgl2");
  if (!gl) return "no webgl2";
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  return info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
});
await index.close();
console.log(`${stories.length} stories; WebGL: ${report.webgl}`);

for (const story of stories) {
  const started = Date.now();
  const page = await context.newPage();
  await page.setViewportSize({ width: Math.max(story.width, 320), height: Math.max(story.height, 200) });
  const errors = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  try {
    await page.goto(`${ORIGIN}/index.html?story=${encodeURIComponent(story.id)}`);
    await page.waitForFunction(() => window.__galleryReady === true, null, { timeout: 60_000 });
    const failure = await page.evaluate(() => window.__galleryError ?? null);
    if (failure) errors.push(`story: ${failure}`);
    // Spec §5.5's own check, in the browser the app runs: IntersectionObserver v2 says whether each sealed part
    // shows uncovered and unaffected. It fails, never skips: every part the story draws is counted as whole and
    // visible at rest, mid-motion (a filmstrip's frames: something around it fades, blurs, hides or turns), or cut
    // at the edge of a list that scrolls, and the counts must be the ones the story records (`sealed`). A part
    // covered or hidden at rest, cut by anything else, or with no observer entry fails the story, and so does a
    // browser without IntersectionObserver v2.
    const sealed = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const parts = [...document.querySelectorAll("[data-sealed]")];
          const tally = { visible: 0, moving: 0, scrolled: 0, problems: [] };
          if (parts.length === 0) return resolve(tally);
          if (!("isVisible" in IntersectionObserverEntry.prototype)) {
            tally.problems.push(`IntersectionObserver v2 is unavailable, so none of ${parts.length} sealed parts could be checked`);
            return resolve(tally);
          }
          const name = (p) =>
            `${p.getAttribute("data-sealed")}${p.getAttribute("data-field") ? `:${p.getAttribute("data-field")}` : ""}${p.getAttribute("data-option") ? `:${p.getAttribute("data-option")}` : ""}`;
          const atRest = (el) => {
            for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
              const cs = getComputedStyle(n);
              if (Number(cs.opacity) < 1 || cs.filter !== "none" || cs.visibility !== "visible") return false;
              if (cs.transform !== "none") {
                const m = /^matrix\(([^)]+)\)$/.exec(cs.transform);
                if (!m) return false;
                const [a, b, c, d] = m[1].split(",").map(Number);
                if (b !== 0 || c !== 0 || a !== d || a < 1) return false;
              }
            }
            return true;
          };
          const seen = new Map();
          const observer = new IntersectionObserver((entries) => entries.forEach((e) => seen.set(e.target, e)), { trackVisibility: true, delay: 100 });
          parts.forEach((p) => observer.observe(p));
          // Sampled once every part has its first entry and the page has painted a few more frames, never on a fixed
          // clock: a busy runner (the merge queue's) can take seconds to deliver a filmstrip's thirty-odd entries, and a
          // part sampled before its entry came reads as "no entry" though nothing is wrong. After 15 s, what's missing
          // is a real failure.
          const started = performance.now();
          const frames = (n) => new Promise((r) => { const step = () => (n-- <= 0 ? r() : requestAnimationFrame(step)); requestAnimationFrame(step); });
          const sample = (done) => {
            const all = parts.every((p) => seen.has(p));
            if ((all && performance.now() - started >= 700) || performance.now() - started >= 15_000) return void frames(3).then(() => setTimeout(done, 150));
            setTimeout(() => sample(done), 100);
          };
          sample(() => {
            observer.disconnect();
            for (const p of parts) {
              const e = seen.get(p);
              if (!e) {
                tally.problems.push(`${name(p)}: no IntersectionObserver entry`);
                continue;
              }
              if (!atRest(p)) {
                tally.moving++;
                continue;
              }
              const box = p.getBoundingClientRect();
              if (!e.isIntersecting || e.intersectionRatio < 0.999 || box.width === 0 || box.height === 0) {
                // A list that scrolls shows the rest after a scroll; a card cut by its own shape never takes the click.
                if (p.closest("[data-scrolls]")) tally.scrolled++;
                else tally.problems.push(`${name(p)}: cut at rest (${Math.round(e.intersectionRatio * 1000) / 10}% shows), by something other than a list that scrolls`);
                continue;
              }
              if (!e.isVisible) {
                tally.problems.push(`${name(p)}: covered or hidden at rest (IntersectionObserver v2)`);
                continue;
              }
              tally.visible++;
            }
            resolve(tally);
          });
        }),
    );
    const expected = { visible: story.sealed?.visible ?? 0, moving: story.sealed?.moving ?? 0, scrolled: story.sealed?.scrolled ?? 0 };
    const found = { visible: sealed.visible, moving: sealed.moving, scrolled: sealed.scrolled };
    for (const problem of sealed.problems) errors.push(`sealed part ${problem}`);
    if (JSON.stringify(found) !== JSON.stringify(expected)) {
      errors.push(`sealed parts: the story records ${JSON.stringify(expected)}, the page drew ${JSON.stringify(found)}`);
    }
    const file = `${story.id.replaceAll("/", "__")}.png`;
    await page.locator("[data-frame]").first().screenshot({ path: join(out, "png", file), animations: "disabled", omitBackground: false });
    report.stories.push({ ...story, file, ms: Date.now() - started, errors, sealed: found });
    console.log(`${errors.length ? "!" : "✓"} ${story.id} (${Date.now() - started} ms${sealed.visible ? `, ${sealed.visible} sealed parts visible` : ""})${errors.length ? " " + errors.join(" | ") : ""}`);
  } catch (error) {
    errors.push(String(error));
    report.stories.push({ ...story, file: null, ms: Date.now() - started, errors });
    console.log(`✗ ${story.id}: ${error}`);
  }
  if (errors.length) report.errors.push({ id: story.id, errors });
  await page.close();
}

await browser.close();
report.finished = new Date().toISOString();
writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2));

const escape = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const groups = new Map();
for (const s of report.stories) {
  const group = s.id.split("/")[0];
  if (!groups.has(group)) groups.set(group, []);
  groups.get(group).push(s);
}
writeFileSync(
  join(out, "index.html"),
  `<!doctype html><meta charset="utf-8"><title>Clover lane G gallery</title>
<style>body{font:14px system-ui,sans-serif;margin:24px 32px;background:#E9E9EE;color:#1C1B22}h2{margin:36px 0 12px;font-size:18px}
figure{margin:0 0 28px}figcaption{font-size:13px;margin:0 0 8px}figcaption code{color:#676674;margin-left:8px}img{display:block;max-width:100%;box-shadow:0 0 0 1px #0000001A}.err{color:#B12F6E}</style>
<h1>Clover lane G gallery</h1><p>${report.stories.length} stories · rendered ${escape(report.finished)} · WebGL: ${escape(report.webgl)}</p>
${[...groups].map(([group, list]) => `<h2>${escape(group)}</h2>` + list.map((s) => `<figure><figcaption>${escape(s.title)}<code>${escape(s.id)}</code>${s.errors.length ? `<div class="err">${escape(s.errors.join(" | "))}</div>` : ""}</figcaption>${s.file ? `<img src="png/${escape(s.file)}" width="${s.width}" alt="${escape(s.title)}">` : ""}</figure>`).join("")).join("")}`,
);

console.log(`rendered ${report.stories.filter((s) => s.file).length}/${stories.length}; ${report.errors.length} with errors`);
if (report.errors.length > 0 || report.stories.some((s) => !s.file)) process.exit(1);
