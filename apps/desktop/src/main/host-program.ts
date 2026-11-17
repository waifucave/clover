// The background host as a program (spec revision 19, §3.1 "The host is a nested helper app with one fixed
// identifier", §3.4, items 98, 112, 116 and 121; ruling R7; lane HS). The same app code runs as MOSS Code's window
// process or as the host: a windowless process the engine starts and keeps alive, which mounts the screen's points and
// the background parts (`SURFACE_MOUNTS.host`) and runs the browser's pages, with no window of its own.
//
// * Which program: the packaged helper says so by its bundle identifier (`com.waifucave.moss.host`, the dev form
//   `.dev`), a run from source by `--moss-program=host`. Nothing else makes a process the host.
// * Its own identity, user data and single-instance lock, the same whichever app's copy it runs from: its name names
//   its user-data folder and its protected storage, so its grants and prefs never change with the copy.
// * The host lock (`HOST_LOCK_FILE`), an OS lock held for the process's life: on macOS the file opened with `O_EXLOCK`,
//   which the kernel lets go when the process ends, so the engine (`packages/core/src/host/world.ts`) never takes a
//   reused pid for a live host. Windows and Linux have no lock-on-open flag: there the host relies on Electron's own
//   single-instance lock, and the engine on the second-host refusal.
// Pure apart from the files it is handed: no Electron import, so Bun tests it (test/host-program.test.ts).
import { closeSync, constants, ftruncateSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { HOST_LOCK_FILE, HOST_START_FILE, HOST_START_FILE_TTL_MS, MOSS_ERR, PROGRAM_IDENTIFIERS, type MidWork, type MossHelloParams } from "@waifucave/moss-protocol";
import { translate, type StringTable } from "@waifucave/moss-plugin-sdk/ui/bridge";
import type { MenuItemConstructorOptions } from "electron";
import type { AppIdentity, AppProfile } from "./identity";
import { CORE_STRINGS_EN } from "./ui/core-strings";
import type { TrayState } from "./tray-menu";

export type DesktopProgram = "code" | "host";

/** The host's switch on the command line, for a run from source (the packaged helper is the host by its identifier). */
export const HOST_PROGRAM_ARG = "--moss-program=host";

/** The host helper's bundle names (scripts/host-helper.mjs lays them out with the host's identifier). */
export const HOST_BUNDLE_NAMES = ["MOSS Host.app", "MOSS Host Dev.app"] as const;

/** Which program this process is: the host when it runs from the host's helper bundle (whose identifier is the host's,
 *  `PROGRAM_IDENTIFIERS.host`), or a run from source says so; anything else is MOSS Code's window. */
export function desktopProgram(argv: readonly string[], execPath = ""): DesktopProgram {
  if (HOST_BUNDLE_NAMES.some((n) => execPath.includes(`/${n}/Contents/MacOS/`))) return "host";
  return argv.includes(HOST_PROGRAM_ARG) ? "host" : "code";
}


/** The host's profile and home: the dev helper (`MOSS Host Dev.app`, which Launch Services starts with no environment
 *  unless the engine passes one) is always the dev profile, on `MOSS_HOME` or else `~/.moss-dev`, never the dist home;
 *  anything else follows the app's own rule (`MOSS_PROFILE`, `MOSS_HOME` or `~/.moss`). */
export function hostProfileAndHome(env: Record<string, string | undefined>, execPath: string, userHome: string): { profile: AppProfile; home: string } {
  const devHelper = execPath.includes("/MOSS Host Dev.app/Contents/MacOS/");
  const profile: AppProfile = devHelper || env.MOSS_PROFILE === "dev" ? "dev" : "dist";
  const home = env.MOSS_HOME !== undefined && env.MOSS_HOME !== "" ? env.MOSS_HOME : join(userHome, devHelper ? ".moss-dev" : ".moss");
  if (devHelper && home === join(userHome, ".moss")) throw new Error("the dev host never runs on MOSS's dist home");
  return { profile, home };
}

/** The host's identity per profile: its fixed identifier, and the name its user data and protected storage take. */
export function hostIdentity(profile: AppProfile): AppIdentity {
  return profile === "dev"
    ? { profile, appId: PROGRAM_IDENTIFIERS.host.dev, productName: "MOSS Host Dev" }
    : { profile, appId: PROGRAM_IDENTIFIERS.host.dist, productName: "MOSS Host" };
}

/** The user-data folder a headless or test run keeps under the home, per program (the host never shares the window's). */
export function headlessUserData(home: string, program: DesktopProgram, profile: AppProfile): string {
  return join(home, "app-data", program === "host" ? `host-${profile}` : profile);
}

/** macOS's lock-on-open flags (`<sys/fcntl.h>`), the engine's own (`world.ts`). */
const DARWIN_O_EXLOCK = 0x20;
const DARWIN_O_NONBLOCK = 0x4;

export interface HostLock {
  /** Whether the OS holds a lock for this process (macOS); false where only the single-instance lock stands. */
  readonly os: boolean;
  release(): void;
}

/** Takes the host lock under `home` for this process's life, writing its pid into the file under the lock. Null when
 *  another live host holds it (this one must quit before its hello). */
/** How often the host tries its lock, and how long between, before it takes the holder for another host. */
export const HOST_LOCK_TRIES = 5;
export const HOST_LOCK_RETRY_MS = 40;

export function takeHostLock(home: string, platform: NodeJS.Platform, pid: number = process.pid): HostLock | null {
  if (platform !== "darwin") return { os: false, release() {} };
  const path = join(home, HOST_LOCK_FILE);
  mkdirSync(dirname(path), { recursive: true });
  // The engine's probe of the lock (a shared lock held for a moment) can be in the way: a few tries before "another host".
  let fd: number | undefined;
  for (let i = 0; fd === undefined; i++) {
    try {
      fd = openSync(path, constants.O_RDWR | constants.O_CREAT | DARWIN_O_EXLOCK | DARWIN_O_NONBLOCK, 0o600);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "EAGAIN" && code !== "EWOULDBLOCK") throw e;
      if (i >= HOST_LOCK_TRIES - 1) return null;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, HOST_LOCK_RETRY_MS);
    }
  }
  ftruncateSync(fd, 0);
  writeSync(fd, `${pid}\n`, 0);
  let held = true;
  return {
    os: true,
    release() {
      if (!held) return;
      held = false;
      try { closeSync(fd); } catch { /* gone */ }
    },
  };
}

/** The engine's start file for the host (`HOST_START_FILE`): read once and deleted; honoured for its TTL. */
export function readHostStart(home: string, now: number = Date.now()): { byEngine: boolean; safeMode: boolean } {
  const path = join(home, HOST_START_FILE);
  let raw: string;
  try { raw = readFileSync(path, "utf8"); } catch { return { byEngine: false, safeMode: false }; }
  rmSync(path, { force: true });
  try {
    const v = JSON.parse(raw) as { by?: unknown; safeMode?: unknown; at?: unknown };
    if (typeof v.at !== "number" || now - v.at > HOST_START_FILE_TTL_MS || v.at - now > 5_000) return { byEngine: false, safeMode: false };
    return { byEngine: v.by === "engine", safeMode: v.safeMode === true };
  } catch {
    return { byEngine: false, safeMode: false };
  }
}

/** How the host was started, in the shape the app's start info has: by the engine (its start file) or by a person. */
export function hostStartInfo(home: string, now: number = Date.now()): { by: "daemon" | "user"; safeMode: boolean } {
  const s = readHostStart(home, now);
  return { by: s.byEngine ? "daemon" : "user", safeMode: s.safeMode };
}

/** The host's hello: the `app` role with `surface: "host"` and its own build's `release` (one release, lane RL: a hello
 *  with none counts as behind). It handles the engine's tab requests (`browser`), plugin layers and `app.quit`; it shows
 *  no window (`app.show` is the windows'). */
export function hostHello(token: string, version: string, protocolVersion: number, release: string = version): MossHelloParams {
  return {
    protocolVersion,
    role: "app",
    token,
    surface: "host",
    release,
    clientName: `MOSS Host ${version}`.slice(0, 128),
    features: ["app.quit", "layers", "browser"],
  };
}

/** How long a hello refused as a second host waits before it tries again (a dead host's connection lasts until the
 *  engine's heartbeat ends it, up to 15 s), or undefined for any other refusal. */
export function secondHostRetryMs(err: { code?: unknown; data?: unknown }, attempt: number): number | undefined {
  if (err.code !== MOSS_ERR.SURFACE_REFUSED) return undefined;
  if ((err.data as { reason?: unknown } | undefined)?.reason !== "second-host") return undefined;
  return attempt < 20 ? 1_000 : 5_000;
}

// -------------------------------------------------------------------------------------------------
// The host's menu-bar menu (item 112): open MOSS, open MOSS Code, the plugins' lines, and "stop everything", worded so
// that it can't be read as quitting the bots' app, which warns first when something is mid-work.
// -------------------------------------------------------------------------------------------------

export interface HostTrayActions {
  /** A click on the icon itself (Windows, Linux): opens MOSS Code. */
  open?(): void;
  openMoss(): void;
  openCode(): void;
  /** "Stop everything": asks the engine (`host.menu`), which answers what is mid-work before it acts. */
  stopEverything(): void;
  /** The host's own safe mode (§5.8): it leaves for safe mode and the engine starts it again so. */
  safeMode(): void;
  line?(ref: string): void;
  toggleFourFingerTap?(): void;
  toggleSoundMute?(): void;
}

const ENGLISH: StringTable = { lang: "en", strings: CORE_STRINGS_EN };

export function hostTrayMenu(state: TrayState, actions: HostTrayActions, strings: StringTable = state.strings ?? ENGLISH): MenuItemConstructorOptions[] {
  const t = (key: string, vars?: Record<string, string>) => translate(strings, `moss.core.${key}`, vars);
  return [
    ...(state.status !== undefined ? [{ label: state.status, enabled: false }, { type: "separator" as const }] : []),
    { label: t("host-tray.open-moss"), click: () => actions.openMoss() },
    { label: t("host-tray.open-code"), click: () => actions.openCode() },
    ...(actions.line !== undefined && (state.lines?.length ?? 0) > 0 ? [{ type: "separator" as const }] : []),
    ...(actions.line !== undefined ? (state.lines ?? []).map((l) => ({ label: l.hidden === undefined ? l.title : t(l.hidden ? "tray.show-item" : "tray.hide-item", { title: l.title }), click: () => actions.line?.(l.ref) })) : []),
    ...(state.fourFingerTap !== undefined && (state.tapTitles?.length ?? 0) > 0 && actions.toggleFourFingerTap !== undefined ? [{ label: t("tray.four-finger-tap", { titles: state.tapTitles!.join(", ") }), type: "checkbox" as const, checked: state.fourFingerTap, click: () => actions.toggleFourFingerTap?.() }] : []),
    ...(state.soundMuted !== undefined && actions.toggleSoundMute !== undefined ? [{ label: t("tray.mute-sound"), type: "checkbox" as const, checked: state.soundMuted, click: () => actions.toggleSoundMute?.() }] : []),
    ...(state.safeMode ? [] : [{ label: t("host-tray.safe-mode"), click: () => actions.safeMode() }]),
    { type: "separator" },
    { label: t("host-tray.stop-everything"), click: () => actions.stopEverything() },
  ];
}

/** The warning "stop everything" shows when the engine says something is mid-work: its message and its two buttons. */
export function midWorkWarning(working: MidWork, strings: StringTable = ENGLISH): { message: string; detail: string; buttons: [string, string] } {
  const t = (key: string, vars?: Record<string, string>) => translate(strings, `moss.core.${key}`, vars);
  const parts = [
    working.turns > 0 ? t("host-tray.working.turns", { n: String(working.turns) }) : undefined,
    working.agents > 0 ? t("host-tray.working.agents", { n: String(working.agents) }) : undefined,
    working.routines > 0 ? t("host-tray.working.routines", { n: String(working.routines) }) : undefined,
  ].filter((p): p is string => p !== undefined);
  return {
    message: t("host-tray.working.title"),
    detail: t("host-tray.working.detail", { work: parts.join(", ") }),
    buttons: [t("host-tray.working.keep"), t("host-tray.working.stop")],
  };
}
