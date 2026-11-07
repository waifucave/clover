// `clover code` (spec §9.3 "The user can also start a coding agent directly from the app or the CLI"): starts a coding
// session the user drives, with no bot, through the daemon's `agent.start` (lane K's method, packages/core/src/agents/
// rpc.ts). Owner: lane K, which the controller cleared for this one command in packages/cli.
//
//   clover code [folder] --backend <id> [--model <m>] [--effort <e>] [--computer <Name>] [-p <prompt>]
//
// The folder is a folder-tree path (`home/<Computer>/…`) or a local folder inside the user's home, the current one by
// default; a local folder becomes `home/<Computer>/<path under the home>`, so the CLI needs this computer's name in
// the tree (`--computer`, or `CLOVER_COMPUTER`). The daemon checks the rest: the backend, the root's fence, and the
// user's OK for an agent with no sandbox Clover counts on.
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const CODE_USAGE = "usage: clover code [folder] --backend <id> [--model <m>] [--effort <e>] [--computer <Name>] [-p <prompt>]";

export interface CodeArgs {
  folder?: string;
  backend: string;
  model?: string;
  effort?: string;
  computer?: string;
  prompt?: string;
}

const COMPUTER_NAME_RE = /^[A-Za-z0-9]+(-[A-Za-z0-9]+)*$/;

export function parseCodeArgs(argv: readonly string[]): { kind: "ok"; args: CodeArgs } | { kind: "usage"; message: string } {
  const out: Partial<CodeArgs> = {};
  const flags: Record<string, keyof CodeArgs> = { "--backend": "backend", "--model": "model", "--effort": "effort", "--computer": "computer", "-p": "prompt", "--prompt": "prompt" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const key = flags[a];
    if (key) {
      const v = argv[i + 1];
      if (v === undefined || v === "") return { kind: "usage", message: `${a} needs a value\n${CODE_USAGE}` };
      out[key] = v;
      i++;
    } else if (a.startsWith("-")) {
      return { kind: "usage", message: `unknown option ${a}\n${CODE_USAGE}` };
    } else if (out.folder === undefined) {
      out.folder = a;
    } else {
      return { kind: "usage", message: `one folder only\n${CODE_USAGE}` };
    }
  }
  if (!out.backend) return { kind: "usage", message: `name the agent with --backend (clover agents backends lists them)\n${CODE_USAGE}` };
  return { kind: "ok", args: out as CodeArgs };
}

/** The session's root as a folder-tree path. */
export function treeRootOf(folder: string | undefined, o: { cwd: string; home: string; computer?: string }): { ok: true; root: string; computer?: string } | { ok: false; message: string } {
  if (folder !== undefined && /^(home|bots)\//.test(folder)) {
    const name = /^home\/([^/]+)/.exec(folder)?.[1];
    return { ok: true, root: folder.replace(/\/+$/, ""), ...(name ? { computer: name } : {}) };
  }
  if (!o.computer) return { ok: false, message: "name this computer as the folder tree does, with --computer <Name> (or CLOVER_COMPUTER)" };
  if (!COMPUTER_NAME_RE.test(o.computer)) return { ok: false, message: `${o.computer} isn't a computer name (letters, digits and hyphens)` };
  const abs = resolve(o.cwd, folder ?? ".");
  const rel = relative(o.home, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) return { ok: false, message: `${abs} isn't inside your home folder, so it has no place in the folder tree` };
  const parts = rel === "" ? [] : rel.split(sep);
  return { ok: true, root: ["home", o.computer, ...parts].join("/"), computer: o.computer };
}

export interface CodeDeps {
  connect(name: string): Promise<{ request(method: string, params?: unknown): Promise<unknown>; close(): void }>;
  log(line: string): void;
  error(line: string): void;
  cwd?: string;
  home?: string;
  env?: Record<string, string | undefined>;
}

/** Runs `clover code`; resolves with the exit code. */
export async function runCodeCommand(argv: readonly string[], deps: CodeDeps): Promise<number> {
  const parsed = parseCodeArgs(argv);
  if (parsed.kind === "usage") {
    deps.error(parsed.message);
    return 1;
  }
  const a = parsed.args;
  const computer = a.computer ?? (deps.env ?? process.env)["CLOVER_COMPUTER"];
  const root = treeRootOf(a.folder, { cwd: deps.cwd ?? process.cwd(), home: deps.home ?? homedir(), ...(computer ? { computer } : {}) });
  if (!root.ok) {
    deps.error(root.message);
    return 1;
  }
  const on = computer ?? root.computer;
  if (!on) {
    deps.error("name the computer to run on with --computer <Name>");
    return 1;
  }
  const c = await deps.connect("cli-code");
  try {
    const r = (await c.request("agent.start", {
      backend: a.backend, computer: on, root: root.root,
      ...(a.model ? { model: a.model } : {}), ...(a.effort ? { effort: a.effort } : {}), ...(a.prompt ? { prompt: a.prompt } : {}),
    })) as { session?: string };
    deps.log(`Started coding session ${r.session ?? "?"} (${a.backend}) in ${root.root}.`);
    return 0;
  } catch (err) {
    deps.error(`clover code: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    c.close();
  }
}
