// The compiled-core probe for a plugin's Bun process (#234's checks 4 and 5; `scripts/verify-fd-receiver-compiled.ts`,
// step 3d). Inside the compiled `clover-core`, plugin code runs on `clover-plugin-bun` beside it (`pluginBun`), never on
// the core's own binary, whose identity the Keychain items trust. This starts a plugin host through the supervisor's
// own launch (`pluginBunLaunch`), with `BUN_BE_BUN=1` in the environment it is given, and reports what the host ran on,
// whether `BUN_BE_BUN` reached it, whether the load guard was preloaded, and whether an outside import was refused.
//
// Only in a build with `--define CLOVER_PLUGIN_RUN_PROBE=true` (the gate's); never in a release build. Runs only in a
// scratch folder the caller names (an absolute path to an empty folder): it touches no home, no Keychain, no daemon.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { ensurePluginRunFiles, pluginBun, pluginBunLaunch } from "../../core/src/registry/plugin-run";

export interface PluginRunProbeResult {
  ok: boolean;
  /** The core's own binary, and `pluginBun()` as it resolves here, both real paths. */
  core?: string;
  pluginBun?: string;
  /** What the host reported, parsed. */
  host?: { execPath?: string; main?: string; version?: string; beBun?: string; shadowRealm?: string; outside?: string };
  outsideRan?: boolean;
  error?: string;
}

export function runPluginRunProbe(scratch: string | undefined): PluginRunProbeResult {
  if (scratch === undefined || !isAbsolute(scratch) || !existsSync(scratch) || readdirSync(scratch).length > 0) {
    return { ok: false, error: "the probe needs an absolute path to an empty scratch folder" };
  }
  const outside = join(scratch, "outside");
  const plugin = join(scratch, "plugin");
  const mark = join(scratch, "mark");
  mkdirSync(outside);
  mkdirSync(join(plugin, "host"), { recursive: true });
  writeFileSync(join(outside, "evil.ts"), `require("node:fs").writeFileSync(${JSON.stringify(mark)}, "ran");\nexport const x = 1;\n`);
  writeFileSync(join(plugin, "host", "index.ts"), [
    "const out: Record<string, string> = { execPath: process.execPath, main: Bun.main, version: Bun.version, beBun: process.env.BUN_BE_BUN ?? \"unset\" };",
    "try { new ShadowRealm(); out.shadowRealm = \"made\"; } catch { out.shadowRealm = \"refused\"; }",
    `try { await import(${JSON.stringify(join(outside, "evil.ts"))}); out.outside = "loaded"; }`,
    "catch (e) { out.outside = String((e as Error).message).includes(\"clover: refused\") ? \"refused\" : `error: ${(e as Error).message}`; }",
    "console.log(`plugin-host ${JSON.stringify(out)}`);",
    "",
  ].join("\n"));
  let bun: string;
  try {
    bun = pluginBun();
  } catch (e) {
    return { ok: false, core: realpathSync(process.execPath), error: (e as Error).message };
  }
  const files = ensurePluginRunFiles(join(scratch, "run"));
  // BUN_BE_BUN in what the launch is given: it must never reach the host.
  const base = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? scratch, BUN_BE_BUN: "1" };
  const { cmd, env } = pluginBunLaunch(["host/index.ts"], base, { pluginRoot: plugin, files });
  const r = spawnSync(cmd[0]!, cmd.slice(1), { cwd: plugin, env, encoding: "utf8", timeout: 20_000 });
  const line = (r.stdout ?? "").split("\n").find((l) => l.startsWith("plugin-host "));
  let host: PluginRunProbeResult["host"];
  try {
    host = line === undefined ? undefined : JSON.parse(line.slice("plugin-host ".length));
  } catch {
    host = undefined;
  }
  const core = realpathSync(process.execPath);
  const result: PluginRunProbeResult = {
    ok: false, core, pluginBun: realpathSync(bun), outsideRan: existsSync(mark),
    ...(host === undefined ? { error: `no host line (exit ${r.status}): ${(r.stderr ?? "").trim().slice(0, 400)}` } : { host }),
  };
  const ranOn = host?.execPath === undefined ? undefined : realpathSync(host.execPath);
  result.ok = cmd[0] === bun && result.pluginBun !== core && ranOn === result.pluginBun && ranOn !== core
    && host?.main === realpathSync(join(plugin, "host", "index.ts")) && host.beBun === "unset"
    && host.shadowRealm === "refused" && host.outside === "refused" && result.outsideRan === false;
  return result;
}
