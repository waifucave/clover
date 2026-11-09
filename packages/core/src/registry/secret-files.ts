// A plugin's secret as a file (`${secretFile:<key>}` in a stdio server's `env` or `args`; the controller's ruling on
// #377): macOS lets any process of the user read another's environment, and a third-party server's program can't be
// signed to hide it, so a server that reads its key from a file is given one instead, and the OK shows no env warning.
//
// * Where: `<home>/run/plugin-secrets/<top>/<server>/<key>`, a folder the plugin's own fenced processes READ (its
//   hooks' and MCP servers' fence lists it, `toolFence`) and no plugin process writes. Its own data folder is
//   writable by the plugin, which could plant a link there and have the core write a secret wherever it pointed, so
//   the file lives beside it, fenced to the same plugin, not in it. No other plugin's fence lists it, and the Clover
//   home is closed to every fenced process.
// * How: folders 0700, the file written to a fresh name in its folder with `wx` and mode 0600, then renamed over
//   `<key>`, so a reader never sees half a key, and owner-only throughout.
// * Gone: when its server stops (`release`), when its plugin is removed (`releasePlugin`), and all of them when the
//   daemon starts (`sweep`), so a crash leaves none behind.
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { KEY_RE } from "@waifucave/clover-plugin-sdk";
import { ContractError } from "../contracts/common";
import { pluginPath } from "../plugin-host/paths";

/** `<home>/run/plugin-secrets`. */
export function secretFilesRoot(cloverHome: string): string {
  return join(cloverHome, "run", "plugin-secrets");
}

/** The folder a top-level plugin's secret files are in, which its fenced processes read. */
export function secretFilesFolder(cloverHome: string, pluginId: string): string {
  return pluginPath(secretFilesRoot(cloverHome), pluginId.split("/")[0]!);
}

const SERVER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export class PluginSecretFiles {
  constructor(private readonly cloverHome: string) {}

  /** Writes `value` as the file for `key` of `server` (of `pluginId`'s tree) and gives back its path. */
  write(pluginId: string, server: string, key: string, value: string): string {
    if (!SERVER_RE.test(server) || server.includes("..")) throw new ContractError("invalid", `${JSON.stringify(server)} isn't a server name`);
    if (!KEY_RE.test(key)) throw new ContractError("invalid", `${JSON.stringify(key)} isn't a secret's name`);
    const root = secretFilesRoot(this.cloverHome);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const folder = join(secretFilesFolder(this.cloverHome, pluginId), server);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const file = join(folder, key);
    const tmp = join(folder, `.${key}.${randomBytes(8).toString("hex")}`);
    try {
      writeFileSync(tmp, value, { mode: 0o600, flag: "wx" });
      renameSync(tmp, file);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
    return file;
  }

  /** Its server stopped: its files go. */
  release(pluginId: string, server: string): void {
    if (!SERVER_RE.test(server) || server.includes("..")) return;
    rmSync(join(secretFilesFolder(this.cloverHome, pluginId), server), { recursive: true, force: true });
  }

  /** Its plugin was removed: every file of its tree goes. */
  releasePlugin(pluginId: string): void {
    rmSync(secretFilesFolder(this.cloverHome, pluginId), { recursive: true, force: true });
  }

  /** The daemon starts: none is left from a run before (no server of it runs now). */
  sweep(): void {
    rmSync(secretFilesRoot(this.cloverHome), { recursive: true, force: true });
  }
}
