// Renders every gallery story to PNG, in light and dark, with headless Chromium. CI only (it opens a
// browser): `node shoot.mjs <site> <out>`, run next to an installed `playwright`.
//   <site>  the built gallery (bun gallery/build.ts <site>)
//   <out>   where the PNGs go: <out>/<theme>/<part>--<state>.png
// Exits non-zero when a story failed to render or the page logged an error.
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const [siteArg, outArg] = process.argv.slice(2);
if (!siteArg || !outArg) {
  console.error("usage: node shoot.mjs <site> <out>");
  process.exit(2);
}
const site = resolve(siteArg);
const out = resolve(outArg);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1100 }, deviceScaleFactor: 2, locale: "en-US", timezoneId: "UTC" });
const problems = [];
page.on("pageerror", (e) => problems.push(`page error: ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error") problems.push(`console error: ${m.text()}`);
});

await page.goto(pathToFileURL(join(site, "index.html")).href);
await page.waitForSelector("[data-gallery-ready]", { timeout: 30_000 });
await page.evaluate(async () => {
  await document.fonts.ready;
});

const ids = await page.$$eval("[data-story]", (els) => els.map((e) => e.getAttribute("data-story")));
const broken = await page.$$eval("[data-story-error]", (els) => els.map((e) => e.getAttribute("data-story-error")));
console.log(`${ids.length} stories`);

for (const theme of ["light", "dark"]) {
  await page.evaluate((t) => {
    document.documentElement.dataset.theme = t;
  }, theme);
  mkdirSync(join(out, theme), { recursive: true });
  for (const id of ids) {
    const frame = page.locator(`[data-story="${id}"] .g-frame`);
    await frame.scrollIntoViewIfNeeded();
    await frame.screenshot({ path: join(out, theme, `${id.replaceAll("/", "--")}.png`), animations: "disabled", caret: "hide" });
    console.log(`  ${theme}/${id}`);
  }
}
await browser.close();

for (const id of broken) problems.push(`story failed to render: ${id}`);
if (problems.length > 0) {
  for (const p of problems) console.error(p);
  process.exit(1);
}
console.log(`wrote ${ids.length * 2} PNGs to ${out}`);
