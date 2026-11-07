// The headless shell's pin follows the app's Electron (scripts/check-headless-pin.ts), against fixtures: no network.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { electronChromium, HEADLESS_MARKER, main, pinProblems, PIN_FILE, wantedChromium, type HeadlessPin, type KnownGood } from "./check-headless-pin";

const sha = "a".repeat(64);
const url = (v: string, p: string) => `https://storage.googleapis.com/chrome-for-testing-public/${v}/${p}/chrome-headless-shell-${p}.zip`;
const asset = (v: string, platform: string) => ({ platform, url: url(v, platform), sha256: sha });
const pin = (v: string, electron = "45.2.3"): HeadlessPin => ({ electron, chromium: v, milestone: Number(v.split(".")[0]), assets: ["linux64", "linux-arm64", "mac-arm64"].map((p) => asset(v, p)) });
/** Chrome for Testing's list, with the headless shell for every platform of each version. */
const known = (...versions: string[]): KnownGood => ({
  versions: versions.map((version) => ({ version, downloads: { "chrome-headless-shell": ["linux64", "linux-arm64", "mac-arm64", "win64"].map((platform) => ({ platform, url: url(version, platform) })) } })),
});

describe("the headless shell's pin", () => {
  test("Electron's exact build passes when Chrome for Testing publishes it, and then nothing else does", () => {
    const k = known("156.0.8078.70", "156.0.8078.80", "156.0.8078.92");
    expect(pinProblems(pin("156.0.8078.80"), "45.2.3", "156.0.8078.80", k)).toEqual([]);
    expect(pinProblems(pin("156.0.8078.92"), "45.2.3", "156.0.8078.80", k)[0]).toContain("must be 156.0.8078.80, Electron's own build");
  });

  test("when it isn't published, only the nearest published build of the milestone passes", () => {
    const k = known("156.0.8078.70", "156.0.8078.83", "156.0.8079.1", "157.0.1.1");
    expect(wantedChromium("156.0.8078.80", k)).toBe("156.0.8078.83");
    expect(pinProblems(pin("156.0.8078.83"), "45.2.3", "156.0.8078.80", k)).toEqual([]);
    expect(pinProblems(pin("156.0.8078.70"), "45.2.3", "156.0.8078.80", k)[0]).toContain("the nearest published build to Electron's 156.0.8078.80");
    expect(wantedChromium("158.0.1.1", k)).toBeUndefined();
  });

  test("an Electron upgrade without the pin, another milestone, an unlisted URL or a malformed pin fails", () => {
    const k = known("156.0.8078.80");
    expect(pinProblems(pin("156.0.8078.80", "45.2.2"), "45.2.3", "156.0.8078.80", k)[0]).toContain("move the pin with the upgrade");
    expect(pinProblems(pin("155.0.7000.10"), "45.2.3", "156.0.8078.80", k).some((p) => p.includes("milestone 155"))).toBe(true);
    expect(pinProblems({ ...pin("156.0.8078.80"), milestone: 155 }, "45.2.3", "156.0.8078.80", k)[0]).toContain("is not its chromium's");
    expect(pinProblems({ ...pin("156.0.8078.80"), assets: [asset("156.0.8078.80", "mac-arm64"), asset("156.0.8078.80", "linux-arm64")] }, "45.2.3", "156.0.8078.80", k))
      .toEqual(["it pins no linux64 build (the server image's)"]);
    const wrong = { ...pin("156.0.8078.80"), assets: [asset("156.0.8078.80", "linux-arm64"), { ...asset("156.0.8078.80", "linux64"), url: "https://example.invalid/x.zip" }] };
    expect(pinProblems(wrong, "45.2.3", "156.0.8078.80", k)[0]).toContain("url is https://example.invalid/x.zip");
    const unlisted = { ...pin("156.0.8078.80"), assets: [...pin("156.0.8078.80").assets, asset("156.0.8078.80", "win32")] };
    expect(pinProblems(unlisted, "45.2.3", "156.0.8078.80", k)).toEqual([`Chrome for Testing doesn't list ${url("156.0.8078.80", "win32")}`]);
    const badSha = { ...pin("156.0.8078.80"), assets: [asset("156.0.8078.80", "linux-arm64"), { ...asset("156.0.8078.80", "linux64"), sha256: "nope" }] };
    expect(pinProblems(badSha, "45.2.3", "156.0.8078.80", k)).toEqual(["linux64's sha256 is not a SHA-256"]);
    expect(pinProblems({ ...pin("156.0.8078.80"), assets: "x" as never }, "45.2.3", "156.0.8078.80", k)).toEqual(["its assets are not a list"]);
  });

  test("Electron's Chromium comes from its release metadata", () => {
    expect(electronChromium([{ version: "45.2.3", chrome: "156.0.8078.80" }, { version: "45.2.2", chrome: "156.0.8078.70" }], "45.2.3")).toBe("156.0.8078.80");
    expect(electronChromium([], "45.2.3")).toBeUndefined();
  });

  test("warns while the headless browser isn't there, requires the pin once it is, and fails on a mismatch", async () => {
    const root = mkdtempSync(join(tmpdir(), "clover-headless-pin-"));
    mkdirSync(join(root, "apps", "desktop"), { recursive: true });
    writeFileSync(join(root, "apps", "desktop", "package.json"), JSON.stringify({ devDependencies: { electron: "45.2.3" } }));
    expect(await main([], root)).toBe(0);
    const folder = join(root, ...PIN_FILE.split("/").slice(0, -1));
    mkdirSync(folder, { recursive: true });
    expect(await main([], root)).toBe(0);
    mkdirSync(join(root, ...HEADLESS_MARKER.split("/").slice(0, -1)), { recursive: true });
    writeFileSync(join(root, ...HEADLESS_MARKER.split("/")), "{}");
    expect(await main([], root)).toBe(1);
    const metadata = join(root, "releases.json");
    const knownGood = join(root, "known.json");
    writeFileSync(metadata, JSON.stringify([{ version: "45.2.3", chrome: "156.0.8078.80" }]));
    writeFileSync(knownGood, JSON.stringify(known("156.0.8078.80")));
    writeFileSync(join(root, ...PIN_FILE.split("/")), JSON.stringify(pin("156.0.8078.80")));
    expect(await main(["--metadata", metadata, "--known-good", knownGood], root)).toBe(0);
    writeFileSync(join(root, ...PIN_FILE.split("/")), JSON.stringify(pin("155.0.7000.10")));
    expect(await main(["--metadata", metadata, "--known-good", knownGood], root)).toBe(1);
    rmSync(root, { recursive: true, force: true });
  });
});
