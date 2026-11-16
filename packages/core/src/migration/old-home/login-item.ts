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
import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { OLD_INSTALL_HOME_DIR, OLD_INSTALL_LOGIN_LABEL } from "../../other-installs";
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

/** Runs the old engine's own `autostart disable` for `oldHome`, with a plain environment (no MOSS variable reaches
 *  it). `ok` false says why, in the old engine's words when it gave any. */
export async function disableOldLoginItem(item: OldLoginItem, oldHome: string, run: Runner = realRunner): Promise<{ ok: boolean; why?: string }> {
  if (!existsSync(item.bin)) return { ok: false, why: "its program isn't there any more" };
  const env: Record<string, string> = { [OLD_ENGINE_HOME_ENV]: oldHome, HOME: dirname(oldHome), PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };
  for (const k of ["USER", "LOGNAME", "TMPDIR"]) if (process.env[k] !== undefined) env[k] = process.env[k]!;
  const r = await run(item.bin, ["autostart", "disable"], env);
  if (r.code === 0) return { ok: true };
  const said = r.out.trim().split("\n").filter((l) => l.trim() !== "").pop()?.slice(0, 300);
  return { ok: false, why: said !== undefined && said !== "" ? said : `it exited with ${r.code ?? "a signal"}` };
}
