// Makes the Electron the UI test may run locally on macOS (plan §8: nothing local may open a window, show a Dock icon
// or take the focus): a copy of the pinned Electron.app whose Info.plist sets `LSUIElement` and `LSBackgroundOnly`, so
// Launch Services never brings it to the front, re-signed ad hoc after the edit. The test refuses any other.
//
//   bun run scripts/background-electron.ts <dir>
//   CLOVER_UI_LOCAL_ELECTRON=<dir>/Electron.app/Contents/MacOS/Electron bun test test/ui-smoke.test.ts
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

if (process.platform !== "darwin") {
  console.error("only macOS needs a background-only Electron; elsewhere the UI test runs in CI");
  process.exit(1);
}
const target = process.argv[2];
if (target === undefined || target === "") {
  console.error("usage: bun run scripts/background-electron.ts <dir>");
  process.exit(1);
}
const root = join(import.meta.dir, "..");
const binary = createRequire(join(root, "package.json"))("electron") as string;
const source = dirname(dirname(dirname(binary)));
if (!source.endsWith("Electron.app") || !existsSync(source)) {
  console.error(`no Electron.app at ${source}`);
  process.exit(1);
}
const dir = resolve(target);
const app = join(dir, "Electron.app");
mkdirSync(dir, { recursive: true });
rmSync(app, { recursive: true, force: true });
cpSync(source, app, { recursive: true, verbatimSymlinks: true });

const run = (cmd: string, args: string[]) => {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  if (r.status !== 0) {
    console.error(`${cmd} ${args.join(" ")} failed: ${r.stderr}`);
    process.exit(1);
  }
};
const plist = join(app, "Contents", "Info.plist");
for (const key of ["LSUIElement", "LSBackgroundOnly"]) {
  const set = spawnSync("plutil", ["-replace", key, "-bool", "YES", plist], { encoding: "utf8" });
  if (set.status !== 0) run("plutil", ["-insert", key, "-bool", "YES", plist]);
}
run("codesign", ["--force", "--deep", "--sign", "-", app]);
console.log(join(app, "Contents", "MacOS", "Electron"));
