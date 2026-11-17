// The host's helper app inside the packaged app (lane HS, scripts/host-helper.mjs): its fixed identifier, its own
// frameworks and renamed helpers, the app's code and asar integrity, no Dock icon; and electron-builder runs it.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error: a plain .mjs hook (electron-builder loads it with Node), with no types of its own
import { helperRenames, hostHelperIdentity, makeHostHelper, setPlistString } from "../scripts/host-helper.mjs";

const root = mkdtempSync(join(tmpdir(), "moss-host-helper-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const plist = (entries: Record<string, string>) => `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n${Object.entries(entries).map(([k, v]) => `\t<key>${k}</key>\n\t<string>${v}</string>`).join("\n")}\n\t<key>ElectronAsarIntegrity</key>\n\t<dict><key>Resources/app.asar</key><dict><key>hash</key><string>abc</string></dict></dict>\n</dict>\n</plist>\n`;

function fakeApp(name: string): string {
  const app = join(root, `${name}.app`);
  const c = join(app, "Contents");
  for (const d of ["MacOS", "Resources/app.asar.unpacked/out/main/native", "Frameworks/Electron Framework.framework/Versions/A"]) mkdirSync(join(c, d), { recursive: true });
  writeFileSync(join(c, "MacOS", name), "launcher");
  writeFileSync(join(c, "Resources", "app.asar"), "asar");
  writeFileSync(join(c, "Resources", "app.asar.unpacked/out/main/native/x.node"), "native");
  writeFileSync(join(c, "Resources", "icon.icns"), "icon");
  writeFileSync(join(c, "Resources", "other.txt"), "not copied");
  writeFileSync(join(c, "Frameworks/Electron Framework.framework/Versions/A/Electron Framework"), "framework");
  for (const k of ["", " (Renderer)", " (GPU)", " (Plugin)"]) {
    const h = join(c, "Frameworks", `${name} Helper${k}.app`, "Contents");
    mkdirSync(join(h, "MacOS"), { recursive: true });
    writeFileSync(join(h, "MacOS", `${name} Helper${k}`), "helper");
    writeFileSync(join(h, "Info.plist"), plist({ CFBundleExecutable: `${name} Helper${k}`, CFBundleIdentifier: "com.waifucave.moss.code.helper", CFBundleName: `${name} Helper${k}` }));
  }
  writeFileSync(join(c, "Info.plist"), plist({ CFBundleExecutable: name, CFBundleIdentifier: "com.waifucave.moss.code", CFBundleName: name }).replace("<dict>\n", "<dict>\n\t<key>CFBundleURLTypes</key>\n\t<array><dict><key>CFBundleURLSchemes</key><array><string>moss</string></array></dict></array>\n"));
  return app;
}

test("the helper's identity per profile is the host's fixed one", () => {
  expect(hostHelperIdentity("com.waifucave.moss.code")).toEqual({ name: "MOSS Host", identifier: "com.waifucave.moss.host" });
  expect(hostHelperIdentity("com.waifucave.moss.code.dev")).toEqual({ name: "MOSS Host Dev", identifier: "com.waifucave.moss.host.dev" });
  expect(helperRenames(["MOSS Code Helper (GPU).app", "Electron Framework.framework"], "MOSS Code", "MOSS Host")).toEqual([{ from: "MOSS Code Helper (GPU).app", to: "MOSS Host Helper (GPU).app" }]);
  expect(setPlistString("<dict>\n</dict>", "A", "x&y")).toContain("<key>A</key>\n\t<string>x&amp;y</string>");
});

test("laid out inside the app: its own frameworks and renamed helpers, the app's code and asar integrity, no Dock icon, none of the app's URL schemes", () => {
  const app = fakeApp("MOSS Code");
  const host = makeHostHelper({ appPath: app, appName: "MOSS Code", appId: "com.waifucave.moss.code" }) as string;
  expect(host).toBe(join(app, "Contents/Frameworks/MOSS Host.app"));
  const hc = join(host, "Contents");
  expect(readFileSync(join(hc, "MacOS/MOSS Host"), "utf8")).toBe("launcher");
  expect(existsSync(join(hc, "Frameworks/Electron Framework.framework/Versions/A/Electron Framework"))).toBe(true);
  for (const k of ["", " (Renderer)", " (GPU)", " (Plugin)"]) {
    const h = join(hc, "Frameworks", `MOSS Host Helper${k}.app/Contents`);
    expect(existsSync(join(h, "MacOS", `MOSS Host Helper${k}`))).toBe(true);
    const p = readFileSync(join(h, "Info.plist"), "utf8");
    expect(p).toContain(`<string>MOSS Host Helper${k}</string>`);
    expect(p).toMatch(/<string>com\.waifucave\.moss\.host\.helper(\.[a-z]+)?<\/string>/);
  }
  expect(readFileSync(join(hc, "Resources/app.asar"), "utf8")).toBe("asar");
  expect(existsSync(join(hc, "Resources/app.asar.unpacked/out/main/native/x.node"))).toBe(true);
  expect(existsSync(join(hc, "Resources/other.txt"))).toBe(false);
  const info = readFileSync(join(hc, "Info.plist"), "utf8");
  expect(info).toContain("<string>com.waifucave.moss.host</string>");
  expect(info).toContain("<key>LSUIElement</key>\n\t<true/>");
  expect(info).toContain("<key>ElectronAsarIntegrity</key>");
  expect(info).not.toContain("CFBundleURLTypes");
  // Made again from scratch each time, never nested in itself.
  makeHostHelper({ appPath: app, appName: "MOSS Code", appId: "com.waifucave.moss.code" });
  expect(existsSync(join(hc, "Frameworks/MOSS Host.app"))).toBe(false);
});

test("electron-builder runs it after packing, before the fuses and the signature", async () => {
  const yml = readFileSync(join(import.meta.dir, "..", "electron-builder.yml"), "utf8");
  expect(yml).toMatch(/^afterPack: scripts\/host-helper\.mjs$/m);
});

// macOS only: the dev helper is a macOS bundle.
test.if(process.platform === "darwin")("the dev app's helper runs the checkout's built main from a two-file stub", () => {
  const app = fakeApp("Electron");
  const host = makeHostHelper({ appPath: app, appName: "Electron", appId: "com.waifucave.moss.code.dev", devMain: "/r/apps/desktop/out/main/index.js", devPackage: { name: "@waifucave/moss-desktop", version: "0.124.0" } }) as string;
  expect(host.endsWith("MOSS Host Dev.app")).toBe(true);
  const pkg = JSON.parse(readFileSync(join(host, "Contents", "Resources", "app", "package.json"), "utf8"));
  expect(pkg).toEqual({ name: "@waifucave/moss-desktop", version: "0.124.0", type: "module", main: "boot.js" });
  expect(readFileSync(join(host, "Contents", "Resources", "app", "boot.js"), "utf8")).toContain('import "file:///r/apps/desktop/out/main/index.js";');
});
