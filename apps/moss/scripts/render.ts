// The renders for the owner's approval: MOSS's window drawn offscreen against the fake engine, scene by scene (a
// conversation with an attachment and a card, the side panel with a live picture and routines, the strip with another
// bot's card, the Plugins page, Settings), light and dark, at a usual and a narrow size, as PNGs.
//
//   bun run scripts/render.ts <out dir>
//
// Headless and silent: a test build of MOSS in a background-only Electron (MOSS_UI_LOCAL_ELECTRON on macOS, made by
// scripts/background-electron.ts), its window offscreen and never shown, a temp home and user data.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { startFakeEngine } from "../test/fake-engine/engine";
import { pagePng } from "../test/picture";

const out = process.argv[2];
if (out === undefined || out === "") {
  console.error("usage: bun run scripts/render.ts <out dir>");
  process.exit(2);
}
const root = join(import.meta.dir, "..");
const local = process.env.MOSS_UI_LOCAL_ELECTRON;
const electron = local !== undefined && local !== "" ? local : (createRequire(join(root, "package.json"))("electron") as string);
if (process.platform === "darwin") {
  const plist = join(dirname(dirname(electron)), "Info.plist");
  const v = spawnSync("plutil", ["-extract", "LSBackgroundOnly", "raw", plist], { encoding: "utf8" });
  if (v.status !== 0 || v.stdout.trim() !== "true") {
    console.error("render: MOSS_UI_LOCAL_ELECTRON must name a background-only Electron (scripts/background-electron.ts)");
    process.exit(2);
  }
}
const built = spawnSync(process.execPath, ["run", "scripts/build.ts", "--test-build"], { cwd: root, encoding: "utf8" });
if (built.status !== 0) {
  console.error(built.stderr);
  process.exit(1);
}
const home = mkdtempSync(join(tmpdir(), "mr-"));
let pid: number | undefined;
const engine = await startFakeEngine({ home, picturePng: await pagePng(), frameMs: 400, peerPid: () => pid });
const env: NodeJS.ProcessEnv = { ...process.env, MOSS_HOME: home, MOSS_USER_DATA: join(home, "user-data"), MOSS_TEST_FRONT: "1" };
delete env.MOSS_PROFILE;
delete env.ELECTRON_RUN_AS_NODE;
const dir = resolve(out);
const child = spawn(electron, [root, `--moss-render=${dir}`], { env, stdio: ["ignore", "inherit", "inherit"] });
pid = child.pid;
const code = await new Promise<number | null>((r) => {
  const t = setTimeout(() => { child.kill("SIGKILL"); r(null); }, 240_000);
  child.on("exit", (c) => { clearTimeout(t); r(c); });
});
await engine.close();
rmSync(home, { recursive: true, force: true });
const run = JSON.parse(readFileSync(join(dir, "render-run.json"), "utf8")) as { ok: boolean; written: string[] };
console.log(`render: ${run.ok ? "ok" : "failed"}, ${run.written.length} pictures in ${dir} (exit ${code})`);
process.exit(run.ok && code === 0 ? 0 : 1);
