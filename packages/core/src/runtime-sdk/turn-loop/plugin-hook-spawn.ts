// The door a plugin's `command` hook runs through (#414's review): the PLUGIN's fence, never the hooked session's.
// A hook's command is plugin code, so it gets what the plugin's own processes get (B's `toolFence`, `plugin-fence.ts`):
// its plugin's tree, Clover's run files and shared packages and the plugin Bun to read; its own data folder and temp
// folder to write; the package managers' installs to read; nothing else of the Clover home. The hooked session lends
// only its project folders (its working directories): readable, and writable when the plugin holds `project.write`.
// The network: only through its plugin tree's proxy (lane B's 2g, `guard.proxyFor`: the hosts the plugin's OK granted),
// as the plugins' own hook runner (`plugins/hook-runner.ts`) does; with no proxy (the plugin host not started yet),
// none at all. A wrapper the user brought, with the grant on its install record and no `network:` host declared
// (`guard.openNetwork`, the owner's ruling of 2026-11-10), reaches any host instead, fenced for files the same.
//
// The plugin comes from the run's `who.pluginId`, and its folder from the registry (`pluginRoot`), never from the
// caller's `cwd`. On macOS a run is refused when the plugin fence can't be had (no `sandbox-exec`, or the guard turned
// off): a hook never runs unfenced there. Windows and Linux run it as the user, the plugin host's rule there (spec §5.2,
// revision 13), with the same folders and environment.
import { join } from "node:path";
import { hookPlaceholderEnv, hookReadsStdinAsScript, interpolate, parseInterpolation } from "@waifucave/clover-plugin-sdk";
import type { PluginSettings } from "../../plugin-host/api/settings";
import { runCommand, windowsHookShell, type FencedRun, type FencedRunResult, type FencedSpawner, type RunShell } from "../../fence/spawn";
import { fencedCommand, pluginFenceAvailable, toolFence, type ProjectAccess } from "../../registry/plugin-fence";
import { cloverSharedRoots, guardedPluginEnv, type PluginRunGuard } from "../../registry/plugin-run";

export interface PluginHookSpawnerOptions {
  /** Clover's run files for plugin processes (the daemon's, in its run folder). */
  readonly guard: PluginRunGuard;
  /** The plugin's folder on this computer, from the registry; undefined refuses the run. */
  pluginRoot(pluginId: string): string | undefined;
  /** The hooked session's project folders, and whether the plugin holds `project.write`. */
  projectFor?(pluginId: string, sessionId: string): ProjectAccess | undefined;
  /** The plugin's settings: `${setting:k}` in a hook's command and args, and each plain setting as Claude Code's
   *  `CLAUDE_PLUGIN_OPTION_<KEY>` in its environment. Absent, a hook naming a setting is refused. */
  readonly settings?: Pick<PluginSettings, "fields" | "get">;
  /** Tests: the platform whose rule applies. */
  readonly platform?: NodeJS.Platform;
}

const settingText = (v: unknown): string | undefined => (v === undefined || v === null ? undefined : typeof v === "string" ? v : JSON.stringify(v));

/** What a hook runs (§5.3, `hook-command.ts`): with `args`, the program and its arguments, each placeholder filling
 *  its whole argument; without, a shell command line whose placeholders are references to variables that carry their
 *  values (`hookPlaceholderEnv`), so no value is ever parsed as shell. Throws on a missing setting or a refused shape. */
export function hookArgv(
  r: Pick<FencedRun, "command" | "args">,
  fill: { plugin: string; data: string; setting(key: string): string | undefined },
  shell: "sh" | "cmd",
): { argv?: string[]; line?: string; env: Record<string, string> } {
  const why = hookReadsStdinAsScript(r.command, r.args);
  if (why !== undefined) throw new Error(`${why}; a hook's stdin is its input, never a script`);
  const values = { ...fill, secret: () => undefined };
  if (r.args !== undefined) return { argv: [interpolate(r.command, values), ...r.args.map((a) => interpolate(a, values))], env: {} };
  const parsed = parseInterpolation(r.command);
  if (!parsed.ok) throw new Error(parsed.error);
  const env: Record<string, string> = {};
  const line = parsed.parts.map((p) => {
    if (p.kind === "text") return p.text;
    if (p.kind !== "plugin" && p.kind !== "data" && p.kind !== "setting") throw new Error("a hook's command holds no secret");
    const name = hookPlaceholderEnv(p);
    const value = p.kind === "plugin" ? fill.plugin : p.kind === "data" ? fill.data : fill.setting(p.key);
    if (value === undefined) throw new Error(`setting ${(p as { key: string }).key} is not set`);
    env[name] = value;
    return shell === "cmd" ? `%${name}%` : `\${${name}}`;
  }).join("");
  return { line, env };
}

const refused = (reason: string): FencedRunResult => ({ kind: "refused", reason });

export function pluginHookSpawner(o: PluginHookSpawnerOptions): FencedSpawner {
  const platform = o.platform ?? process.platform;
  const mac = platform === "darwin";
  const fenceable = o.guard.fence !== false && pluginFenceAvailable(platform);
  const available = !mac || fenceable;
  return {
    available,
    run: async (r: FencedRun) => {
      const pluginId = r.who.pluginId;
      if (pluginId === undefined || pluginId === "") return refused("a hook's run names no plugin, so it has no fence of its own");
      if (!available) return refused("the plugin fence (sandbox-exec) isn't on this Mac");
      const root = o.pluginRoot(pluginId);
      if (root === undefined || root === "") return refused("the plugin has no folder on this computer");
      const sessionId = r.who.caller.kind === "session" ? r.who.caller.sessionId : undefined;
      const project = sessionId === undefined ? undefined : o.projectFor?.(pluginId, sessionId);
      let tool: ReturnType<typeof toolFence>;
      let env: Record<string, string>;
      try {
        const open = o.guard.openNetwork?.(pluginId) === true;
        const proxy = open ? undefined : o.guard.proxyFor?.(pluginId);
        tool = toolFence({
          files: o.guard.files, shared: o.guard.shared ?? cloverSharedRoots(), pluginRoot: root, pluginId,
          ...(o.guard.fence !== false && o.guard.fence?.userHome !== undefined ? { userHome: o.guard.fence.userHome } : {}),
          name: `hook-${pluginId}`, ...(project !== undefined ? { project } : {}),
          ...(proxy !== undefined ? { proxyPort: proxy.port } : {}), ...(open ? { openNetwork: true } : {}),
        });
        const data = tool.fence.write.find((w) => w !== tool.tmp);
        env = guardedPluginEnv({
          ...r.env, ...tool.env, ...(proxy?.env ?? {}),
          // The plugin Bun first, so a `bun` the hook starts is the guarded one (#234's check 5).
          PATH: [o.guard.files.bin, r.env.PATH].filter((p) => p !== undefined && p !== "").join(platform === "win32" ? ";" : ":"),
          ...(data === undefined ? {} : { CLOVER_PLUGIN_DATA: data, CLAUDE_PLUGIN_DATA: data }),
        }, { pluginRoot: root, files: o.guard.files, ...(o.guard.shared === undefined ? {} : { shared: o.guard.shared }) });
        // Claude Code's name for the root, as the guard resolved it.
        env.CLAUDE_PLUGIN_ROOT = env.CLOVER_PLUGIN_ROOT ?? root;
        // Its plain settings as Claude Code hands a plugin's options to its hooks: values in the environment, never in a
        // script (a secret setting is never given).
        for (const [key, field] of o.settings?.fields(pluginId) ?? []) {
          if (field.type === "secret") continue;
          const v = settingText(o.settings!.get(pluginId, key));
          if (v !== undefined) env[`CLAUDE_PLUGIN_OPTION_${key.toUpperCase().replace(/[^A-Z0-9_]/g, "_")}`] = v;
        }
      } catch (err) {
        return refused(`the plugin's fence couldn't be set up (${err instanceof Error ? err.message : String(err)})`);
      }
      const win = platform === "win32" ? windowsHookShell() : undefined;
      let how: ReturnType<typeof hookArgv>;
      try {
        how = hookArgv(r, {
          plugin: env.CLOVER_PLUGIN_ROOT ?? root, data: env.CLOVER_PLUGIN_DATA ?? "",
          setting: (key) => settingText(o.settings?.get(pluginId, key)),
        }, win?.shell === "cmd" ? "cmd" : "sh");
      } catch (err) {
        return refused(`its command can't be run (${err instanceof Error ? err.message : String(err)})`);
      }
      Object.assign(env, how.env);
      let shell: RunShell = "sh";
      let argv: string[];
      // With `args`: the program itself, no shell between. Without: the platform's shell, its script the command line.
      const inner = how.argv ?? (win !== undefined ? win.argv(how.line!) : ["/bin/sh", "-c", how.line!]);
      if (how.argv !== undefined) shell = "none";
      else if (win !== undefined) shell = win.shell;
      if (platform === "win32") argv = inner;
      else {
        argv = mac ? fencedCommand(inner, tool.fence, platform) : inner;
        if (mac && argv[0] !== "/usr/bin/sandbox-exec") return refused("the plugin fence (sandbox-exec) isn't on this Mac");
      }
      const run: FencedRun = { ...r, cwd: root, env };
      return runCommand(run, { shell, argv, ...(mac ? { descendants: { kind: "tree" as const } } : {}) });
    },
  };
}

/** The plugin's data folder a hook writes (`<home>/plugin-data/<top>`), for tests and the daemon's log. */
export const pluginDataFolder = (cloverHome: string, pluginId: string): string => join(cloverHome, "plugin-data", pluginId.split("/")[0]!);
