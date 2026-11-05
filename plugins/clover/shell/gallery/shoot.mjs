// Renders every gallery story to PNG, in light and dark, with headless Chromium. CI only (it opens a
// browser): `node shoot.mjs <site> <out>`, run next to an installed `playwright`.
//   <site>  the built gallery (bun gallery/build.ts <site>)
//   <out>   where the PNGs go: <out>/<theme>/<part>--<state>.png
// Exits non-zero when a story failed to render, the page logged an error, or a waiting card was covered.
//
// Sealed cards and the title bar (spec §5.5): in every whole-window screen with a waiting card, the
// transcript is scrolled through five positions, and wherever the card is in view its top must be at or
// below the bar's bottom, and a point at each sealed button's centre must reach that button and nothing
// else. In `PINNED`, the transcript goes on past the card, so at its end the card must be pinned just
// below the bar. Each screen is shot scrolled to its end.
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

/** Screens whose transcript goes on past the waiting card: at the end, the card must be pinned. */
const PINNED = new Set(["screen/card-under-bar-1512"]);

/** Scrolls a screen's transcript and checks its waiting card against the title bar; see the top. */
async function checkCard(page, id) {
  return page.evaluate(async (id) => {
    const story = [...document.querySelectorAll("[data-story]")].find((e) => e.getAttribute("data-story") === id);
    const bar = story?.querySelector(".cl-window__bar");
    const viewport = story?.querySelector(".cl-window__content .cl-conv__viewport");
    const card = story?.querySelector(".cl-window__content .cl-conv__unit[data-pending]");
    if (!bar || !viewport || !card) return { has: false };
    const settle = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const name = (el) => (el ? `${el.tagName.toLowerCase()}${el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\s+/).join(".") : ""}` : "nothing");
    const failures = [];
    let inView = 0;
    let pinned = false;
    const max = viewport.scrollHeight - viewport.clientHeight;
    for (const at of [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(max * f))) {
      viewport.scrollTop = at;
      await settle();
      const barBottom = bar.getBoundingClientRect().bottom;
      const view = viewport.getBoundingClientRect();
      const box = card.getBoundingClientRect();
      if (box.bottom <= barBottom || box.top >= view.bottom) continue;
      inView++;
      if (box.top < barBottom - 0.5) failures.push(`scrolled to ${at}: the card's top (${box.top.toFixed(1)}) is above the bar's bottom (${barBottom.toFixed(1)})`);
      if (at === max && box.top - barBottom < 6 && viewport.scrollTop > 0) pinned = true;
      for (const button of card.querySelectorAll("[data-sealed-button]")) {
        const r = button.getBoundingClientRect();
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        if (y <= barBottom || y >= view.bottom) continue;
        const hit = document.elementFromPoint(x, y);
        if (hit !== button && !button.contains(hit)) failures.push(`scrolled to ${at}: a click at the ${button.getAttribute("data-sealed-button")} button's centre reaches ${name(hit)}`);
      }
    }
    viewport.scrollTop = max;
    await settle();
    return { has: true, inView, pinned, failures };
  }, id);
}

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
    if (id.startsWith("screen/")) {
      const card = await checkCard(page, id);
      if (card.has) {
        for (const f of card.failures) problems.push(`${theme}/${id}: ${f}`);
        if (card.inView === 0) problems.push(`${theme}/${id}: the waiting card was never in view`);
        if (PINNED.has(id) && !card.pinned) problems.push(`${theme}/${id}: at the transcript's end the card isn't pinned below the bar`);
        console.log(`  ${theme}/${id}: card checked at ${card.inView} positions${PINNED.has(id) ? (card.pinned ? ", pinned at the end" : ", NOT pinned") : ""}`);
      } else if (PINNED.has(id)) {
        problems.push(`${theme}/${id}: no waiting card to check`);
      }
    }
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
