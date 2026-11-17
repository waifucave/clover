// Lays out sealed pages in a real Electron, never on screen (an offscreen window that is never shown), and measures inside each
// page (sealed-layout.test.ts). A button page sits in a frame sized the way a part sizes it (the page's own size report,
// clamped as the plugin SDK clamps it); an own card page in a window of the fallback card's width at its reported height,
// clamped as the app clamps it. Each is measured twice: as laid out, and with classic scroll bars forced on its own document
// (`::-webkit-scrollbar` with a width, which makes Chromium draw space-taking bars as "Show scroll bars: Always" does), never
// touching a system setting.
import { app, BrowserWindow } from "electron";
import { readFileSync, writeFileSync } from "node:fs";

const input = JSON.parse(readFileSync(process.env.MOSS_LAYOUT_IN, "utf8"));
const out = process.env.MOSS_LAYOUT_OUT;
app.dock?.hide?.();
app.disableHardwareAcceleration();

const STUB = `<script>window.mossSealed = { answer: async () => ({ accepted: false }), visible: () => {}, fresh: () => {}, seen: () => {}, size: (h) => { window.__ownSize = h; } };</script>`;
const withStub = (html) => html.replace("<head>", `<head>${STUB}`);
const CLASSIC = "::-webkit-scrollbar { width: 15px; height: 15px; background: #888 } ::-webkit-scrollbar-thumb { background: #444 }";

const PARENT = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0} iframe{border:0;display:block}</style></head><body><iframe id="f"></iframe><script>
window.__size = null;
addEventListener("message", (e) => { const s = e.data && e.data.mossSealedSize; if (s) window.__size = s; });
</script></body></html>`;

const MEASURE = `(() => {
  const d = document.documentElement;
  const b = document.querySelector(".seal-button");
  const r = b ? b.getBoundingClientRect() : null;
  const buttons = [...document.querySelectorAll(".seal-button")].map((x) => { const q = x.getBoundingClientRect(); return { left: q.left, top: q.top, right: q.right, bottom: q.bottom }; });
  return { scrollWidth: d.scrollWidth, clientWidth: d.clientWidth, scrollHeight: d.scrollHeight, clientHeight: d.clientHeight, innerWidth, innerHeight, button: r ? { width: r.width, height: r.height } : null, buttons };
})()`;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function inFrame(win, html, classic) {
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PARENT)}`);
  await win.webContents.executeJavaScript(`(() => { const f = document.getElementById("f"); f.srcdoc = ${JSON.stringify(withStub(html))}; })()`);
  let size = null;
  for (let i = 0; i < 100 && size === null; i++) { await wait(20); size = await win.webContents.executeJavaScript("window.__size"); }
  if (size === null) return { error: "no size report" };
  // As the plugin SDK does: a button frame takes the reported box, each side clamped (1200 by 4000).
  const width = Math.min(Math.ceil(size.width ?? 0), 1200);
  const height = Math.min(Math.ceil(size.height ?? 0), 4000);
  await win.webContents.executeJavaScript(`(() => { const f = document.getElementById("f"); f.style.width = "${width}px"; f.style.height = "${height}px"; })()`);
  await wait(150);
  const frame = win.webContents.mainFrame.frames[0];
  if (classic) await frame.executeJavaScript(`(() => { const s = document.createElement("style"); s.textContent = ${JSON.stringify(CLASSIC)}; document.head.append(s); })()`);
  await wait(150);
  return { frame: { width, height }, ...(await frame.executeJavaScript(MEASURE)) };
}

async function asWindow(win, html, classic, o) {
  win.setContentSize(o.width, o.minHeight);
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(withStub(html))}`);
  await wait(200);
  const reported = await win.webContents.executeJavaScript("window.__ownSize ?? null");
  const h = Math.min(o.maxHeight, Math.max(o.minHeight, reported ?? o.minHeight));
  win.setContentSize(o.width, h);
  await wait(150);
  if (classic) await win.webContents.executeJavaScript(`(() => { const s = document.createElement("style"); s.textContent = ${JSON.stringify(CLASSIC)}; document.head.append(s); })()`);
  await wait(150);
  return { frame: { width: o.width, height: h }, ...(await win.webContents.executeJavaScript(MEASURE)) };
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1400, height: 1000, useContentSize: true, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true } });
  const results = [];
  for (const c of input.cases) {
    for (const classic of [false, true]) {
      try {
        const m = c.kind === "own" ? await asWindow(win, c.html, classic, input.own) : await inFrame(win, c.html, classic);
        results.push({ name: c.name, classic, ...m });
      } catch (err) {
        results.push({ name: c.name, classic, error: String(err) });
      }
    }
  }
  writeFileSync(out, JSON.stringify(results, null, 1));
  app.exit(0);
});
