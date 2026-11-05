import { describe, expect, test } from "bun:test";
import { percentile, rate, rounded, summarize } from "../src/shared/stats.ts";
import { descendants, parsePsTime } from "../src/shared/procmem.ts";
import { splitNul } from "../src/cft/cdp.ts";
import { archiveUrl, binaryIn, cftPlatform, googMd5Hex, pinFor } from "../src/cft/install.ts";
import { splitLines } from "../src/pair/ndjson.ts";
import { pairNames, restartPlan } from "../src/pair/names.ts";
import { frame, unframe } from "../src/shared/framing.ts";

describe("stats", () => {
  test("percentiles and summaries", () => {
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
    expect(Number.isNaN(percentile([], 50))).toBe(true);
    const s = summarize([1, 2, 3, Number.NaN]);
    expect(s).toMatchObject({ n: 3, min: 1, max: 3, p50: 2, mean: 2 });
    expect(rate(0, 0, 100, 2000)).toBe(50);
    expect(rounded({ a: 1.23456, b: [2.5555] }, 1)).toEqual({ a: 1.2, b: [2.6] });
  });
});

describe("process trees", () => {
  test("descendants walks children only", () => {
    const parent = new Map([[10, 1], [11, 10], [12, 11], [13, 10], [20, 1]]);
    expect(descendants(10, parent).sort()).toEqual([10, 11, 12, 13]);
    expect(descendants(99, parent)).toEqual([99]);
  });
  test("ps TIME", () => {
    expect(parsePsTime("0:01.50")).toBeCloseTo(1.5);
    expect(parsePsTime("1:02:03")).toBe(3723);
    expect(parsePsTime("2-00:00:01")).toBe(172801);
  });
});

describe("framing", () => {
  test("NUL-framed CDP messages", () => {
    expect(splitNul('{"a":1}\0{"b"')).toEqual({ messages: ['{"a":1}'], rest: '{"b"' });
    expect(splitNul("x\0y\0")).toEqual({ messages: ["x", "y"], rest: "" });
  });
  test("NDJSON lines", () => {
    expect(splitLines('{"a":1}\n\n{"b":2}\n{"c"')).toEqual({ lines: ['{"a":1}', '{"b":2}'], rest: '{"c"' });
  });
  test("the link's frames", () => {
    const f = frame({ kind: "jpeg", seq: 3 }, new Uint8Array([1, 2, 3]));
    const u = unframe(f.buffer.slice(f.byteOffset, f.byteOffset + f.byteLength) as ArrayBuffer);
    expect(u.header).toEqual({ kind: "jpeg", seq: 3 });
    expect([...u.payload]).toEqual([1, 2, 3]);
  });
});

describe("Chrome for Testing pins", () => {
  test("platforms and binaries", () => {
    expect(cftPlatform("darwin", "arm64")).toBe("mac-arm64");
    expect(cftPlatform("linux", "x64")).toBe("linux64");
    expect(cftPlatform("linux", "arm64")).toBe("linux-arm64");
    expect(cftPlatform("win32", "x64")).toBe("win64");
    expect(binaryIn("chrome-headless-shell", "win64")).toMatch(/chrome-headless-shell-win64[\\/]chrome-headless-shell\.exe$/);
    expect(binaryIn("chrome", "mac-arm64")).toContain("Google Chrome for Testing.app");
    expect(archiveUrl("chrome-headless-shell", "linux64", "156.0.8078.80")).toBe("https://storage.googleapis.com/chrome-for-testing-public/156.0.8078.80/linux64/chrome-headless-shell-linux64.zip");
  });
  test("every platform the daemon ships on has a pin: size and SHA-256", () => {
    for (const plat of ["mac-arm64", "linux64", "linux-arm64", "win64"]) {
      for (const artifact of ["chrome-headless-shell", "chrome"] as const) {
        const pin = pinFor(artifact, plat);
        expect(pin?.bytes).toBeGreaterThan(50_000_000);
        expect(pin?.sha256).toMatch(/^[0-9a-f]{64}$/);
      }
    }
  });
  test("GCS md5 header", () => {
    expect(googMd5Hex("crc32c=xNw1zg==, md5=35VRj0kejR/euFBBs5nLNw==")).toBe(Buffer.from("35VRj0kejR/euFBBs5nLNw==", "base64").toString("hex"));
    expect(googMd5Hex(null)).toBeUndefined();
  });
});

describe("the pair", () => {
  test("names come from the home, and differ per home", () => {
    const a = pairNames("/tmp/a", "linux"), b = pairNames("/tmp/b", "linux");
    expect(a.suffix).not.toBe(b.suffix);
    expect(a.label).toStartWith("com.waifucave.clover.s7.core.");
    expect(a.socket).toBe("/tmp/a/run/core.sock");
    expect(pairNames("C:\\h", "win32").socket).toStartWith("\\\\.\\pipe\\clover-s7-core-");
  });
  test("crash restarts: growing delays, safe mode on the third crash in two minutes", () => {
    const now = 1_000_000;
    expect(restartPlan([now], now)).toEqual({ delayMs: 1000, safeMode: false });
    expect(restartPlan([now - 1000, now], now)).toEqual({ delayMs: 2000, safeMode: false });
    expect(restartPlan([now - 2000, now - 1000, now], now)).toEqual({ delayMs: 4000, safeMode: true });
    expect(restartPlan([now - 200_000, now - 130_000, now], now)).toEqual({ delayMs: 1000, safeMode: false });
  });
});
