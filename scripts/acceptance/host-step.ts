// The background host's row (lane HS; spec revision 19 §3.1, §3.4, §12.1, items 98, 111, 116, 121): run.ts's `host` unit
// (`--units host`, serial: its own home, its own daemon, which starts the host itself from this checkout through
// `MOSS_HOST_COMMAND`, the engine's source seam). The probes and the row's name live here; run.ts drives the processes.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Cdp } from "./cdp";

export const HOST_STEP = "the background host (lane HS): the engine starts it with no app window, one island in it and none in MOSS Code's window; with the window's process quit the island draws a pending card and takes its press, a background part keeps making its muted tone, and a bot's Browser tool opens a page; a restarted engine adopts the running host and starts no second; three crashes in two minutes start it in safe mode with no third-party part mounted, the engine's plugins still running";

/** The pid holding the host lock (the file's word, read under the host's own lock; only a live holder writes it). */
export function hostLockPid(home: string): number | undefined {
  try {
    const pid = Number(readFileSync(join(home, "run", "host.lock"), "utf8").trim().split(/\s+/)[0]);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

export function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** The island's own window in a program's DevTools targets. */
export function islandTarget(cdp: Cdp): { url: string } | undefined {
  return [...cdp.frames.values()].find((f) => f.type === "page" && f.url.startsWith("moss-core://app/?surface=island"));
}

/** A background fixture part's attributes (manifest-fields-step.ts's `Ticker`), read in whichever program mounts it. */
export async function backgroundPart(cdp: Cdp, id: string): Promise<Record<string, string> | undefined> {
  for (const d of (await cdp.documents()).filter((x) => x.url.startsWith(`moss-plugin://${id}/`))) {
    const v = await cdp.evaluate(d.session, `(() => { const e = document.querySelector('[data-acc-background]'); return e ? JSON.stringify(Object.fromEntries([...e.attributes].map((a) => [a.name, a.value]))) : ''; })()`).catch(() => "");
    if (typeof v === "string" && v !== "") return JSON.parse(v) as Record<string, string>;
  }
  return undefined;
}

/** The on-screen windows (macOS's window server, `onscreen-windows.swift`): owner pid, opacity and size; never titles. */
export function onscreenWindows(swiftScript: string): { pid: number; alpha: number; w: number; h: number }[] | undefined {
  if (process.platform !== "darwin") return undefined;
  const r = spawnSync("swift", [swiftScript], { encoding: "utf8", timeout: 120_000 });
  if (r.status !== 0) return undefined;
  return (r.stdout ?? "").split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as { pid: number; alpha: number; w: number; h: number });
}

/** The browser rows again with the background host running (the controller's ruling): the same row, its pages in the host. */
export const BROWSER_HOST_STEP = "the Browser rows again with the background host running (lane HS): the pages in the host, the cards pressed where the router put them, MOSS Code's panel drawing the host's tabs";

export const HOST_GAVE_UP_STEP = "a host that never starts (lane HS, the reviewer's B2, never nowhere): the engine gives up after its bounded starts, and with no window focused a plugin's OK card goes to MOSS Code's window's strip and is shown on its own fallback card, where a real press answers it";

export const SURFACE_COPY_HOST_STEP = "the island and pill copies' row again with the background host running (lane HS, the controller's R12 ruling): the copy island in the host is the OK card's drawer and stays while a third-party part holding no card stands down, and takes the press";

/** How many times a daemon log says the host was ready. */
export function readyCount(log: string): number {
  return (log.match(/\[host\] ready: /g) ?? []).length;
}
