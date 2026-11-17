// The old engine's login item (ruling 8). MOSS never touches it. After the copy both engines would run the same
// routines, so the notice offers ONE button that runs the OLD engine's own supported command, `autostart disable`, for
// the old home, and says what it does. That command is the old install's own: on macOS it moves its login item out of
// `~/Library/LaunchAgents` into its own home's `login/` folder (that one write into the old home is the old engine's,
// on the person's press); nothing else of the old install changes, and the old engine keeps running if it is.
//
// Found read-only: the login item's file where the old engine wrote it, under the user's home of the old home's
// parent folder (the real user's home for the real profile; a run's temp user home in a test or the acceptance run):
//   macOS  `Library/LaunchAgents/<label>.plist`, the label being the old Keychain service's name (`other-installs.ts`);
//          its `ProgramArguments` name the old engine's binary, and its `EnvironmentVariables` the home it serves
//   Linux  `.config/systemd/user/<unit>`, on when `default.target.wants/<unit>` is there; its `ExecStart` names the
//          binary
//   Windows: not looked for (the old task is read through `schtasks`, which this lane leaves to a later one).
// Only an item that serves the copied home (by real path) and whose binary exists is offered.
//
// The press runs the binary only when it is the old engine's own (the plist is a file anyone of the user's could have
// written): its real path is inside the installed old app (`/Applications/<old app>.app/Contents/`, macOS) or the old
// home's `bin/` folder, and on macOS its code signature meets Apple's anchor and the product's team (the requirement
// style of `bundled-identities.ts`). Linux keeps no signature to check, so there the place alone decides. Anything
// else: the "could not" card, and nothing runs.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { MOSS_TEAM_ID } from "../../bundled-identities";
import { OLD_APP_BUNDLE_DIR, OLD_APP_NAME, OLD_INSTALL_HOME_DIR, OLD_INSTALL_LOGIN_LABEL } from "../../other-installs";
import { readOldText } from "./copy";
import { OLD_ENGINE_HOME_ENV, OLD_SYSTEMD_UNIT } from "./names";

export interface OldLoginItem {
  /** The old engine's binary, as its login item names it. */
  bin: string;
  /** The item's file, for the notice. */
  file: string;
}

const xmlUnescape = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/** The old engine's login item when it is on and serves `oldHome`, else undefined. */
export function oldLoginItem(oldHome: string, platform: NodeJS.Platform = process.platform): OldLoginItem | undefined {
  const user = dirname(oldHome);
  if (platform === "darwin") {
    const file = join(user, "Library", "LaunchAgents", `${OLD_INSTALL_LOGIN_LABEL}.plist`);
    const text = readOldText(file);
    if (text === undefined) return undefined;
    const args = /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>/.exec(text);
    const env = new RegExp(`<key>${OLD_ENGINE_HOME_ENV}</key>\\s*<string>([^<]*)</string>`).exec(text);
    if (args === null) return undefined;
    const bin = xmlUnescape(args[1]!);
    // No home named: the old engine's default, its folder under the user's home.
    const serves = env === null ? join(user, OLD_INSTALL_HOME_DIR) : xmlUnescape(env[1]!);
    if (real(serves) !== real(oldHome)) return undefined;
    return existsSync(bin) ? { bin, file } : undefined;
  }
  if (platform === "linux") {
    const units = join(user, ".config", "systemd", "user");
    const file = join(units, OLD_SYSTEMD_UNIT);
    if (!existsSync(join(units, "default.target.wants", OLD_SYSTEMD_UNIT))) return undefined;
    const text = readOldText(file);
    if (text === undefined) return undefined;
    const exec = /^ExecStart=("?)([^"\n]+?)\1\s+supervise\s*$/m.exec(text);
    const env = new RegExp(`^Environment="?${OLD_ENGINE_HOME_ENV}=([^"\\n]+)"?$`, "m").exec(text);
    if (exec === null) return undefined;
    if (real(env === null ? join(user, OLD_INSTALL_HOME_DIR) : env[1]!) !== real(oldHome)) return undefined;
    return existsSync(exec[2]!) ? { bin: exec[2]!, file } : undefined;
  }
  return undefined;
}

export type Runner = (bin: string, args: readonly string[], env: Record<string, string>) => Promise<{ code: number | null; out: string }>;

const realRunner: Runner = (bin, args, env) => new Promise((resolve) => {
  let out = "";
  const child = spawn(bin, [...args], { env, stdio: ["ignore", "pipe", "pipe"] });
  const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
  child.stdout?.on("data", (d: Buffer) => { if (out.length < 4000) out += d.toString("utf8"); });
  child.stderr?.on("data", (d: Buffer) => { if (out.length < 4000) out += d.toString("utf8"); });
  child.on("error", (err) => { clearTimeout(timer); resolve({ code: null, out: err.message }); });
  child.on("exit", (code) => { clearTimeout(timer); resolve({ code, out }); });
});

/** Where the old engine's own binary may be: inside the installed old app (macOS), or the old home's `bin/` folder. */
export function oldBinaryPlaces(oldHome: string, platform: NodeJS.Platform = process.platform): string[] {
  return [join(real(oldHome), "bin"), ...(platform === "darwin" ? [join(...OLD_APP_BUNDLE_DIR, "Contents")] : [])];
}

/** The code requirement the old engine's binary meets on macOS: Apple's anchor and the product's team. */
export function oldEngineRequirement(team: string = MOSS_TEAM_ID): string {
  if (!/^[A-Z0-9]{10}$/.test(team)) throw new Error(`not a team identifier: ${team}`);
  return `anchor apple generic and certificate leaf[subject.OU] = "${team}"`;
}

const codesignSatisfies = (path: string, requirement: string): boolean =>
  spawnSync("/usr/bin/codesign", ["--verify", "--strict", `-R=${requirement}`, path], { stdio: "ignore" }).status === 0;

export interface DisableOptions {
  run?: Runner;
  platform?: NodeJS.Platform;
  /** Seams for tests: the places the binary may be, and the signature check. */
  places?: readonly string[];
  verify?: (bin: string) => boolean;
}

/** Runs the old engine's own `autostart disable` for `oldHome`, with a plain environment (no MOSS variable reaches
 *  it), when the binary is the old engine's own (see the file's header). `ok` false says why, in the old engine's
 *  words when it gave any. */
export async function disableOldLoginItem(item: OldLoginItem, oldHome: string, o: DisableOptions = {}): Promise<{ ok: boolean; why?: string }> {
  const platform = o.platform ?? process.platform;
  const run = o.run ?? realRunner;
  let bin: string;
  try {
    bin = realpathSync(item.bin);
    if (!lstatSync(bin).isFile()) return { ok: false, why: "its program isn't a file" };
  } catch {
    return { ok: false, why: "its program isn't there any more" };
  }
  const places = (o.places ?? oldBinaryPlaces(oldHome, platform)).map(real);
  if (!places.some((pl) => bin.startsWith(pl.endsWith(sep) ? pl : pl + sep))) return { ok: false, why: `its program (${bin}) isn't ${OLD_APP_NAME}'s own: it is neither in ${OLD_APP_NAME}'s app nor in its folder's bin folder` };
  const verify = o.verify ?? (platform === "darwin" ? (b: string) => codesignSatisfies(b, oldEngineRequirement()) : () => true);
  if (!verify(bin)) return { ok: false, why: `its program isn't signed as ${OLD_APP_NAME}'s` };
  const env: Record<string, string> = { [OLD_ENGINE_HOME_ENV]: oldHome, HOME: dirname(oldHome), PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };
  for (const k of ["USER", "LOGNAME", "TMPDIR"]) if (process.env[k] !== undefined) env[k] = process.env[k]!;
  const r = await run(bin, ["autostart", "disable"], env);
  if (r.code === 0) return { ok: true };
  const said = r.out.trim().split("\n").filter((l) => l.trim() !== "").pop()?.slice(0, 300);
  return { ok: false, why: said !== undefined && said !== "" ? said : `it exited with ${r.code ?? "a signal"}` };
}
