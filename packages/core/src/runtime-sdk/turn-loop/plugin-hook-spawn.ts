// The door a plugin's `command` hook runs through (#414's review): the PLUGIN's fence, never the hooked session's.
// A hook's command is plugin code, so it gets what the plugin's own processes get (B's `toolFence`, `plugin-fence.ts`):
// its plugin's tree, Clover's run files and shared packages and the plugin Bun to read; its own data folder and temp
// folder to write; the package managers' installs to read; nothing else of the Clover home. The hooked session lends
// only its project folders (its working directories): readable, and writable when the plugin holds `project.write`.
// The network: only through its plugin tree's proxy (lane B's 2g, `guard.proxyFor`: the hosts the plugin's OK granted),
// as the plugins' own hook runner (`plugins/hook-runner.ts`) does; with no proxy (the plugin host not started yet),
// none at all.
//
// The plugin comes from the run's `who.pluginId`, and its folder from the registry (`pluginRoot`), never from the
// caller's `cwd`. On macOS a run is refused when the plugin fence can't be had (no `sandbox-exec`, or the guard turned
// off): a hook never runs unfenced there. Windows and Linux run it as the user, the plugin host's rule there (spec §5.2,
// revision 13), with the same folders and environment.
import { join } from "node:path";
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
  /** Tests: the platform whose rule applies. */
  readonly platform?: NodeJS.Platform;
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
        const proxy = o.guard.proxyFor?.(pluginId);
        tool = toolFence({
          files: o.guard.files, shared: o.guard.shared ?? cloverSharedRoots(), pluginRoot: root, pluginId,
          ...(o.guard.fence !== false && o.guard.fence?.userHome !== undefined ? { userHome: o.guard.fence.userHome } : {}),
          name: `hook-${pluginId}`, ...(project !== undefined ? { project } : {}),
          ...(proxy !== undefined ? { proxyPort: proxy.port } : {}),
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
      } catch (err) {
        return refused(`the plugin's fence couldn't be set up (${err instanceof Error ? err.message : String(err)})`);
      }
      let shell: RunShell = "sh";
      let argv: string[];
      if (platform === "win32") {
        const w = windowsHookShell();
        shell = w.shell;
        argv = w.argv(r.command);
      } else {
        argv = mac ? fencedCommand(["/bin/sh", "-c", r.command], tool.fence, platform) : ["/bin/sh", "-c", r.command];
        if (mac && argv[0] !== "/usr/bin/sandbox-exec") return refused("the plugin fence (sandbox-exec) isn't on this Mac");
      }
      const run: FencedRun = { ...r, cwd: root, env };
      return runCommand(run, { shell, argv, ...(mac ? { descendants: { kind: "tree" as const } } : {}) });
    },
  };
}

/** The plugin's data folder a hook writes (`<home>/plugin-data/<top>`), for tests and the daemon's log. */
export const pluginDataFolder = (cloverHome: string, pluginId: string): string => join(cloverHome, "plugin-data", pluginId.split("/")[0]!);
