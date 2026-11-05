// The S7 Electron probe: runs the chosen checks in this OS's Electron and writes one JSON result.
//   electron out/electron/main.cjs --checks=move,throttle,capture,cost,stream,wake,shared,hostcheck[,long] --out=<file>
//                                   --label=<name>
// CI only: it opens windows. Every run gets its own temporary userData folder. It exits 1 when an assertion about
// what the report concludes fails (round eight), after writing everything it measured.
import { app, screen } from "electron";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, release, cpus, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { captureCheck, costCheck, hostCheck, longCheck, moveCheck, sharedHostCheck, throttleCheck, wakeCheck, type CaptureRow, type HostInvariants, type MoveResult, type SharedResult, type ThrottleRow, type WakeResult } from "./checks.ts";
import { Link, streamCheck } from "./stream.ts";
import { placeAvailable, TabHost } from "./tabs.ts";
import { startServer } from "../shared/server.ts";
import { errorText, rounded } from "../shared/stats.ts";

if (process.env.GITHUB_ACTIONS !== "true" && process.env.S7_ALLOW_LOCAL !== "1") {
  console.error("s7 probe: refusing to run here: it opens windows. It runs on GitHub Actions.");
  process.exit(2);
}

const ROOT = process.env.S7_ROOT ?? resolve(__dirname, "..", "..");
process.env.S7_ROOT = ROOT;

function arg(name: string, fallback: string): string {
  const p = `--${name}=`;
  const a = process.argv.find((x) => x.startsWith(p));
  return a === undefined ? fallback : a.slice(p.length);
}
const checks = arg("checks", "move,throttle,capture,cost,stream").split(",").filter(Boolean);
const outFile = resolve(arg("out", join(ROOT, "out", "results", "electron.json")));
const label = arg("label", `${process.platform}-${process.arch}`);
const budgetMin = Number(arg("budget-min", "25"));

// Never mDNS-hide local addresses: the WebRTC road runs on loopback.
app.commandLine.appendSwitch("disable-features", "WebRtcHideLocalIpsWithMdns");
const userData = mkdtempSync(join(tmpdir(), "clover-s7-electron-"));
app.setPath("userData", userData);
app.on("window-all-closed", () => { /* keep running: tabs live without windows */ });

const started = Date.now();
const log = (line: string): void => { console.log(`[s7 ${((Date.now() - started) / 1000).toFixed(1)}s] ${line}`); };
const results: Record<string, unknown> = {};
const errors: string[] = [];
interface Assertion { name: string; ok: boolean; detail: string }
let assertions: Assertion[] = [];

/** What the report concludes, checked against this run's numbers. */
function assertAll(): Assertion[] {
  const a: Assertion[] = [];
  const add = (name: string, ok: boolean, detail: unknown): void => { a.push({ name, ok, detail: typeof detail === "string" ? detail : JSON.stringify(detail) }); };
  const move = results.move as Record<string, MoveResult> | undefined;
  if (move !== undefined) {
    for (const [k, r] of Object.entries(move)) {
      add(`no reload when moving from ${k}`, r.error === undefined && r.checks.sameDocument === true && r.checks.fieldKept === true && r.checks.sseKept === true,
        { sameDocument: r.checks.sameDocument, fieldKept: r.checks.fieldKept, sseKept: r.checks.sseKept, error: r.error });
    }
  }
  const thr = results.throttle as ThrottleRow[] | undefined;
  if (thr !== undefined) {
    const row = (c: string): ThrottleRow | undefined => thr.find((r) => r.config === c);
    const host = row("1x1 shown window, throttling off");
    add("the 1x1 host draws (rAF above 10 Hz)", (host?.rates?.rafHz ?? 0) > 10, { rafHz: host?.rates?.rafHz, error: host?.error });
    const never = row("never-shown window, throttling off");
    add("a never-shown window draws nothing (rAF below 1 Hz)", never?.rates !== undefined && never.rates.rafHz < 1, { rafHz: never?.rates?.rafHz, error: never?.error });
  }
  const cap = results.capture as CaptureRow[] | undefined;
  if (cap !== undefined) {
    // round nine: at a scale factor other than 1 the design holds a bot's tab at 1280x800 and 1x by the CDP override
    // (round eight, Windows at 2x: a host tab without it laid out at 0x0 and drew nothing), so only that is asserted
    const dsf = screen.getPrimaryDisplay().scaleFactor;
    const r = cap.find((x) => x.place === "tinyWindow" && x.method === "capturePage" && x.variant === undefined);
    if (dsf === 1) add("capturePage works in the 1x1 host", r !== undefined && r.tries > 0 && r.ok === r.tries, { ok: r?.ok, tries: r?.tries, errors: r?.errors });
    const f = cap.find((x) => x.place === "tinyWindow" && x.method === "capturePage" && x.variant === "fit 1280x800 at 1x");
    add("capturePage works in the 1x1 host with the agent's 1280x800 at 1x held", f !== undefined && f.tries > 0 && f.ok === f.tries, { dsf, ok: f?.ok, tries: f?.tries, size: f?.size, errors: f?.errors });
  }
  const hc = results.hostcheck as HostInvariants | undefined;
  if (hc !== undefined) {
    add("the host never takes focus, even when its page asks", hc.error === undefined && hc.focusedAtStart === false && hc.focusedAfterPageGrab === false,
      { atStart: hc.focusedAtStart, afterGrab: hc.focusedAfterPageGrab, focusedWindow: hc.focusedWindowTitle, error: hc.error });
    if (process.platform === "win32") {
      const w = hc.windowsStyles;
      add("Windows: the host is a no-activate, click-through tool window, not an app window",
        typeof w === "object" && w.toolWindow && w.noActivate && w.transparent && !w.appWindow, w ?? "missing");
    }
    // round nine: on X11 the plain host takes a click on its one pixel (Electron keeps a 1x1 input region), so the
    // design's X11 host is the shaped one; the plain host's click is recorded, not asserted, there
    if (typeof hc.clickThrough === "object" && process.platform === "win32") {
      add("Windows: a real click at the host's point reaches the window below", hc.clickThrough.belowClicks >= 1 && hc.clickThrough.hostClicks === 0, hc.clickThrough);
    }
    if (hc.shaped !== undefined) {
      const sh = hc.shaped;
      add("X11: the host with an empty window shape draws and is pictured", sh.error === undefined && (sh.rates?.rafHz ?? 0) > 10 && sh.capture !== undefined && sh.capture.tries > 0 && sh.capture.ok === sh.capture.tries,
        { rafHz: sh.rates?.rafHz, capture: sh.capture, error: sh.error });
      add("X11: a real click at the shaped host's point reaches the window below", sh.clickThrough !== undefined && sh.clickThrough.belowClicks >= 1 && sh.clickThrough.hostClicks === 0, sh.clickThrough ?? sh.error ?? "missing");
    }
  }
  const wake = results.wake as WakeResult | undefined;
  if (wake !== undefined) {
    add("a resting tab draws within 2 s of moving into the host, every cycle",
      wake.error === undefined && wake.cycles.length > 0 && wake.cycles.every((c) => c.firstRafMs !== undefined && c.firstRafMs < 2000),
      { firstRafMs: wake.cycles.map((c) => c.firstRafMs), error: wake.error });
  }
  const shared = results.shared as SharedResult | undefined;
  if (shared !== undefined) {
    add("every tab in one shared host draws and is pictured",
      shared.error === undefined && shared.tabs.length > 0 && shared.tabs.every((t) => (t.rates?.rafHz ?? 0) > 10 && t.capture.ok === t.capture.tries),
      { tabs: shared.tabs.map((t) => ({ rafHz: t.rates?.rafHz, ok: t.capture.ok, tries: t.capture.tries })), error: shared.error });
  }
  return a;
}

function write(status: string): void {
  mkdirSync(dirname(outFile), { recursive: true });
  const meta = {
    label,
    status,
    platform: process.platform,
    arch: process.arch,
    osRelease: release(),
    cpus: cpus().length,
    memGiB: Math.round(totalmem() / 1073741824),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    ozone: app.commandLine.getSwitchValue("ozone-platform") || "(default)",
    sessionType: process.env.XDG_SESSION_TYPE ?? "",
    waylandDisplay: process.env.WAYLAND_DISPLAY ?? "",
    display: process.env.DISPLAY ?? "",
    displays: app.isReady() ? screen.getAllDisplays().map((d) => `${d.size.width}x${d.size.height}@${d.scaleFactor}`) : [],
    gpu: app.isReady() ? app.getGPUFeatureStatus() : {},
    seconds: (Date.now() - started) / 1000,
  };
  writeFileSync(outFile, JSON.stringify(rounded({ meta, checks: results, errors, assertions }, 2), null, 2));
}

setTimeout(() => {
  errors.push(`budget of ${budgetMin} min ran out`);
  write("timeout");
  app.exit(3);
}, budgetMin * 60_000).unref();

async function main(): Promise<void> {
  await app.whenReady();
  log(`electron ${process.versions.electron} (chrome ${process.versions.chrome}) on ${process.platform}-${process.arch}, ozone ${app.commandLine.getSwitchValue("ozone-platform") || "default"}, checks ${checks.join(",")}`);
  const link = new Link();
  const server = await startServer({
    pagesDir: join(ROOT, "out", "pages"),
    fixturesDir: join(ROOT, "fixtures"),
    onUpgrade: (req, socket, head) => link.upgrade(req, socket, head),
  });
  const host = new TabHost(server.origin);
  const run = async (name: string, f: () => Promise<unknown>): Promise<void> => {
    if (!checks.includes(name)) return;
    log(`check ${name}`);
    try {
      results[name] = await f();
    } catch (e) {
      errors.push(`${name}: ${errorText(e)}`);
      log(`check ${name} failed: ${errorText(e)}`);
    }
    await host.closeAll();
    write("running");
  };
  await run("move", async () => {
    const out: Record<string, unknown> = {};
    out.detached = await moveCheck(host, server, "detached", log);
    out.hiddenWindow = await moveCheck(host, server, "hiddenWindow", log);
    out.hiddenWindowFit = await moveCheck(host, server, "hiddenWindow", log, { fit: true });
    if (placeAvailable("invisibleWindow")) out.invisibleWindow = await moveCheck(host, server, "invisibleWindow", log);
    out.tinyWindow = await moveCheck(host, server, "tinyWindow", log);
    return out;
  });
  await run("throttle", () => throttleCheck(host, log));
  await run("capture", () => captureCheck(host, log));
  await run("cost", () => costCheck(host, log));
  await run("stream", () => streamCheck(host, server.origin, link, log));
  await run("wake", () => wakeCheck(host, log));
  await run("shared", () => sharedHostCheck(host, log));
  await run("hostcheck", () => hostCheck(host, server, log));
  await run("long", () => longCheck(host, log));
  assertions = assertAll();
  for (const x of assertions) log(`${x.ok ? "PASS" : "FAIL"} ${x.name}: ${x.detail.slice(0, 300)}`);
  write("done");
  await server.close();
  log(`done in ${((Date.now() - started) / 1000).toFixed(0)} s → ${outFile}`);
}

main()
  .catch((e) => {
    errors.push(`main: ${errorText(e)}`);
    write("failed");
  })
  .finally(() => {
    try { rmSync(userData, { recursive: true, force: true }); } catch { /* best effort */ }
    const failed = assertions.filter((x) => !x.ok).length + (errors.length > 0 ? 1 : 0);
    if (failed > 0) log(`${failed} assertion(s) or error(s): exit 1`);
    app.exit(failed > 0 ? 1 : 0);
  });
