// The compiled-core probe for a plugin's Bun process (#234's check 4, H3; `scripts/verify-fd-receiver-compiled.ts`,
// step 3d). Inside the shipped `clover-core`, `cloverBun()` is the core binary itself with `BUN_BE_BUN=1`: this starts
// a plugin host through the supervisor's own launch (`pluginBunLaunch`) and reports whether it ran as Bun (rather than
// re-entering the core's main), with the load guard preloaded, and whether an outside import was refused.
//
// Runs only in a scratch folder the caller names (an absolute path to an empty folder): it touches no home, no
// Keychain, no daemon.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { cloverBun, ensurePluginRunFiles, pluginBunLaunch } from "../../core/src/registry/plugin-run";

export interface PluginRunProbeResult {
  ok: boolean;
  /** `cloverBun()` as this binary sees it. */
  command?: string;
  beBun?: boolean;
  /** What the host reported, parsed. */
  host?: { main?: string; version?: string; shadowRealm?: string; outside?: string };
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
    "const out: Record<string, string> = { main: Bun.main, version: Bun.version };",
    "try { new ShadowRealm(); out.shadowRealm = \"made\"; } catch { out.shadowRealm = \"refused\"; }",
    `try { await import(${JSON.stringify(join(outside, "evil.ts"))}); out.outside = "loaded"; }`,
    "catch (e) { out.outside = String((e as Error).message).includes(\"clover: refused\") ? \"refused\" : `error: ${(e as Error).message}`; }",
    "console.log(`plugin-host ${JSON.stringify(out)}`);",
    "",
  ].join("\n"));
  const files = ensurePluginRunFiles(join(scratch, "run"));
  const base = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? scratch };
  const { cmd, env } = pluginBunLaunch(["host/index.ts"], base, { pluginRoot: plugin, files });
  const r = spawnSync(cmd[0]!, cmd.slice(1), { cwd: plugin, env, encoding: "utf8", timeout: 20_000 });
  const line = (r.stdout ?? "").split("\n").find((l) => l.startsWith("plugin-host "));
  let host: PluginRunProbeResult["host"];
  try {
    host = line === undefined ? undefined : JSON.parse(line.slice("plugin-host ".length));
  } catch {
    host = undefined;
  }
  const result: PluginRunProbeResult = {
    ok: false, command: cloverBun().command, beBun: cloverBun().env.BUN_BE_BUN === "1", outsideRan: existsSync(mark),
    ...(host === undefined ? { error: `no host line (exit ${r.status}): ${(r.stderr ?? "").trim().slice(0, 400)}` } : { host }),
  };
  result.ok = result.command === process.execPath && result.beBun === true && host?.main === realpathSync(join(plugin, "host", "index.ts"))
    && host.shadowRealm === "refused" && host.outside === "refused" && result.outsideRan === false;
  return result;
}
