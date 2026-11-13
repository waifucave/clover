// `plugins.install` from a component (the SDK's catalog: capability `plugins.install`, where `ui`; the capability is
// bundled-only, the plugin index browser's): an install from a source through the user's own door
// (`pluginRegistryMethods`' `plugin.install`), which lands the plugin found, waiting behind its sealed OK card. The card
// says which plugin asked ("<plugin> wants to add <name>.", the provenance `{ by: "plugin" }`), and nothing it installs
// runs before the user's OK. The router checks the capability and that the call comes from a component.
import { InstallSource } from "@waifucave/clover-protocol";
import { ContractError } from "../../contracts/common";
import type { ComponentInstallDoor } from "../registry-methods";
import type { ApiHandlers } from "./router";

export function pluginsInstallApi(door: () => ComponentInstallDoor | undefined): ApiHandlers {
  return {
    "plugins.install": async (ctx, args) => {
      const parsed = InstallSource.safeParse(args[0]);
      if (!parsed.success) throw new ContractError("invalid", "plugins.install takes a source: an index's plugin, an npm package, a folder or an item to wrap");
      const install = door();
      if (install === undefined) throw new ContractError("refused", "plugins.install isn't open yet on this computer: its plugins are still starting");
      const r = await install(ctx.pluginId, parsed.data);
      return { id: r.id, state: r.state, ...(r.card !== undefined ? { card: r.card } : {}) };
    },
  };
}
