// The S7 Electron probe: runs the chosen checks in this OS's Electron and writes one JSON result.
//   electron out/electron/main.cjs --checks=move,throttle,capture,cost,stream[,long] --out=<file> --label=<name>
// CI only: it opens windows. Every run gets its own temporary userData folder.
import { app, screen } from "electron";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, release, cpus, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { captureCheck, costCheck, longCheck, moveCheck, throttleCheck } from "./checks.ts";
import { Link, streamCheck } from "./stream.ts";
import { placeAvailable, TabHost } from "./tabs.ts";
import { startServer } from "../shared/server.ts";
import { errorText, rounded } from "../shared/stats.ts";

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
  writeFileSync(outFile, JSON.stringify(rounded({ meta, checks: results, errors }, 2), null, 2));
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
  await run("long", () => longCheck(host, log));
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
    app.exit(0);
  });
