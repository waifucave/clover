// The background host as a program (lane HS): which process is the host, its own identity, its OS lock, the engine's
// start file, its hello and the second-host retry, its menu-bar menu, and a tab's pictures to the engine.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOST_LOCK_FILE, HOST_START_FILE, MOSS_ERR } from "@waifucave/moss-protocol";
import { HOST_PROGRAM_ARG, desktopProgram, headlessUserData, hostHello, hostIdentity, hostTrayMenu, midWorkWarning, readHostStart, secondHostRetryMs, takeHostLock, hostProfileAndHome } from "../src/main/host-program";
import { TabFrameSender, jpegSize, type HostTabFrameParams } from "../src/main/browser/frame-sender";
import { CORE_STRINGS_EN } from "../src/main/ui/core-strings";

const root = mkdtempSync(join(tmpdir(), "moss-host-program-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const newHome = () => { const h = join(root, `h${n++}`); mkdirSync(join(h, "run"), { recursive: true }); return h; };

describe("which program", () => {
  test("the host by its own identifier or the source run's switch; anything else is MOSS Code's window", () => {
    expect(desktopProgram([], "/Applications/MOSS Code.app/Contents/Frameworks/MOSS Host.app/Contents/MacOS/MOSS Host")).toBe("host");
    expect(desktopProgram([], "/Applications/MOSS.app/Contents/Frameworks/MOSS Host Dev.app/Contents/MacOS/MOSS Host Dev")).toBe("host");
    expect(desktopProgram([HOST_PROGRAM_ARG])).toBe("host");
    expect(desktopProgram([], "/Applications/MOSS Code.app/Contents/MacOS/MOSS Code")).toBe("code");
    expect(desktopProgram(["--moss-program=hosts"])).toBe("code");
  });

  test("the host's identity and user data are its own, the same from either app's copy", () => {
    expect(hostIdentity("dist")).toEqual({ profile: "dist", appId: "com.waifucave.moss.host", productName: "MOSS Host" });
    expect(hostIdentity("dev").appId).toBe("com.waifucave.moss.host.dev");
    expect(headlessUserData("/h", "host", "dist")).toBe(join("/h", "app-data", "host-dist"));
    expect(headlessUserData("/h", "code", "dist")).toBe(join("/h", "app-data", "dist"));
  });
});

describe.if(process.platform === "darwin")("the host lock (macOS)", () => {
  test("one holder at a time; let go, the next takes it; the pid is in the file", async () => {
    const home = newHome();
    const a = takeHostLock(home, "darwin", 1234);
    expect(a?.os).toBe(true);
    expect(takeHostLock(home, "darwin", 5678)).toBeNull();
    expect((await Bun.file(join(home, HOST_LOCK_FILE)).text()).trim()).toBe("1234");
    a!.release();
    const b = takeHostLock(home, "darwin", 5678);
    expect(b).not.toBeNull();
    expect((await Bun.file(join(home, HOST_LOCK_FILE)).text()).trim()).toBe("5678");
    b!.release();
  });
});

test("Windows and Linux: no OS lock (Electron's single-instance lock stands)", () => {
  expect(takeHostLock(newHome(), "linux")?.os).toBe(false);
});

test("the engine's start file is read once, honoured only while fresh", () => {
  const home = newHome();
  writeFileSync(join(home, HOST_START_FILE), JSON.stringify({ by: "engine", safeMode: true, at: 1_000 }));
  expect(readHostStart(home, 2_000)).toEqual({ byEngine: true, safeMode: true });
  expect(readHostStart(home, 2_000)).toEqual({ byEngine: false, safeMode: false });
  writeFileSync(join(home, HOST_START_FILE), JSON.stringify({ by: "engine", safeMode: true, at: 1_000 }));
  expect(readHostStart(home, 1_000 + 61_000)).toEqual({ byEngine: false, safeMode: false });
});

test("the host's hello names the host surface and the browser, and retries a second-host refusal only", () => {
  const h = hostHello("t", "1.111.1", 7);
  expect(h).toMatchObject({ role: "app", surface: "host", token: "t", protocolVersion: 7, release: "1.111.1" });
  expect(h.features).toContain("browser");
  expect(h.features).not.toContain("app.show");
  expect(secondHostRetryMs({ code: MOSS_ERR.SURFACE_REFUSED, data: { reason: "second-host" } }, 0)).toBe(1_000);
  expect(secondHostRetryMs({ code: MOSS_ERR.SURFACE_REFUSED, data: { reason: "second-host" } }, 30)).toBe(5_000);
  expect(secondHostRetryMs({ code: MOSS_ERR.SURFACE_REFUSED, data: { reason: "not-app" } }, 0)).toBeUndefined();
  expect(secondHostRetryMs({ code: -32000 }, 0)).toBeUndefined();
});

describe("the host's menu", () => {
  test("open MOSS, open MOSS Code, the plugins' lines and stop everything, whose words can't be read as quitting the bots' app", () => {
    const clicks: string[] = [];
    const menu = hostTrayMenu({ safeMode: false, lines: [{ ref: "x#island", title: "Island", hidden: false }] }, {
      openMoss: () => clicks.push("moss"), openCode: () => clicks.push("code"), stopEverything: () => clicks.push("stop"), safeMode: () => clicks.push("safe"), line: (r) => clicks.push(r),
    });
    const labels = menu.map((m) => m.label).filter(Boolean);
    expect(labels).toEqual(["Open MOSS", "Open MOSS Code", "Hide Island", "Restart On-Screen Parts in Safe Mode", "Stop Everything (All Bots, Agents and Both Apps)…"]);
    for (const m of menu) (m.click as (() => void) | undefined)?.();
    expect(clicks).toEqual(["moss", "code", "x#island", "safe", "stop"]);
    expect(labels.some((l) => /^Quit MOSS$/.test(l!))).toBe(false);
  });

  test("the warning names what is mid-work", () => {
    const w = midWorkWarning({ turns: 2, agents: 1, routines: 0 });
    expect(w.detail).toContain("2 replies, 1 agents");
    expect(w.detail).not.toContain("routines");
    expect(w.buttons).toEqual(["Keep Working", "Stop Everything"]);
    for (const k of ["open-moss", "open-code", "stop-everything", "working.title", "working.detail"]) expect(CORE_STRINGS_EN[`moss.core.host-tray.${k}`]).toBeDefined();
  });
});

describe("a tab's pictures to the engine", () => {
  const jpeg = (w: number, h: number) => new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 0xff, w >> 8, w & 0xff, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

  test("a JPEG's size from its header", () => {
    expect(jpegSize(jpeg(1280, 800))).toEqual({ width: 1280, height: 800 });
    expect(jpegSize(new Uint8Array([1, 2, 3, 4]))).toBeUndefined();
  });

  test("one in flight per stream, only the newest waits; video streams and unknown streams send nothing", async () => {
    const sent: HostTabFrameParams[] = [];
    const answers: (() => void)[] = [];
    const sender = new TabFrameSender((p) => { sent.push(p); return new Promise<void>((r) => answers.push(r)); }, () => 7);
    sender.chunk("v", { kind: "config", codec: "h264", width: 1, height: 1, codecString: "avc1" });
    sender.chunk("v", { kind: "frame", key: true, timestamp: 0, data: jpeg(10, 10) });
    sender.chunk("nope", { kind: "frame", key: true, timestamp: 0, data: jpeg(10, 10) });
    expect(sent).toEqual([]);
    sender.chunk("s", { kind: "config", codec: "jpeg", width: 1280, height: 800, codecString: "jpeg" });
    sender.chunk("s", { kind: "frame", key: true, timestamp: 0, data: jpeg(100, 50) });
    sender.chunk("s", { kind: "frame", key: true, timestamp: 1, data: jpeg(101, 50) });
    sender.chunk("s", { kind: "frame", key: true, timestamp: 2, data: jpeg(102, 50) });
    expect(sent.map((f) => f.width)).toEqual([100]);
    answers.shift()!();
    await new Promise((r) => setTimeout(r, 0));
    expect(sent.map((f) => f.width)).toEqual([100, 102]);
    expect(sent[1]).toMatchObject({ stream: "s", seq: 3, format: "jpeg", height: 50, at: 7 });
    sender.chunk("s", { kind: "ended", reason: "stopped" });
    sender.chunk("s", { kind: "frame", key: true, timestamp: 3, data: jpeg(103, 50) });
    answers.shift()!();
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toHaveLength(2);
  });
});

// macOS only: the dev helper is a macOS bundle.
test.if(process.platform === "darwin")("the dev helper is the dev profile on its own home, never the dist home; the packaged host follows the app's rule", () => {
  const dev = "/r/dist/dev/app/MOSS Code Dev.app/Contents/Frameworks/MOSS Host Dev.app/Contents/MacOS/MOSS Host Dev";
  const dist = "/Applications/MOSS Code.app/Contents/Frameworks/MOSS Host.app/Contents/MacOS/MOSS Host";
  expect(hostProfileAndHome({}, dev, "/Users/u")).toEqual({ profile: "dev", home: join("/Users/u", ".moss-dev") });
  expect(hostProfileAndHome({ MOSS_HOME: "/t/h" }, dev, "/Users/u")).toEqual({ profile: "dev", home: "/t/h" });
  expect(() => hostProfileAndHome({ MOSS_HOME: "/Users/u/.moss" }, dev, "/Users/u")).toThrow(/dist home/);
  expect(hostProfileAndHome({}, dist, "/Users/u")).toEqual({ profile: "dist", home: join("/Users/u", ".moss") });
});
