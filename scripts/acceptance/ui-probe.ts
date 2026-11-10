#!/usr/bin/env bun
// Scratch probe: the source daemon and the desktop app on a temp home, the app headless and OFFSCREEN
// (`--clover-capture` makes its windows offscreen: every layer really loads, nothing is drawn on a screen), driven over
// the Chrome DevTools protocol (the dev app takes `--remote-debugging-port` only behind CLOVER_DEV_DEBUG=1). Prints every
// console message and uncaught error of every frame, and runs the UI actions given as `--do`.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync, closeSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { TEST_KEYCHAIN_PASSWORD } from "../../packages/core/src/auth/login-keychain";
import { USAGE_INERT_ENV } from "../../packages/core/src/usage/wiring";
import { startFakeAnthropic } from "./fake-anthropic";
import { Cdp } from "./cdp";
import { CloverClient, hello } from "./client";
import { CLOVER_PROTOCOL_VERSION } from "../../packages/protocol/src/index";

const REPO = resolve(import.meta.dir, "..", "..");
const DESKTOP = join(REPO, "apps", "desktop");
const root = mkdtempSync(join(tmpdir(), "clv-ui-"));
const home = join(root, "home");
const userHome = join(root, "user");
const logs = process.env.PROBE_LOGS ?? join(root, "logs");
const keychain = join(root, "kc", "probe.keychain-db");
const stubBin = join(root, "bin", "clover-core-stub");
for (const d of [home, userHome, logs, dirname(keychain), dirname(stubBin), join(root, "tmp")]) mkdirSync(d, { recursive: true, mode: 0o700 });
const service = `com.waifucave.clover.core.test.probe-${randomBytes(4).toString("hex")}`;
const dummyKey = `sk-ant-probe-dummy-${randomBytes(12).toString("hex")}`;
writeFileSync(stubBin, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
const env = (): Record<string, string> => ({
  PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: userHome, TMPDIR: join(root, "tmp"), LANG: "en_US.UTF-8",
  CLOVER_HOME: home, CLOVER_PROFILE: "dev", CLOVER_KEYCHAIN_SERVICE: service, CLOVER_TEST_KEYCHAIN: keychain,
});
const children: ChildProcess[] = [];
function start(name: string, cmd: string, args: string[], e: Record<string, string>): ChildProcess {
  const fd = openSync(join(logs, `${name}.log`), "a");
  const p = spawn(cmd, args, { cwd: REPO, env: e, detached: true, stdio: ["ignore", fd, fd] });
  closeSync(fd);
  children.push(p);
  return p;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function cleanup(): Promise<void> {
  for (const p of children.reverse()) { try { process.kill(-p.pid!, "SIGTERM"); } catch { /* gone */ } }
  await sleep(1500);
  for (const p of children) { try { process.kill(-p.pid!, "SIGKILL"); } catch { /* gone */ } }
  spawnSync("security", ["delete-keychain", keychain], { stdio: "ignore" });
  if (!process.env.PROBE_KEEP) rmSync(root, { recursive: true, force: true });
}
process.on("SIGINT", () => void cleanup().then(() => process.exit(130)));

async function main(): Promise<void> {
  const before = spawnSync("security", ["list-keychains", "-d", "user"], { encoding: "utf8" }).stdout;
  spawnSync("security", ["create-keychain", "-p", TEST_KEYCHAIN_PASSWORD, keychain]);
  spawnSync("security", ["set-keychain-settings", keychain]);
  const fake = startFakeAnthropic({ key: dummyKey, writePath: join(userHome, "w.txt"), writeContent: "x\n" });
  writeFileSync(join(home, "settings.json"), `${JSON.stringify({ schemaVersion: 1, providers: { anthropic: { baseUrl: fake.url } } })}\n`, { mode: 0o600 });
  const built = spawnSync(process.execPath, ["-e", `
    const { buildDevBundledPlugins } = await import(${JSON.stringify(join(REPO, "packages/core/src/registry/bundled-stage.ts"))});
    const { readdirSync, existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const sources = ${JSON.stringify(join(REPO, "plugins"))};
    const ids = readdirSync(sources).filter((id) => existsSync(join(sources, id, "clover.json"))).sort();
    await buildDevBundledPlugins({ sources, ids, cloverHome: ${JSON.stringify(home)} });
  `], { cwd: REPO, env: env(), encoding: "utf8", timeout: 600_000 });
  if (built.status !== 0) throw new Error(`bundled build failed: ${built.stderr.slice(-300)}`);
  const daemon = start("daemon", process.execPath, [join(REPO, "scripts", "acceptance", "daemon.ts")], { ...env(), ...USAGE_INERT_ENV, CLOVER_ACCEPTANCE_RUN_PID: String(process.pid), CLOVER_ACCEPTANCE_USER_HOME: userHome });
  for (let i = 0; i < 240 && !existsSync(join(home, "run", "app.token")); i++) await sleep(500);
  const req = createRequire(join(DESKTOP, "package.json"));
  const pkgDir = dirname(req.resolve("electron/package.json"));
  const exe = join(pkgDir, "dist", readFileSync(join(pkgDir, "path.txt"), "utf8").trim());
  const port = 9300 + Math.floor(Math.random() * 500);
  start("app", exe, [DESKTOP, "--clover-headless", `--clover-capture=${join(root, "cap.png")}`, "--use-mock-keychain", `--remote-debugging-port=${port}`], {
    ...env(), CLOVER_DAEMON_BIN: stubBin, CLOVER_DEV_DEBUG: "1",
  });
  let cdp: Cdp | undefined;
  for (let i = 0; i < 120 && cdp === undefined; i++) {
    await sleep(500);
    try { cdp = await Cdp.connect(port); } catch { /* not yet */ }
  }
  if (cdp === undefined) throw new Error("no devtools endpoint");
  const rpc = (await hello(join(home, "run", "core.sock"), "app", readFileSync(join(home, "run", "app.token"), "utf8").trim(), "clover-ui-probe", CLOVER_PROTOCOL_VERSION)).client;
  const script = process.argv[2];
  const mod = await import(resolve(script)) as { run(ctx: { cdp: Cdp; rpc: CloverClient; home: string; fake: typeof fake; root: string; logs: string; dummyKey: string; daemon: ChildProcess }): Promise<void> };
  try { await mod.run({ cdp, rpc, home, fake, root, logs, dummyKey, daemon }); } finally { cdp.close(); }
  void before;
}
main().catch((e) => { console.error(`probe: ${e instanceof Error ? e.stack : e}`); process.exitCode = 1; }).finally(() => void cleanup().then(() => process.exit(process.exitCode ?? 0)));
void readdirSync;
