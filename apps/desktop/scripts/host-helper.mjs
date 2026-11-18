// The background host's helper app, made inside each packaged app (spec revision 19, §3.1 "The host is a nested helper
// app with one fixed identifier"; ruling R7; lane HS). electron-builder's `afterPack` hook (electron-builder.yml): it runs
// after the app is laid out and before electron-builder flips the fuses and signs, so the helper is sealed with the app.
//
// macOS: `<App>.app/Contents/Frameworks/MOSS Host.app` (dev: `MOSS Host Dev.app`), a complete Electron app of its own,
// with the same app code (`app.asar`, its unpacked natives), under its own fixed identifier (`com.waifucave.moss.host`):
//   Contents/MacOS/MOSS Host                    Electron's launcher, unchanged
//   Contents/Frameworks/Electron Framework…     its own copy of the frameworks (Squirrel, Mantle, ReactiveObjC too)
//   Contents/Frameworks/MOSS Host Helper*.app   Electron's helpers, renamed after it (Electron finds them by its name)
//   Contents/Resources/app.asar                 the app's own, its integrity hash in the helper's Info.plist too
//   Contents/Info.plist                         LSUIElement (no Dock icon), its identifier, the app's asar integrity
// A probe on 2026-11-17 (Electron 45.2.3) settled the layout: a framework shared through a symlink out of the helper is
// refused by Chromium's sandbox (every child exits), and the launcher has no room for another rpath. So the helper
// carries its own frameworks (about 250 MB unpacked; hard links in the staging folder are an optimisation for later).
// Its fuses are flipped here, with the app's own settings, since electron-builder flips only the app's.
//
// Windows and Linux: no helper bundle. The host is the app's own executable started with `--moss-program=host` (the
// engine's task `\MOSS\moss-host` and user unit `moss-host.service`, which those packages install), since neither OS
// signs a running image (spec §3.1: the hello's `surface` and the caller check stand in there).
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** The helper's name and identifier per profile (the engine's own: packages/core/src/host/world.ts, protocol's
 *  PROGRAM_IDENTIFIERS). */
export function hostHelperIdentity(appId) {
  const dev = appId.endsWith(".dev");
  return dev ? { name: "MOSS Host Dev", identifier: "com.waifucave.moss.host.dev" } : { name: "MOSS Host", identifier: "com.waifucave.moss.host" };
}

/** The helper apps Electron's frameworks folder holds, and what each is called in the host: `<App> Helper (GPU).app`
 *  becomes `<Host> Helper (GPU).app`. */
export function helperRenames(frameworkNames, appName, hostName) {
  const prefix = `${appName} Helper`;
  return frameworkNames.filter((n) => n.startsWith(prefix) && n.endsWith(".app")).map((n) => ({ from: n, to: `${hostName} Helper${n.slice(prefix.length, -".app".length)}.app` }));
}

/** Plist edits as plain text (the app's Info.plist is XML here, before signing): set a string key, adding it if absent. */
export function setPlistString(xml, key, value) {
  const esc = value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const re = new RegExp(`(<key>${key}</key>\\s*<string>)[^<]*(</string>)`);
  if (re.test(xml)) return xml.replace(re, `$1${esc}$2`);
  return xml.replace(/<dict>/, `<dict>\n\t<key>${key}</key>\n\t<string>${esc}</string>`);
}

export function setPlistTrue(xml, key) {
  const re = new RegExp(`<key>${key}</key>\\s*<(true|false)/>`);
  if (re.test(xml)) return xml.replace(re, `<key>${key}</key>\n\t<true/>`);
  return xml.replace(/<dict>/, `<dict>\n\t<key>${key}</key>\n\t<true/>`);
}

/** A plist as XML in place (Electron ships some as binary; macOS's own plutil converts them). */
function toXml(path) {
  if (!readFileSync(path).subarray(0, 6).toString("latin1").startsWith("bplist")) return;
  execFileSync("plutil", ["-convert", "xml1", path]);
}

/** Lays the helper out inside `appPath` (a packed, unsigned macOS app). Returns the helper's path. */
/** `devMain`: the dev app's helper (scripts/dev-app.ts), whose Electron runs the checkout's built main rather than an asar:
 *  its `Resources/app` is a two-file stub (`package.json` with the desktop package's name and version, `boot.js`) that
 *  imports `devMain`. */
export function makeHostHelper({ appPath, appName, appId, devMain, devPackage }) {
  const { name, identifier } = hostHelperIdentity(appId);
  const contents = join(appPath, "Contents");
  const frameworks = join(contents, "Frameworks");
  const host = join(frameworks, `${name}.app`);
  rmSync(host, { recursive: true, force: true });
  const hc = join(host, "Contents");
  // The launcher, under the host's name.
  cpSync(join(contents, "MacOS", appName), join(hc, "MacOS", name));
  // The frameworks (each a real copy) and the helpers, renamed.
  const names = readdirSync(frameworks).filter((n) => n !== `${name}.app`);
  const renames = helperRenames(names, appName, name);
  for (const n of names) {
    if (renames.some((r) => r.from === n)) continue;
    if (n.endsWith(".framework")) cpSync(join(frameworks, n), join(hc, "Frameworks", n), { recursive: true, verbatimSymlinks: true });
  }
  for (const r of renames) {
    const dst = join(hc, "Frameworks", r.to);
    cpSync(join(frameworks, r.from), dst, { recursive: true, verbatimSymlinks: true });
    const helperName = r.to.slice(0, -".app".length);
    const fromName = r.from.slice(0, -".app".length);
    renameSync(join(dst, "Contents", "MacOS", fromName), join(dst, "Contents", "MacOS", helperName));
    const plist = join(dst, "Contents", "Info.plist");
    toXml(plist);
    let xml = readFileSync(plist, "utf8");
    xml = setPlistString(xml, "CFBundleExecutable", helperName);
    xml = setPlistString(xml, "CFBundleName", helperName);
    xml = setPlistString(xml, "CFBundleDisplayName", helperName);
    const kind = fromName.slice(`${appName} Helper`.length).replace(/[^A-Za-z]/g, "").toLowerCase();
    xml = setPlistString(xml, "CFBundleIdentifier", `${identifier}.helper${kind ? `.${kind}` : ""}`);
    writeFileSync(plist, xml);
  }
  // The same app code, and the app's icons.
  const res = join(contents, "Resources");
  for (const n of readdirSync(res)) {
    if (n === "app.asar" || n === "app.asar.unpacked" || n.endsWith(".icns")) cpSync(join(res, n), join(hc, "Resources", n), { recursive: true, verbatimSymlinks: true });
  }
  // Its Info.plist: the app's (its asar integrity, its versions), under the host's identity, with no Dock icon.
  toXml(join(contents, "Info.plist"));
  let xml = readFileSync(join(contents, "Info.plist"), "utf8");
  xml = setPlistString(xml, "CFBundleExecutable", name);
  xml = setPlistString(xml, "CFBundleName", name);
  xml = setPlistString(xml, "CFBundleDisplayName", name);
  xml = setPlistString(xml, "CFBundleIdentifier", identifier);
  xml = setPlistTrue(xml, "LSUIElement");
  // The app's URL schemes and document types belong to the app, not to its host.
  xml = xml.replace(/\s*<key>CFBundleURLTypes<\/key>\s*<array>[\s\S]*?<\/array>/, "");
  xml = xml.replace(/\s*<key>CFBundleDocumentTypes<\/key>\s*<array>[\s\S]*?<\/array>/, "");
  writeFileSync(join(hc, "Info.plist"), xml);
  if (existsSync(join(contents, "PkgInfo"))) cpSync(join(contents, "PkgInfo"), join(hc, "PkgInfo"));
  if (devMain !== undefined) {
    const stub = join(hc, "Resources", "app");
    mkdirSync(stub, { recursive: true });
    writeFileSync(join(stub, "package.json"), `${JSON.stringify({ name: devPackage.name, version: devPackage.version, type: "module", main: "boot.js" }, null, 2)}\n`);
    writeFileSync(join(stub, "boot.js"), `// The dev host runs the checkout's built main (scripts/dev-app.ts).\nimport ${JSON.stringify(pathToFileURL(devMain).href)};\n`);
  }
  return host;
}

// `bun apps/desktop/scripts/host-helper.mjs make-dev <dev app> <desktop folder>`: the dev app's helper (scripts/dev-app.ts).
if (process.argv[2] === "make-dev" && process.argv.length === 5) {
  const [appPath, desktop] = [process.argv[3], process.argv[4]];
  const pkg = JSON.parse(readFileSync(join(desktop, "package.json"), "utf8"));
  const host = makeHostHelper({ appPath, appName: "Electron", appId: "com.waifucave.moss.code.dev", devMain: join(desktop, "out", "main", "index.js"), devPackage: { name: pkg.name, version: pkg.version } });
  console.log(`  • dev host helper  ${host}`);
}

/** Where the release build (scripts/release/build.ts) asks for a copy of the finished helper, for MOSS to carry the very same
 *  one (lane PK; R7: one fixed identity, the same in both apps). MOSS's own afterPack (apps/moss/scripts/host-helper.mjs) takes
 *  it from there. Unset: no copy (a plain `bun run dist`). */
export const HOST_HELPER_STASH_ENV = "MOSS_HOST_HELPER_STASH";

/** Copies the finished helper (laid out, fuses flipped, not yet signed: each app's own build signs it with the app) into the
 *  stash folder, replacing what was there. */
export function stashHostHelper(host, stash) {
  const name = host.split("/").pop();
  mkdirSync(stash, { recursive: true });
  rmSync(join(stash, name), { recursive: true, force: true });
  cpSync(host, join(stash, name), { recursive: true, verbatimSymlinks: true });
  return join(stash, name);
}

/** electron-builder's `afterPack`. */
export default async function afterPack(context) {
  if (context.electronPlatformName !== "darwin" && context.electronPlatformName !== "mas") return;
  const packager = context.packager;
  const appName = packager.appInfo.productFilename;
  const appPath = join(context.appOutDir, `${appName}.app`);
  const host = makeHostHelper({ appPath, appName, appId: packager.appInfo.id });
  // The app's fuses, flipped on the helper's own framework (electron-builder flips only the app's, after this hook).
  if (packager.config.electronFuses != null) {
    const fuses = await packager.generateFuseConfig(packager.config.electronFuses);
    const req = createRequire(createRequire(import.meta.url).resolve("electron-builder/package.json"));
    const lib = createRequire(req.resolve("app-builder-lib/package.json"));
    const { flipFuses } = await import(lib.resolve("@electron/fuses"));
    await flipFuses(host, fuses);
  }
  console.log(`  • host helper  ${host}`);
  const stash = process.env[HOST_HELPER_STASH_ENV];
  if (stash) console.log(`  • host helper stashed for MOSS  ${stashHostHelper(host, stash)}`);
}
