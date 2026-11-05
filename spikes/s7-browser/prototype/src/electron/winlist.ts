// Round twelve: the windows of this process that are on screen, as the OS sees them — the proof that offscreen tabs
// make no window, and whether a page's dialog, file chooser or <select> put one up. macOS: CGWindowListCopyWindowInfo
// (on-screen only) through JavaScript for Automation; Windows: EnumWindows + IsWindowVisible; X11: xdotool's visible
// windows of this pid (Chromium and GTK set _NET_WM_PID). Wayland has no way to list another client's windows.
// Asynchronous: a listing never blocks the main process (its frames keep coming while it runs).
import { execFile } from "node:child_process";
import { onWayland } from "./tabs.ts";
import { errorText } from "../shared/stats.ts";

export interface WindowListing {
  tool: string;
  /** One line per window: what the OS calls it, its size and place. */
  windows?: string[];
  error?: string;
  ms: number;
}

function run(file: string, args: string[], timeout = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: "utf8", timeout, windowsHide: true, maxBuffer: 4 << 20 }, (e, stdout, stderr) => {
      if (e !== null) reject(new Error(`${e.message}${stderr ? `: ${String(stderr).slice(0, 300)}` : ""}`));
      else resolve(String(stdout));
    });
  });
}

const JXA = (pid: number): string => `
ObjC.import('CoreGraphics');
var ref = $.CGWindowListCopyWindowInfo(1 | 16, 0);
var list = ObjC.deepUnwrap(ObjC.castRefToObject(ref)) || [];
var mine = list.filter(function (w) { return w.kCGWindowOwnerPID === ${pid}; });
JSON.stringify(mine.map(function (w) { var b = w.kCGWindowBounds || {}; return 'layer ' + w.kCGWindowLayer + ' alpha ' + w.kCGWindowAlpha + ' ' + b.Width + 'x' + b.Height + '+' + b.X + '+' + b.Y + (w.kCGWindowName ? ' "' + w.kCGWindowName + '"' : ''); }));
`;

const PS = (pid: number): string => `
Add-Type -TypeDefinition @"
using System; using System.Text; using System.Runtime.InteropServices; using System.Collections.Generic;
public static class S7Win {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  public struct RECT { public int L, T, R, B; }
  public static List<string> List(uint pid) {
    var o = new List<string>();
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p == pid && IsWindowVisible(h)) {
        var c = new StringBuilder(256); GetClassName(h, c, 256);
        var t = new StringBuilder(256); GetWindowText(h, t, 256);
        RECT r; GetWindowRect(h, out r);
        o.Add(c + " " + (r.R - r.L) + "x" + (r.B - r.T) + "+" + r.L + "+" + r.T + " ex 0x" + GetWindowLong(h, -20).ToString("x") + " \\"" + t + "\\"");
      }
      return true;
    }, IntPtr.Zero);
    return o;
  }
}
"@
[S7Win]::List(${pid}) | ForEach-Object { $_ }
`;

/** The on-screen windows of process `pid` (the Electron main process owns every window of the app). */
export async function visibleWindows(pid = process.pid): Promise<WindowListing> {
  const t0 = Date.now();
  try {
    if (process.platform === "darwin") {
      const out = await run("osascript", ["-l", "JavaScript", "-e", JXA(pid)]);
      return { tool: "CGWindowListCopyWindowInfo (on screen)", windows: JSON.parse(out.trim() || "[]") as string[], ms: Date.now() - t0 };
    }
    if (process.platform === "win32") {
      const out = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", PS(pid)], 60_000);
      return { tool: "EnumWindows + IsWindowVisible", windows: out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean), ms: Date.now() - t0 };
    }
    if (process.platform === "linux" && !onWayland() && process.env.DISPLAY) {
      let ids: string[] = [];
      try {
        ids = (await run("xdotool", ["search", "--onlyvisible", "--pid", String(pid), "--name", ".*"])).split(/\s+/).filter(Boolean);
      } catch (e) {
        // xdotool exits 1 when nothing matches
        if (!/exit code 1|Command failed/.test(errorText(e))) throw e;
      }
      const windows: string[] = [];
      for (const id of ids) {
        const info = await run("xwininfo", ["-id", id]).catch((e: unknown) => `xwininfo failed: ${errorText(e)}`);
        if (info.includes("(the root window)")) continue; // xdotool's search can return the root window itself
        const pick = (re: RegExp): string => re.exec(info)?.[1]?.trim() ?? "?";
        windows.push(`${id} ${pick(/Width:\s*(\d+)/)}x${pick(/Height:\s*(\d+)/)}+${pick(/Absolute upper-left X:\s*(-?\d+)/)}+${pick(/Absolute upper-left Y:\s*(-?\d+)/)} ${pick(/Map State:\s*(\S+)/)} ${pick(/xwininfo: Window id: \S+ (.*)/)}`);
      }
      return { tool: "xdotool search --onlyvisible --pid", windows, ms: Date.now() - t0 };
    }
    return { tool: "none", error: "no way to list windows here (Wayland or no display)", ms: Date.now() - t0 };
  } catch (e) {
    return { tool: process.platform, error: errorText(e), ms: Date.now() - t0 };
  }
}
