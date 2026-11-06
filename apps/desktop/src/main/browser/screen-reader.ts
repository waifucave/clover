// The screen-reader switch (the owner's decision 93, the hybrid): while a screen reader is on, a bot's NEW tabs start
// as real views in a hidden host window, so a person who relies on one takes a tab over as a real view, with no
// reload. The switch only decides where a new tab starts; it never moves a tab that exists.
//
// How it knows: each OS's own screen-reader signal where the app can read it without native code, and Electron's
// accessibility state as the fallback. Electron's state alone turns on for any assistive client (on macOS, window
// managers and other accessibility tools ask for the app's tree too), which would put more people on the host
// than need it, so an OS signal that answers wins.
//   macOS    VoiceOver's own flag (`defaults read com.apple.universalaccess voiceOverOnOffKey`); a native module
//            observing `NSWorkspace.isVoiceOverEnabled` would be exact, and is lane E's to add if wanted
//   Windows  a running screen reader: Narrator, NVDA or JAWS (`tasklist`); the system's SPI_GETSCREENREADER flag
//            needs native code
//   Linux    AT-SPI's `org.a11y.Status.ScreenReaderEnabled` on the session's accessibility bus (`gdbus`), which
//            Orca sets
import { execFile } from "node:child_process";

export interface ScreenReaderProbe {
  readonly name: string;
  /** True or false when the OS says; undefined when it can't be read here. */
  read(): Promise<boolean | undefined>;
}

export function parseMacVoiceOver(stdout: string): boolean | undefined {
  const v = stdout.trim();
  return v === "1" ? true : v === "0" ? false : undefined;
}

const WINDOWS_READERS = ["narrator.exe", "nvda.exe", "jfw.exe"];
export function parseWindowsTasklist(stdout: string): boolean | undefined {
  if (stdout.trim() === "") return undefined;
  const names = stdout.split(/\r?\n/).map((line) => line.split(",")[0]?.replace(/"/g, "").trim().toLowerCase()).filter(Boolean);
  return names.some((n) => WINDOWS_READERS.includes(n as string));
}

export function parseGdbusBool(stdout: string): boolean | undefined {
  const m = /\(<(true|false)>,?\)/.exec(stdout);
  return m === null ? undefined : m[1] === "true";
}

function run(file: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(file, args, { encoding: "utf8", timeout: 5000, windowsHide: true }, (e, stdout) => resolve(e === null ? String(stdout) : undefined));
  });
}

export function defaultProbes(platform: NodeJS.Platform = process.platform): ScreenReaderProbe[] {
  if (platform === "darwin") {
    return [{ name: "VoiceOver", read: async () => { const out = await run("defaults", ["read", "com.apple.universalaccess", "voiceOverOnOffKey"]); return out === undefined ? undefined : parseMacVoiceOver(out); } }];
  }
  if (platform === "win32") {
    return [{ name: "Narrator, NVDA or JAWS", read: async () => { const out = await run("tasklist", ["/FO", "CSV", "/NH"]); return out === undefined ? undefined : parseWindowsTasklist(out); } }];
  }
  if (platform === "linux") {
    return [{
      name: "AT-SPI",
      read: async () => {
        const out = await run("gdbus", ["call", "--session", "--dest", "org.a11y.Bus", "--object-path", "/org/a11y/bus", "--method", "org.freedesktop.DBus.Properties.Get", "org.a11y.Status", "ScreenReaderEnabled"]);
        return out === undefined ? undefined : parseGdbusBool(out);
      },
    }];
  }
  return [];
}

export interface AccessibilityState {
  isAccessibilitySupportEnabled(): boolean;
  on(event: "accessibility-support-changed", listener: (event: unknown, enabled: boolean) => void): unknown;
}

export interface ScreenReaderSwitchOptions {
  electron: AccessibilityState;
  probes?: ScreenReaderProbe[];
  /** How often the OS signals are read again (Electron's own change event comes at once). */
  pollMs?: number;
  /** A fixed answer, for tests and for a person who sets it in Settings. */
  override?: boolean;
  onChange?: (on: boolean) => void;
}

export class ScreenReaderSwitch {
  private state = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly probes: ScreenReaderProbe[];

  constructor(private readonly opts: ScreenReaderSwitchOptions) {
    this.probes = opts.probes ?? defaultProbes();
  }

  get on(): boolean {
    return this.opts.override ?? this.state;
  }

  async start(): Promise<void> {
    this.opts.electron.on("accessibility-support-changed", () => void this.refresh());
    await this.refresh();
    if (this.opts.override === undefined) this.timer = setInterval(() => void this.refresh(), this.opts.pollMs ?? 5000);
    this.timer?.unref?.();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Reads the signals once: an OS signal that answers decides; Electron's state is the fallback. */
  async refresh(): Promise<boolean> {
    const answers = await Promise.all(this.probes.map((p) => p.read().catch(() => undefined)));
    const known = answers.filter((a): a is boolean => a !== undefined);
    const next = known.length > 0 ? known.some(Boolean) : this.opts.electron.isAccessibilitySupportEnabled();
    if (next !== this.state) {
      this.state = next;
      if (this.opts.override === undefined) this.opts.onChange?.(next);
    }
    return this.on;
  }
}
