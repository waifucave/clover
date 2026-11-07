// `clover plugin validate <folder> [--json] [--upgrade]` (spec §5.6): a folder's class, contributions, points, hosts,
// capabilities, tools, settings and children, every finding and the OK's text, without running anything. Exits
// non-zero on any error. `--upgrade` first rewrites files in an older format to the newest one (§5.1 "Formats").
import { resolve } from "node:path";
import { registry } from "@waifucave/clover-core";

export interface ValidateRun {
  code: number;
  output: string;
}

export function parseValidateArgs(args: readonly string[]): { folder?: string; json: boolean; upgrade: boolean; error?: string } {
  let folder: string | undefined;
  let json = false;
  let upgrade = false;
  for (const a of args) {
    if (a === "--json") json = true;
    else if (a === "--upgrade") upgrade = true;
    else if (a.startsWith("-")) return { json, upgrade, error: `unknown option ${a}` };
    else if (folder === undefined) folder = a;
    else return { json, upgrade, error: "one folder at a time" };
  }
  return { ...(folder === undefined ? {} : { folder }), json, upgrade };
}

const osName = (): "macos" | "windows" | "linux" => (process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux");

export async function runPluginValidate(args: readonly string[], cwd = process.cwd()): Promise<ValidateRun> {
  const p = parseValidateArgs(args);
  if (p.error) return { code: 2, output: `${p.error}\nusage: clover plugin validate [<folder>] [--json] [--upgrade]` };
  const folder = resolve(cwd, p.folder ?? ".");
  const upgraded = p.upgrade ? registry.upgradePluginFolder(folder) : [];
  const v = await registry.validatePluginFolder(folder, { os: osName() });
  const failedUpgrade = upgraded.some((u) => u.status !== "upgraded");
  const code = v.ok && !failedUpgrade ? 0 : 1;
  if (p.json) return { code, output: JSON.stringify(p.upgrade ? { ...v, upgraded } : v, null, 2) };
  const head = upgraded.map((u) =>
    u.status === "upgraded" ? `upgraded ${u.file}: ${u.format} format ${u.from} to ${u.to}`
      : u.status === "newer" ? `${u.file}: ${u.format} format ${u.from} needs a newer Clover`
        : `${u.file}: ${u.format} format ${u.from} is one this Clover never shipped`);
  if (p.upgrade && upgraded.length === 0) head.push("every file is in its format's newest version");
  return { code, output: [...head, ...(head.length > 0 ? [""] : []), registry.renderValidation(v)].join("\n") };
}
