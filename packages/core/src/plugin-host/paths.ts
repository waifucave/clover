// A plugin's folders in the Clover home, by its id (`<root>/<top>[/<child>]`): its data folder and its log.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ContractError } from "../contracts/common";

/** `<root>/<id>`, each part of the id checked as a plugin id's (`invalid` otherwise). */
export function pluginPath(root: string, pluginId: string): string {
  const parts = pluginId.split("/");
  if (parts.length > 2 || parts.some((p) => !/^[a-z0-9][a-z0-9-]{0,63}$/.test(p))) throw new ContractError("invalid", `${pluginId} isn't a plugin id`);
  return join(root, ...parts);
}

/** `<home>/plugin-data/<id>/`, made on first use. */
export function pluginDataFolder(cloverHome: string, pluginId: string): string {
  const dir = pluginPath(join(cloverHome, "plugin-data"), pluginId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
