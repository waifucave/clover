// Clover's hook shim (spec §9.3 "Hooks", §5.3 "What each event may return"): a plugin's command hook, placed in
// Claude Code's own settings for Claude Code's own tools, runs through this, never directly. The shim runs the hook
// with Claude Code's input on stdin and passes its answer on, except that **an allow is dropped**: `tool.before` may
// deny, ask or replace the input, never allow, so a plugin can't approve its way past Clover's levels and cards.
//
// * Exit code 2 (Claude Code's "block") passes through with its stderr: a deny.
// * JSON output passes only an allow-list of keys (`dropAllow`): deny and ask decisions, `updatedInput`,
//   `additionalContext`, `continue`, `stopReason`, `suppressOutput`, `systemMessage`. Every allow is gone, and output
//   that starts like JSON but isn't one whole object is dropped.
// * A hook that runs past its limit (default 10 seconds, §5.3) or fails to start is skipped: the shim exits 0 with
//   nothing, as if the hook weren't there, and says why on stderr.
//
// `clover-core hook-shim --timeout <ms> -- <command> [args…]` in the shipped binary; `bun hook-shim.ts …` from source.
import { spawn } from "node:child_process";
import { join } from "node:path";
import { AgentJob } from "../../platform/win-job";
import { isCompiled } from "../bridge/main";
import { spawnPlan } from "../process/launch";

export const HOOK_SHIM_PATH = join(import.meta.dir, "hook-shim.ts");
export const DEFAULT_HOOK_TIMEOUT_MS = 10_000;

/** How Claude Code starts the shim: this daemon's binary, or bun with this file from source. */
export function hookShimCommand(): { command: string; args: string[] } {
  return isCompiled() ? { command: process.execPath, args: ["hook-shim"] } : { command: process.execPath, args: [HOOK_SHIM_PATH] };
}

/** A hook's answer with any allow taken out, failing closed (K-M2 review 3). Text that doesn't start like JSON passes
 *  as text (Claude Code reads it as text, and text can't approve). Anything that starts like JSON must be one object
 *  and parse whole, or it's dropped; of an object only these keys pass: `continue`, `stopReason`, `suppressOutput`,
 *  `systemMessage`, `decision: "block"` with its `reason`, and in `hookSpecificOutput` the event's name,
 *  `permissionDecision: "deny" | "ask"` with its reason, `updatedInput`, `additionalContext`, and a permission
 *  request's `decision` only when it denies. */
export function dropAllow(stdout: string): string {
  const text = stdout.trim();
  if (text === "") return "";
  if (!text.startsWith("{") && !text.startsWith("[")) return stdout;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return "";
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "";
  const src = parsed as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const isStr = (v: unknown): v is string => typeof v === "string";
  if (typeof src["continue"] === "boolean") out["continue"] = src["continue"];
  if (isStr(src["stopReason"])) out["stopReason"] = src["stopReason"];
  if (typeof src["suppressOutput"] === "boolean") out["suppressOutput"] = src["suppressOutput"];
  if (isStr(src["systemMessage"])) out["systemMessage"] = src["systemMessage"];
  if (src["decision"] === "block") {
    out["decision"] = "block";
    if (isStr(src["reason"])) out["reason"] = src["reason"];
  }
  const specific = src["hookSpecificOutput"];
  if (specific && typeof specific === "object" && !Array.isArray(specific)) {
    const sp = specific as Record<string, unknown>;
    const o: Record<string, unknown> = {};
    if (isStr(sp["hookEventName"])) o["hookEventName"] = sp["hookEventName"];
    if (sp["permissionDecision"] === "deny" || sp["permissionDecision"] === "ask") {
      o["permissionDecision"] = sp["permissionDecision"];
      if (isStr(sp["permissionDecisionReason"])) o["permissionDecisionReason"] = sp["permissionDecisionReason"];
    }
    const input = sp["updatedInput"];
    if (input && typeof input === "object" && !Array.isArray(input)) o["updatedInput"] = input;
    if (isStr(sp["additionalContext"])) o["additionalContext"] = sp["additionalContext"];
    const d = sp["decision"];
    if (d && typeof d === "object" && !Array.isArray(d) && (d as Record<string, unknown>)["behavior"] === "deny") {
      const dd = d as Record<string, unknown>;
      o["decision"] = { behavior: "deny", ...(isStr(dd["message"]) ? { message: dd["message"] } : {}) };
    }
    if (Object.keys(o).length > 0) out["hookSpecificOutput"] = o;
  }
  return Object.keys(out).length === 0 ? "" : `${JSON.stringify(out)}\n`;
}

export interface ShimResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs one hook through the shim's rules. */
export function runHook(command: string, args: readonly string[], input: string, timeoutMs = DEFAULT_HOOK_TIMEOUT_MS, env: NodeJS.ProcessEnv = process.env): Promise<ShimResult> {
  return new Promise((resolve) => {
    let child;
    const posix = process.platform !== "win32";
    // Its own process group (a job object on Windows), so a timeout ends whatever the hook started too (K-M2 review 8).
    const job = posix ? null : AgentJob.create();
    try {
      const plan = spawnPlan(command, args);
      child = spawn(plan.file, plan.args, { stdio: ["pipe", "pipe", "pipe"], env, windowsHide: true, detached: posix, windowsVerbatimArguments: plan.verbatim });
      if (job && child.pid) job.assign(child.pid);
    } catch (err) {
      resolve({ code: 0, stdout: "", stderr: `clover hook shim: the hook didn't start (${err instanceof Error ? err.message : String(err)}); skipped\n` });
      return;
    }
    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (r: ShimResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      job?.close();
      resolve(r);
    };
    const killAll = () => {
      try {
        if (posix && child.pid) process.kill(-child.pid, "SIGKILL");
        else if (job) job.terminate(1);
        else child.kill("SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(() => {
      killAll();
      finish({ code: 0, stdout: "", stderr: `clover hook shim: the hook ran past ${timeoutMs} ms; skipped\n` });
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => {
      if (stdout.length < 1_000_000) stdout += c;
    });
    child.stderr.on("data", (c: string) => {
      if (stderr.length < 100_000) stderr += c;
    });
    child.on("error", (err) => finish({ code: 0, stdout: "", stderr: `clover hook shim: the hook didn't start (${err.message}); skipped\n` }));
    child.on("close", (code) => {
      // Exit 2 is Claude Code's block: a deny, passed on with its reason. Any other failure skips the hook.
      if (code === 2) finish({ code: 2, stdout: "", stderr });
      else if (code === 0) finish({ code: 0, stdout: dropAllow(stdout), stderr });
      else finish({ code: 0, stdout: "", stderr: `clover hook shim: the hook exited ${code}; skipped\n${stderr}` });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

/** Parses `--timeout <ms> -- <command> [args…]`. */
export function parseShimArgs(argv: readonly string[]): { timeoutMs: number; command: string; args: string[] } | null {
  const sep = argv.indexOf("--");
  if (sep < 0 || sep === argv.length - 1) return null;
  const opts = argv.slice(0, sep);
  const t = opts.indexOf("--timeout");
  const timeoutMs = t >= 0 ? Number(opts[t + 1]) : DEFAULT_HOOK_TIMEOUT_MS;
  return { timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_HOOK_TIMEOUT_MS, command: argv[sep + 1]!, args: argv.slice(sep + 2) };
}

export async function hookShimMain(argv: readonly string[]): Promise<number> {
  const parsed = parseShimArgs(argv);
  if (!parsed) {
    process.stderr.write("clover hook shim: usage: hook-shim [--timeout <ms>] -- <command> [args…]\n");
    return 0;
  }
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  const r = await runHook(parsed.command, parsed.args, Buffer.concat(chunks).toString("utf8"), parsed.timeoutMs);
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  return r.code;
}

if (import.meta.main) process.exit(await hookShimMain(process.argv.slice(2)));
