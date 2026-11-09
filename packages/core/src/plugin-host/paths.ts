// A plugin's folders in the Clover home, by its id (`<root>/<top>[/<child>]`): its data folder and its log.
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
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

/** A plugin's relative file path as an asset URL's path (#332's review): each segment percent-encoded, or undefined for
 *  one that could leave the plugin's folder or name another origin: a `..` or `.` segment, a backslash, a scheme
 *  (`https:`), `//`, a leading `/`, an empty segment, or a control character. */
export function assetPath(path: string): string | undefined {
  if (typeof path !== "string" || path === "" || path.length > 1024) return undefined;
  if (path.includes("\\") || path.startsWith("/") || path.includes("//") || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(path) || /[\u0000-\u001f\u007f]/.test(path)) return undefined;
  const parts = path.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) return undefined;
  return parts.map((p) => encodeURIComponent(p)).join("/");
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A JSON object file, or {} when there is none. One that doesn't parse as an object is moved aside
 *  (`<file>.corrupt-<time>`) and the read fails, naming both, so nothing writes over it unseen (#332's review). */
export function readJsonOrKeepAside(f: string, what: string): Record<string, unknown> {
  if (!existsSync(f)) return {};
  let v: unknown;
  try {
    v = JSON.parse(readFileSync(f, "utf8"));
  } catch {
    v = undefined;
  }
  if (isObject(v)) return v;
  const aside = `${f}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  try {
    renameSync(f, aside);
  } catch (err) {
    throw new ContractError("failed", `${what} at ${f} can't be read, and couldn't be moved aside (${(err as Error).message})`);
  }
  throw new ContractError("failed", `${what} at ${f} couldn't be read; it's kept at ${aside}, and starts empty`);
}
