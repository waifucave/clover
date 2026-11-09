// How the headless shell is started (spec §12.1, "Where no app runs"): one process per profile, each profile a folder
// named as the app names its partitions, its traffic all through the network filter, and nothing of its own that
// reaches out (no updates, no sync, no crash upload, no field trials, no discovery on the local network). Pure, so the
// flags are tested without a browser.
import { join, win32 } from "node:path";
import { AGENT_VIEWPORT, type TabOwner } from "../contract";
import { partitionFor } from "../policy";

/** A profile's folder name: its partition's, without `persist:` (`bot-<id>`, `bot-<pack>--<child>`,
 *  `session-<32 hex>`, `plugin-<id>`, `user`), so a profile here and a partition in the app name the same owner. */
export function profileName(owner: TabOwner): string {
  const partition = partitionFor(owner); // refuses a bad owner
  return partition.startsWith("persist:") ? partition.slice("persist:".length) : partition;
}

/** Where a profile lives: `<dir>/profiles/<name>`. Lane C's fenced set holds `<dir>/profiles/` (sign-ins in plain text
 *  on a server with no keyring). */
export function profileDir(dir: string, owner: TabOwner): string {
  return join(dir, "profiles", profileName(owner));
}

/** Features that phone home or reach the local network on their own: translation, optimization hints and model
 *  downloads, the media router's DIAL and mDNS discovery, autofill's server, certificate transparency's and other
 *  component updates, network time, the interest feed, the Privacy Sandbox's attestation fetches, the "Lens" overlay,
 *  back/forward and paint holding (behaviour the app's Electron doesn't have), HTTPS upgrades (a fixed proxy decides
 *  the path, not the browser). */
export const DISABLED_FEATURES: readonly string[] = [
  "Translate",
  "OptimizationHints",
  "OptimizationGuideModelDownloading",
  "OptimizationHintsFetching",
  "OnDeviceModelService",
  "MediaRouter",
  "DialMediaRouteProvider",
  "GlobalMediaControls",
  "AutofillServerCommunication",
  "CertificateTransparencyComponentUpdater",
  "NetworkTimeServiceQuerying",
  "InterestFeedContentSuggestions",
  "PrivacySandboxSettings4",
  "LensOverlay",
  "BackForwardCache",
  "PaintHolding",
  "HttpsUpgrades",
  "AcceptCHFrame",
];

export interface HeadlessArgsOptions {
  /** The profile's folder. */
  profile: string;
  /** Chromium's proxy rules for the profile's owner (`NetworkFilter.proxyFor`), passed as they are. */
  proxy: string;
}

/** The headless shell's switches, less the DevTools pipe's own (`launch.ts` adds those). Never `--no-sandbox`: on
 *  Linux the sandbox needs the AppArmor profile (S7 §5), and a start without it fails with Chromium's own message. */
export function headlessArgs(opts: HeadlessArgsOptions): string[] {
  if (opts.proxy.trim() === "" || /[\s"]/.test(opts.proxy)) throw new Error("the browser's proxy rules are missing or malformed");
  return [
    `--user-data-dir=${opts.profile}`,
    // Every connection through the filter, loopback included (`<-loopback>`: Chromium otherwise sends loopback direct),
    // so the owner's address policy (R13) holds for every request. A fixed proxy means no system proxy settings, PAC
    // script or WPAD discovery is ever consulted.
    `--proxy-server=${opts.proxy}`,
    "--proxy-bypass-list=<-loopback>",
    // No name is ever looked up outside the filter (the filter resolves each name itself, over SOCKS5): any lookup
    // the browser would make on its own (a prefetch, a direct connection) fails.
    "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
    // WebRTC sends no UDP outside the proxy, as the app's tabs (`BROWSER_WEBRTC_POLICY`).
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    "--no-first-run",
    "--no-default-browser-check",
    "--no-pings",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-component-extensions-with-background-pages",
    "--disable-extensions",
    "--disable-default-apps",
    "--disable-sync",
    "--disable-breakpad",
    "--disable-crash-reporter",
    "--disable-domain-reliability",
    "--disable-client-side-phishing-detection",
    "--disable-field-trial-config",
    "--safebrowsing-disable-auto-update",
    "--metrics-recording-only",
    "--disable-notifications",
    // A page's window opens as the app's do (its own handler decides, no blocker): here it becomes a tab of the owner.
    "--disable-popup-blocking",
    "--deny-permission-prompts",
    `--disable-features=${DISABLED_FEATURES.join(",")}`,
    // A server has no keyring: cookies are stored unencrypted in the profile, which lane C's fence keeps from Bash.
    "--password-store=basic",
    "--use-mock-keychain",
    "--mute-audio",
    "--force-device-scale-factor=1",
    `--window-size=${AGENT_VIEWPORT.width},${AGENT_VIEWPORT.height}`,
    // Background tabs keep their timers, as a bot's offscreen tab in the app does.
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
  ];
}

/** The browser's environment on Windows: a short list of the system's own variables Chromium needs, and a home of its
 *  own under `<dir>\\home` for everything it keeps (`TEMP`, `TMP`, `LOCALAPPDATA`, `APPDATA`, `USERPROFILE`), so nothing
 *  lands in the person's profile and none of the daemon's variables (tokens, keys, `PATH` entries) reach it. `PATH` is
 *  System32 only. Pure; paths are Windows paths whichever OS builds them. */
export function windowsBrowserEnv(dir: string, env: Record<string, string | undefined> = process.env): Record<string, string> {
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? env.windir ?? "C:\\Windows";
  const home = win32.join(dir, "home");
  const out: Record<string, string> = {
    SystemRoot: root,
    windir: root,
    SystemDrive: env.SystemDrive ?? root.slice(0, 2),
    ComSpec: win32.join(root, "System32", "cmd.exe"),
    PATH: win32.join(root, "System32"),
    TEMP: win32.join(home, "Temp"),
    TMP: win32.join(home, "Temp"),
    LOCALAPPDATA: win32.join(home, "LocalAppData"),
    APPDATA: win32.join(home, "AppData"),
    USERPROFILE: home,
  };
  for (const name of ["ProgramData", "ProgramFiles", "ProgramFiles(x86)", "CommonProgramFiles", "ALLUSERSPROFILE", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS", "OS"]) {
    const v = env[name];
    if (v !== undefined && v !== "") out[name] = v;
  }
  return out;
}

/** The folders a Windows browser's own home needs to exist (it won't make them). */
export function windowsBrowserDirs(env: Record<string, string>): string[] {
  return [env.TEMP!, env.LOCALAPPDATA!, env.APPDATA!, env.USERPROFILE!];
}

/** The browser's environment on macOS and Linux: only what it needs, never the daemon's own (its tokens and keys stay
 *  out of the browser's process), and a home of its own under `<dir>/home`, so nothing it keeps (NSS's database,
 *  caches, fontconfig's) lands in the person's home or `~/.cache`. On Windows, `windowsBrowserEnv`. Pure. */
export function browserEnv(dir: string, env: Record<string, string | undefined> = process.env, platform: string = process.platform): Record<string, string> {
  if (platform === "win32") return windowsBrowserEnv(dir, env);
  const home = join(dir, "home");
  const out: Record<string, string> = {
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    PATH: env.PATH ?? "/usr/bin:/bin",
    LANG: env.LANG ?? "C.UTF-8",
  };
  for (const name of ["TMPDIR", "TZ", "LC_ALL", "FONTCONFIG_PATH", "FONTCONFIG_FILE"]) {
    const v = env[name];
    if (v !== undefined && v !== "") out[name] = v;
  }
  return out;
}
