// Round twelve's page: a bot's tab drawn offscreen and shown through a viewport (Winter's model), or the same page in
// a native view for comparison. It keeps what a reload would lose (a token made at load, timers, an open SSE stream,
// form state) and records every kind of input the viewport has to carry: clicks, the wheel, keys, IME composition,
// paste, a <select>, JavaScript dialogs, a file chooser, a window it opens, an HTML5 drag, cursor zones and resizes.
// A box toggles red/blue on every pointerdown in it (and on keys, when asked), and records when its change reached a
// frame (two rAFs later): the input-to-frame clock for the native view. The checks read everything through
// `__vp.state()`.
// Query: tab=<id>, sse=0.

const params = new URLSearchParams(location.search);
const tabId = params.get("tab") ?? "";

interface Ev { t: number; kind: string; detail?: string }
const events: Ev[] = [];
function log(kind: string, detail?: string): void {
  events.push({ t: Date.now(), kind, detail });
  if (events.length > 400) events.shift();
}

const S = {
  token: typeof crypto.randomUUID === "function" ? crypto.randomUUID() : String(Math.random()).slice(2),
  loadedAt: Date.now(),
  navType: (performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined)?.type ?? "unknown",
  ticks: 0,
  lastTickAt: 0,
  sse: { opens: 0, errors: 0, msgs: 0, lastSeq: -1, gaps: 0 },
  clicks: [] as Array<{ x: number; y: number; t: number }>,
  keys: [] as string[],
  compositions: [] as string[],
  pastes: [] as string[],
  inputTypes: [] as string[],
  selects: [] as string[],
  dialogs: [] as string[],
  files: [] as string[],
  popup: { opened: false, messages: [] as string[] },
  drag: [] as string[],
  resizes: [] as string[],
  scrolls: 0,
  wheels: 0,
  lat: [] as Array<{ n: number; kind: string; tIn: number; tFrame?: number; color: string }>,
  anim: { on: false, frames: 0, startedAt: 0 },
  smooth: { startedAt: 0, endedAt: 0, scrollEvents: 0, rafs: 0 },
};

// --- timers and the SSE stream (what a reload would lose) -----------------------------------------------------------
setInterval(() => { S.ticks++; S.lastTickAt = Date.now(); }, 100);
if (params.get("sse") !== "0") {
  const es = new EventSource(`/sse?tab=${encodeURIComponent(tabId)}`);
  es.onopen = () => { S.sse.opens++; };
  es.onerror = () => { S.sse.errors++; };
  es.onmessage = (e) => {
    const seq = Number(e.data);
    if (S.sse.lastSeq >= 0 && seq !== S.sse.lastSeq + 1) S.sse.gaps++;
    S.sse.lastSeq = seq;
    S.sse.msgs++;
  };
}

// --- the latency box ---------------------------------------------------------------------------------------------------
const box = document.getElementById("box")!;
let boxRed = true;
let latKeys = false;
function toggleBox(kind: string): void {
  boxRed = !boxRed;
  box.style.background = boxRed ? "rgb(255, 0, 0)" : "rgb(0, 0, 255)";
  const rec: (typeof S.lat)[number] = { n: S.lat.length + 1, kind, tIn: Date.now(), color: boxRed ? "red" : "blue" };
  S.lat.push(rec);
  if (S.lat.length > 200) S.lat.shift();
  requestAnimationFrame(() => requestAnimationFrame(() => { rec.tFrame = Date.now(); }));
}
box.addEventListener("pointerdown", () => toggleBox("pointer"));
document.addEventListener("keydown", (e) => {
  S.keys.push(e.key);
  if (S.keys.length > 200) S.keys.shift();
  if (latKeys) toggleBox("key");
}, true);

// --- clicks, the field, composition, paste ------------------------------------------------------------------------------
document.getElementById("btn")!.addEventListener("click", (e) => {
  S.clicks.push({ x: e.clientX, y: e.clientY, t: Date.now() });
  log("click", `${e.clientX},${e.clientY}`);
});
const field = document.getElementById("field") as HTMLInputElement;
for (const k of ["compositionstart", "compositionupdate", "compositionend"] as const) {
  field.addEventListener(k, (e) => { S.compositions.push(`${k.slice(11)}:${e.data}`); });
}
field.addEventListener("paste", (e) => { S.pastes.push(e.clipboardData?.getData("text/plain") ?? ""); });
field.addEventListener("beforeinput", (e) => { S.inputTypes.push(e.inputType); if (S.inputTypes.length > 200) S.inputTypes.shift(); });
field.addEventListener("focus", () => log("field-focus"));

// --- <select>, file chooser ----------------------------------------------------------------------------------------------
const sel = document.getElementById("sel") as HTMLSelectElement;
sel.addEventListener("change", () => { S.selects.push(sel.value); log("select", sel.value); });
const file = document.getElementById("file") as HTMLInputElement;
file.addEventListener("change", async () => {
  const f = file.files?.[0];
  if (f === undefined) { S.files.push("(none)"); return; }
  const text = await f.text().catch((e: unknown) => `unreadable: ${String(e)}`);
  S.files.push(`${f.name}:${f.size}:${text.slice(0, 40)}`);
});

// --- JavaScript dialogs (run from a timer, so the caller isn't the one blocked) ----------------------------------------
function runDialog(kind: string): void {
  setTimeout(() => {
    const t0 = Date.now();
    let r: unknown;
    if (kind === "alert") { window.alert("S7 alert"); r = "returned"; }
    else if (kind === "confirm") r = window.confirm("S7 confirm?");
    else r = window.prompt("S7 prompt", "default");
    S.dialogs.push(`${kind}:${JSON.stringify(r)}:${Date.now() - t0}ms`);
  }, 0);
}
document.getElementById("alertBtn")!.addEventListener("click", () => runDialog("alert"));
document.getElementById("confirmBtn")!.addEventListener("click", () => runDialog("confirm"));
document.getElementById("promptBtn")!.addEventListener("click", () => runDialog("prompt"));

// --- a window the page opens (a sign-in window, say); it posts back to its opener -----------------------------------------
document.getElementById("openBtn")!.addEventListener("click", () => {
  const w = window.open(`/pages/vp-popup.html?tab=${encodeURIComponent(tabId)}-popup`, "s7popup", "width=480,height=360");
  S.popup.opened = w !== null;
  log("window.open", w === null ? "null" : "window");
});
window.addEventListener("message", (e) => {
  if (typeof e.data === "string" && e.data.startsWith("popup:")) S.popup.messages.push(e.data);
});

// --- HTML5 drag and drop -------------------------------------------------------------------------------------------------
const drag = document.getElementById("drag")!;
const drop = document.getElementById("drop")!;
drag.addEventListener("dragstart", (e) => { e.dataTransfer?.setData("text/plain", "s7-dragged"); S.drag.push("dragstart"); });
drag.addEventListener("dragend", (e) => { S.drag.push(`dragend:${e.dataTransfer?.dropEffect ?? ""}`); });
drop.addEventListener("dragenter", (e) => { e.preventDefault(); S.drag.push("dragenter"); });
drop.addEventListener("dragover", (e) => { e.preventDefault(); if (S.drag[S.drag.length - 1] !== "dragover") S.drag.push("dragover"); });
drop.addEventListener("drop", (e) => { e.preventDefault(); S.drag.push(`drop:${e.dataTransfer?.getData("text/plain") ?? ""}`); });

// --- layout, scrolling, focus --------------------------------------------------------------------------------------------
window.addEventListener("resize", () => { S.resizes.push(`${Date.now()}:${window.innerWidth}x${window.innerHeight}`); log("resize", `${window.innerWidth}x${window.innerHeight}`); });
window.addEventListener("scroll", () => { S.scrolls++; if (S.smooth.startedAt > 0 && S.smooth.endedAt === 0) S.smooth.scrollEvents++; });
window.addEventListener("wheel", () => { S.wheels++; }, { passive: true });
window.addEventListener("focus", () => log("focus"));
window.addEventListener("blur", () => log("blur"));
document.addEventListener("visibilitychange", () => log("visibility", document.visibilityState));

// --- the animation (frames per second through the viewport) ---------------------------------------------------------------
const anim = document.getElementById("anim") as HTMLCanvasElement;
const actx = anim.getContext("2d", { alpha: false });
function animate(ts: number): void {
  if (!S.anim.on || actx === null) return;
  const w = window.innerWidth, h = 260;
  if (anim.width !== w || anim.height !== h) { anim.width = w; anim.height = h; }
  const t = ts / 1000;
  actx.fillStyle = `hsl(${(t * 60) % 360} 60% 50%)`;
  actx.fillRect(0, 0, w, h);
  for (let i = 0; i < 24; i++) {
    actx.fillStyle = `hsl(${(i * 37 + t * 90) % 360} 80% 60%)`;
    actx.beginPath();
    actx.arc((Math.sin(t * (0.5 + i * 0.07) + i) * 0.5 + 0.5) * w, (Math.cos(t * (0.6 + i * 0.05) + i * 2) * 0.5 + 0.5) * h, 18 + (i % 5) * 6, 0, Math.PI * 2);
    actx.fill();
  }
  S.anim.frames++;
  requestAnimationFrame(animate);
}

// --- the API the checks call ----------------------------------------------------------------------------------------------
const api = {
  state(): Record<string, unknown> {
    return {
      token: S.token, loadedAt: S.loadedAt, navType: S.navType, now: Date.now(),
      ticks: S.ticks, lastTickAt: S.lastTickAt, sse: { ...S.sse },
      field: field.value, checked: (document.getElementById("check") as HTMLInputElement).checked,
      select: sel.value, focused: document.activeElement?.id ?? "", hasFocus: document.hasFocus(), visibility: document.visibilityState,
      innerWidth: window.innerWidth, innerHeight: window.innerHeight, dpr: window.devicePixelRatio, scrollY: window.scrollY,
      clicks: S.clicks.slice(-20), keys: S.keys.slice(-40), compositions: S.compositions.slice(-20), pastes: S.pastes.slice(-10),
      inputTypes: S.inputTypes.slice(-40), selects: S.selects.slice(), dialogs: S.dialogs.slice(), files: S.files.slice(),
      popup: { opened: S.popup.opened, messages: S.popup.messages.slice() }, drag: S.drag.slice(), resizes: S.resizes.slice(-20),
      scrolls: S.scrolls, wheels: S.wheels, lat: S.lat.slice(-60), anim: { ...S.anim }, smooth: { ...S.smooth },
      events: events.slice(-80),
    };
  },
  /** An element's box in CSS pixels, and its centre. */
  rect(id: string): { x: number; y: number; w: number; h: number; cx: number; cy: number } | null {
    const el = document.getElementById(id);
    if (el === null) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height, cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) };
  },
  /** What a bot does before the tab is shown: type in the field and tick the box (form state a reload would lose). */
  fill(text: string): void {
    field.value = text;
    (document.getElementById("check") as HTMLInputElement).checked = true;
  },
  latKeys(on: boolean): void { latKeys = on; },
  boxColor(): string { return boxRed ? "red" : "blue"; },
  anim(on: boolean): void {
    if (on === S.anim.on) return;
    S.anim.on = on;
    anim.style.display = on ? "block" : "none";
    if (on) { S.anim.frames = 0; S.anim.startedAt = Date.now(); requestAnimationFrame(animate); }
  },
  /** A smooth scroll to `top`; counts the scroll events and rAFs until it settles. */
  smoothScroll(top: number): void {
    S.smooth = { startedAt: Date.now(), endedAt: 0, scrollEvents: 0, rafs: 0 };
    const tick = (): void => {
      S.smooth.rafs++;
      if (Math.abs(window.scrollY - top) < 1) { S.smooth.endedAt = Date.now(); return; }
      if (Date.now() - S.smooth.startedAt > 5000) { S.smooth.endedAt = -1; return; }
      requestAnimationFrame(tick);
    };
    window.scrollTo({ top, behavior: "smooth" });
    requestAnimationFrame(tick);
  },
  scrollTop(): void { window.scrollTo(0, 0); },
  runDialog,
  focusField(): boolean { field.focus(); return document.activeElement === field; },
};
(window as unknown as { __vp: typeof api }).__vp = api;
log("load", document.visibilityState);
