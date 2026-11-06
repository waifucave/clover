// The headless shell's pin follows the app's Electron (scripts/check-headless-pin.ts), against fixtures: no network.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { electronChromium, main, pinProblems, PIN_FILE, type HeadlessPin } from "./check-headless-pin";

const sha = "a".repeat(64);
const asset = (chromium: string, platform: string) => ({ platform, url: `https://storage.googleapis.com/chrome-for-testing-public/${chromium}/${platform}/chrome-headless-shell-${platform}.zip`, sha256: sha });
const pin = (chromium: string, electron = "45.2.3"): HeadlessPin => ({ electron, chromium, milestone: Number(chromium.split(".")[0]), assets: [asset(chromium, "linux64"), asset(chromium, "linux-arm64"), asset(chromium, "mac-arm64")] });

describe("the headless shell's pin", () => {
  test("Electron's exact Chromium, or the nearest build of the same milestone, passes", () => {
    expect(pinProblems(pin("156.0.8078.80"), "45.2.3", "156.0.8078.80")).toEqual([]);
    expect(pinProblems(pin("156.0.8078.92"), "45.2.3", "156.0.8078.80")).toEqual([]);
  });

  test("an Electron upgrade without the pin, another milestone, or a malformed pin fails", () => {
    expect(pinProblems(pin("156.0.8078.80", "45.2.2"), "45.2.3", "156.0.8078.80")[0]).toContain("move the pin with the upgrade");
    expect(pinProblems(pin("155.0.7000.10"), "45.2.3", "156.0.8078.80")[0]).toContain("milestone 155");
    const bad = { ...pin("156.0.8078.80"), milestone: 155 };
    expect(pinProblems(bad, "45.2.3", "156.0.8078.80")[0]).toContain("is not its chromium's");
    const noLinux = { ...pin("156.0.8078.80"), assets: [asset("156.0.8078.80", "mac-arm64"), asset("156.0.8078.80", "linux-arm64")] };
    expect(pinProblems(noLinux, "45.2.3", "156.0.8078.80")).toEqual(["it pins no linux64 build (the server image's)"]);
    const linux = [asset("156.0.8078.80", "linux-arm64")];
    const wrongUrl = { ...pin("156.0.8078.80"), assets: [...linux, { ...asset("156.0.8078.80", "linux64"), url: "https://example.invalid/x.zip" }] };
    expect(pinProblems(wrongUrl, "45.2.3", "156.0.8078.80")[0]).toContain("url is https://example.invalid/x.zip");
    const badSha = { ...pin("156.0.8078.80"), assets: [...linux, { ...asset("156.0.8078.80", "linux64"), sha256: "nope" }] };
    expect(pinProblems(badSha, "45.2.3", "156.0.8078.80")).toEqual(["linux64's sha256 is not a SHA-256"]);
  });

  test("Electron's Chromium comes from its release metadata", () => {
    expect(electronChromium([{ version: "45.2.3", chrome: "156.0.8078.80" }, { version: "45.2.2", chrome: "156.0.8078.70" }], "45.2.3")).toBe("156.0.8078.80");
    expect(electronChromium([], "45.2.3")).toBeUndefined();
  });

  test("warns and passes while there is no pin file; fails on a mismatch once there is one", async () => {
    const root = mkdtempSync(join(tmpdir(), "clover-headless-pin-"));
    mkdirSync(join(root, "apps", "desktop"), { recursive: true });
    writeFileSync(join(root, "apps", "desktop", "package.json"), JSON.stringify({ devDependencies: { electron: "45.2.3" } }));
    expect(await main([], root)).toBe(0);
    const metadata = join(root, "releases.json");
    writeFileSync(metadata, JSON.stringify([{ version: "45.2.3", chrome: "156.0.8078.80" }]));
    mkdirSync(join(root, ...PIN_FILE.split("/").slice(0, -1)), { recursive: true });
    writeFileSync(join(root, ...PIN_FILE.split("/")), JSON.stringify(pin("156.0.8078.80")));
    expect(await main(["--metadata", metadata], root)).toBe(0);
    writeFileSync(join(root, ...PIN_FILE.split("/")), JSON.stringify(pin("155.0.7000.10")));
    expect(await main(["--metadata", metadata], root)).toBe(1);
  });
});
