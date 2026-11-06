// The app's side of the proxy setting (R14): reading the system's proxy with the OS's own tools, and running a PAC file
// with Chromium's own evaluator, in a session that does nothing else. The routes themselves are `proxy.ts`'s, shared
// with the core.
//
// The PAC session is in memory and holds no page: its only use is `resolveProxy`, and its only fetch is the PAC file,
// which Chromium makes itself. It is set to `pac_script` with the URL the system names, never `auto_detect` (WPAD)
// and never `system`.
import { execFile } from "node:child_process";
import { session as sessions, type Session } from "electron";
import { proxyRoutes, readSystemProxy, type BrowserProxySetting, type RunCommand } from "./proxy";
import type { UpstreamRoutes } from "./network";

export const PAC_PARTITION = "clover-browser-pac";

export const runCommand: RunCommand = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 5_000, windowsHide: true, maxBuffer: 1 << 20, encoding: "utf8" }, (error, stdout) => {
      // A tool that exits non-zero may still have said something (lsof exits 1 when a process has no connection).
      if (error !== null) reject(Object.assign(error, { stdout }));
      else resolve(stdout);
    });
  });

let pacSession: Session | undefined;
let pacUrlSet: { url: string; ready: Promise<void> } | undefined;

function pacSessionFor(url: string): { session: Session; ready: Promise<void> } {
  if (pacSession === undefined) {
    const s = sessions.fromPartition(PAC_PARTITION);
    s.setPermissionRequestHandler((_c, _p, callback) => callback(false));
    s.setPermissionCheckHandler(() => false);
    s.on("will-download", (event) => event.preventDefault());
    pacSession = s;
  }
  if (pacUrlSet === undefined || pacUrlSet.url !== url) {
    const s = pacSession;
    pacUrlSet = { url, ready: s.setProxy({ mode: "pac_script", pacScript: url }) };
  }
  return { session: pacSession, ready: pacUrlSet.ready };
}

/** Chromium's answer for `url` under the PAC file at `pacUrl` (`PROXY a:1; DIRECT`). */
export async function resolvePac(pacUrl: string, url: string): Promise<string> {
  const { session, ready } = pacSessionFor(pacUrl);
  await ready;
  return session.resolveProxy(url);
}

/** The filter's routes for the setting, in the app. */
export function appProxyRoutes(setting: BrowserProxySetting, log?: (line: string) => void): UpstreamRoutes | undefined {
  return proxyRoutes(setting, {
    readSystem: () => readSystemProxy({ platform: process.platform, run: runCommand, env: process.env }),
    pac: resolvePac,
    ...(log !== undefined ? { log } : {}),
  });
}

/** The host is shutting down: the PAC session goes with it. */
export function resetPacSession(): void {
  pacSession = undefined;
  pacUrlSet = undefined;
}
