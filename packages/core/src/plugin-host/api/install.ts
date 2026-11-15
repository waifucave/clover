// `plugins.install` from a component (the SDK's catalog: capability `plugins.install`, where `ui`; the capability is
// bundled-only, the plugin index browser's, "Install plugins from the indexes and npm for the user to OK"): an install
// from an index or npm, nothing else (a folder path or a wrapped item is the user's own to bring), through the user's door
// (`pluginRegistryMethods`' `plugin.install`), which lands the plugin found, waiting behind its sealed OK card. The card
// says which plugin asked ("<plugin> wants to add <name>.", the provenance `{ by: "plugin" }`), and nothing it installs
// runs before the user's OK. The router checks the capability and that the call comes from a component.
import { InstallSource } from "@waifucave/clover-protocol";
import { ContractError } from "../../contracts/common";
import type { ComponentInstallDoor } from "../registry-methods";
import type { ApiHandlers } from "./router";

/** Why a component's install from a folder or a wrapped item is refused. */
export const PLUGINS_INSTALL_SOURCES = "a plugin can add plugins only from an index or npm";

export function pluginsInstallApi(door: () => ComponentInstallDoor | undefined): ApiHandlers {
  return {
    "plugins.install": async (ctx, args) => {
      const parsed = InstallSource.safeParse(args[0]);
      if (!parsed.success) throw new ContractError("invalid", "plugins.install takes a source: a plugin from an index, or an npm package");
      // What the capability says it does: from the indexes and npm. A folder on this computer, or an item the core wraps
      // (an MCP config, a skill folder, an agent file, a Claude Code plugin), is the user's own to bring: a wrapped
      // server is granted as the user's (any host), so a plugin never brings one.
      if (parsed.data.from !== "index" && parsed.data.from !== "npm") throw new ContractError("refused", PLUGINS_INSTALL_SOURCES);
      const install = door();
      if (install === undefined) throw new ContractError("refused", "plugins.install isn't open yet on this computer: its plugins are still starting");
      const r = await install(ctx.pluginId, parsed.data);
      return { id: r.id, state: r.state, ...(r.card !== undefined ? { card: r.card } : {}) };
    },
  };
}
