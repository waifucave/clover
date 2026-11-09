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
//   `<key>`, so a reader never sees half a key, and owner-only throughout. The path is
//   `<home>/run/plugin-secrets/<top>/<server>/<instance>/<key>`.
// * Each folder on the way (the root, `<top>`, `<server>`, the instance's) must be a real directory owned by this
//   user (never a link another process of the user planted), and is set to 0700 if it was there already.
// * Per instance: two running instances of one server each get their own folder (`<server>/<instance>`), so one
//   stopping never takes the other's keys.
// * Gone: when its instance stops (`release`, which the launcher calls on every stop path), when its plugin is removed
//   (`releasePlugin`), and all of them when the daemon starts (`sweep`), so a crash leaves none behind.
// * Trust is per plugin: a plugin's hooks and its other servers read the same folder, so they can read each other's
//   key files, as they could ask the core for the same secrets.
import { chmodSync, lstatSync, mkdirSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
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
const INSTANCE_RE = /^[0-9a-f]{12}$/;

/** A folder of the way to a secret's file: made 0700 if it isn't there; if it is, it must be a real directory (not a
 *  link) owned by this user, and is set to 0700. */
function ownFolder(path: string): void {
  try {
    mkdirSync(path, { mode: 0o700 });
    return;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  const st = lstatSync(path);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new ContractError("refused", `${path} isn't a folder of Clover's (a link or a file is there)`);
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) throw new ContractError("refused", `${path} isn't owned by this user`);
  if ((st.mode & 0o777) !== 0o700) chmodSync(path, 0o700);
}

export class PluginSecretFiles {
  constructor(private readonly cloverHome: string) {}

  /** A new instance's id: each running instance of a server has its own folder. */
  static instance(): string {
    return randomBytes(6).toString("hex");
  }

  /** Writes `value` as the file for `key` of `server`'s `instance` (of `pluginId`'s tree) and gives back its path. */
  write(pluginId: string, server: string, key: string, value: string, instance: string): string {
    if (!SERVER_RE.test(server) || server.includes("..")) throw new ContractError("invalid", `${JSON.stringify(server)} isn't a server name`);
    if (!KEY_RE.test(key)) throw new ContractError("invalid", `${JSON.stringify(key)} isn't a secret's name`);
    if (!INSTANCE_RE.test(instance)) throw new ContractError("invalid", `${JSON.stringify(instance)} isn't an instance id`);
    mkdirSync(join(this.cloverHome, "run"), { recursive: true, mode: 0o700 });
    const top = secretFilesFolder(this.cloverHome, pluginId);
    const folder = join(top, server, instance);
    for (const d of [secretFilesRoot(this.cloverHome), top, join(top, server), folder]) ownFolder(d);
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

  /** Its instance stopped: that instance's files go, and no other's. */
  release(pluginId: string, server: string, instance: string): void {
    if (!SERVER_RE.test(server) || server.includes("..") || !INSTANCE_RE.test(instance)) return;
    const serverFolder = join(secretFilesFolder(this.cloverHome, pluginId), server);
    rmSync(join(serverFolder, instance), { recursive: true, force: true });
    // The server's folder too, once no instance of it is left (another's keeps it).
    try {
      rmdirSync(serverFolder);
    } catch {
      // another instance's files are there, or it's gone already
    }
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
