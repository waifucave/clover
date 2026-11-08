// The live gates for the sandbox writers (writers.ts), for the owner's live-gate batch: S8's no-model probes
// (`spikes/s8-secrets/agent-floor-gates.py`) adapted to Clover's real fenced set. A fixture home is laid out with the
// fenced items as `CloverFence` names them, the agent's policy is built as the manager builds it
// (`withHomeDenied(agentPolicyOf(fence.policy()))`), the writer turns it into the vendor's settings, and shell probes
// run through the vendor's sandbox-only entry point with exactly those settings. No model is called.
//
//   bun live-gates.ts print [--keep]        the fixture's policy, Codex's CODEX_CONFIG and sandbox argv, Claude
//                                           Code's `_meta`, and the probes (nothing is run); `--keep` leaves the
//                                           fixture in place for the adapters' gates (remove it after)
//   bun live-gates.ts codex [--user-codex-home]
//                                           `codex sandbox -P clover` with the writer's profile as `-c` overrides;
//                                           by default under a fresh CODEX_HOME, with the flag under the user's own
//                                           (their config stack in place, read only)
//   bun live-gates.ts srt --cli <sandbox-runtime cli.js>
//                                           Claude Code's sandbox runtime with the writer's `sandbox.filesystem`
//
// One JSON line per probe (`pass`, exit code, whether the fixture's fenced files are unchanged); the exit code is 1 if
// any probe failed. The fixture is removed at the end. These cover the sandboxes' shell layer only: the adapters'
// layer (codex-acp's CODEX_CONFIG, claude-agent-acp's `_meta`) needs a model turn, and its checklist is in the PR that
// added this file.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Os } from "@waifucave/clover-protocol";
import type { SandboxPolicy } from "../../contracts/fence";
import { CloverFence } from "../../fence/fence";
import { agentPolicyOf, withHomeDenied } from "../memory";
import { CODEX_PROFILE, claudeCodeOptions, codexProfile, codexWriter, literalDenials } from "./writers";

export interface GateFixture {
  root: string;
  home: string;
  cloverHome: string;
  temp: string;
  /** The agent's root folder. */
  work: string;
  dev: string;
  policy: SandboxPolicy;
  /** Each fenced file the probes aim at, with its content, to check the host is unchanged after them. */
  planted: Map<string, string>;
}

const FIXTURE = "public fixture";

/** A fixture home with Clover's fenced items, and the agent's policy for it. */
export function gateFixture(base = tmpdir(), os: Os = osNow()): GateFixture {
  const root = realpathSync(mkdtempSync(join(base, "clover-gates-")));
  const home = join(root, "home"), cloverHome = join(home, ".clover"), temp = join(root, "tmp"), work = join(home, "work"), dev = join(home, "dev-plugin");
  for (const d of [home, cloverHome, temp, work, dev]) mkdirSync(d, { recursive: true });
  const fence = new CloverFence({ os, home, cloverHome, temp, devFolders: [dev], bots: ["alpha"] });
  const policy = withHomeDenied(agentPolicyOf(fence.policy()), cloverHome);
  const planted = new Map<string, string>();
  const plant = (path: string) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, FIXTURE);
    planted.set(path, FIXTURE);
  };
  // One file inside every literal fenced folder (or the file itself), each bot's memory, and the runtime state.
  for (const item of fence.fencedSet()) {
    if (!item.path.startsWith(root)) continue;
    plant(/\.(json|enc|key|plist|service)$/.test(item.path) ? item.path : join(item.path, "probe.txt"));
  }
  plant(join(cloverHome, "credentials", "token"));
  plant(join(cloverHome, "run", "moveme"));
  plant(join(cloverHome, "bots", "beta", "memory", "notes.md")); // a bot the fence doesn't name: the pattern holds it
  plant(join(cloverHome, "sessions-runtime", "s1", "state.json"));
  plant(join(dev, "clover.json"));
  symlinkSync(cloverHome, join(work, "alias"));
  symlinkSync(dev, join(work, "devalias"));
  return { root, home, cloverHome, temp, work, dev, policy, planted };
}

export interface GateProbe {
  name: string;
  /** A `/bin/sh -c` script. */
  sh: string;
  /** `ok`: must succeed; `refused`: must fail, with the fixture unchanged. */
  expect: "ok" | "refused";
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The probes for a fixture: the allowed writes, then every planted file's read or write as the policy denies it, the
 *  alias and link escapes, nested retries, the closed doors and the network; the move last (it changes the fixture). */
export function gateProbes(f: GateFixture, o: { os?: Os; doors?: boolean; network?: boolean } = {}): GateProbe[] {
  const os = o.os ?? osNow();
  const { denyRead, denyWrite } = literalDenials(f.policy);
  const under = (list: string[], p: string) => list.some((d) => p === d || p.startsWith(`${d}/`));
  const token = join(f.cloverHome, "credentials", "token");
  const probes: GateProbe[] = [
    { name: "write the root", sh: `echo ok > ${q(join(f.work, "ok"))}`, expect: "ok" },
    { name: "read the root", sh: `echo ok > ${q(join(f.work, "ok2"))} && cat ${q(join(f.work, "ok2"))}`, expect: "ok" },
    { name: "write temp", sh: `echo ok > ${q(join(f.temp, "ok"))}`, expect: "ok" },
  ];
  for (const path of [...f.planted.keys()].sort()) {
    const rel = path.slice(f.root.length);
    if (under(denyRead, path)) probes.push({ name: `read ${rel}`, sh: `cat ${q(path)}`, expect: "refused" });
    if (under(denyWrite, path) || under(denyRead, path)) {
      probes.push({ name: `write ${rel}`, sh: `echo changed >> ${q(path)}`, expect: "refused" });
      probes.push({ name: `create beside ${rel}`, sh: `echo new > ${q(join(dirname(path), "new-file"))}`, expect: "refused" });
    }
  }
  probes.push(
    { name: "read through a link in the root", sh: `cat ${q(join(f.work, "alias", "credentials", "token"))}`, expect: "refused" },
    { name: "write a dev folder through a link", sh: `echo new > ${q(join(f.work, "devalias", "new-file"))}`, expect: "refused" },
    { name: "a new symlink to a secret, read", sh: `ln -s ${q(token)} ${q(join(f.work, "sl"))}; cat ${q(join(f.work, "sl"))}`, expect: "refused" },
    { name: "a hard link to a secret", sh: `ln ${q(token)} ${q(join(f.work, "hl"))}`, expect: "refused" },
    { name: "a nested shell retries the read", sh: `/bin/sh -c 'cat "$1"' retry ${q(token)}`, expect: "refused" },
    { name: "a clean environment retries the read", sh: `env -i /bin/cat ${q(token)}`, expect: "refused" },
    { name: "a background child reads after its parent exits", sh: `( sleep 1; cat ${q(token)} > ${q(join(f.work, "leak"))} ) & wait; test -s ${q(join(f.work, "leak"))}`, expect: "refused" },
  );
  if (o.doors !== false) {
    // Read-only, windowless commands that work only where the door is open (`open` itself would show a window).
    if (os === "macos") {
      probes.push({ name: "launchctl", sh: `launchctl print gui/$(id -u) > /dev/null`, expect: "refused" });
      probes.push({ name: "osascript", sh: `osascript -e 'return 1' > /dev/null`, expect: "refused" });
    } else if (os === "linux") {
      probes.push({ name: "systemd-run --user", sh: `systemd-run --user --wait --quiet true`, expect: "refused" });
    }
  }
  if (o.network !== false) probes.push({ name: "the network", sh: `curl -sS -m 5 -o /dev/null https://example.com`, expect: "refused" });
  probes.push({ name: "move a fenced file out", sh: `mv ${q(join(f.cloverHome, "run", "moveme"))} ${q(join(f.work, "moved"))}`, expect: "refused" });
  return probes;
}

/** Whether every planted file is as it was, and nothing was linked or moved out. */
export function fixtureUnchanged(f: GateFixture): boolean {
  for (const [path, content] of f.planted) {
    try {
      if (readFileSync(path, "utf8") !== content) return false;
      if (statSync(path).nlink !== 1) return false;
    } catch {
      return false;
    }
  }
  for (const [path] of f.planted) if (existsSync(join(dirname(path), "new-file"))) return false;
  return !existsSync(join(f.work, "moved")) && !existsSync(join(f.work, "leak"));
}

/** A TOML inline table of string keys and values (JSON's string escapes are TOML's basic strings'). */
export function tomlInline(map: Record<string, string>): string {
  return `{ ${Object.entries(map).map(([k, v]) => `${JSON.stringify(k)} = ${JSON.stringify(v)}`).join(", ")} }`;
}

/** `codex sandbox` with the writer's profile, as `-c` overrides on top of whatever config stack CODEX_HOME holds. */
export function codexSandboxArgv(f: GateFixture): string[] {
  const p = codexProfile(f.policy, f.work);
  return [
    "codex", "sandbox", "-C", f.work, "-P", CODEX_PROFILE,
    "-c", `default_permissions=${JSON.stringify(CODEX_PROFILE)}`,
    "-c", `permissions.${CODEX_PROFILE}.filesystem=${tomlInline(p.filesystem)}`,
    "-c", `permissions.${CODEX_PROFILE}.network.enabled=false`,
    "--",
  ];
}

/** Claude Code's sandbox runtime settings from the writer's `sandbox` (what Claude Code's Bash runs under). */
export function srtSettings(f: GateFixture): Record<string, unknown> {
  const s = claudeCodeOptions(f.policy, f.work)["sandbox"] as { filesystem: Record<string, string[]> };
  return { filesystem: s.filesystem, network: { allowedDomains: [], deniedDomains: [] } };
}

export interface ProbeResult { name: string; expect: GateProbe["expect"]; pass: boolean; exit: number | null; hostUnchanged: boolean; diagnostic: string }

/** Runs the probes under `prefix` (empty: unsandboxed, which every `refused` probe must fail, to show it means something). */
export function runProbes(f: GateFixture, probes: GateProbe[], prefix: string[], env: Record<string, string>): ProbeResult[] {
  const out: ProbeResult[] = [];
  for (const p of probes) {
    const argv = [...prefix, "/bin/sh", "-c", p.sh];
    const r = spawnSync(argv[0]!, argv.slice(1), { cwd: f.work, env, encoding: "utf8", timeout: 30_000 });
    const hostUnchanged = fixtureUnchanged(f);
    const exit = r.status;
    const pass = p.expect === "ok" ? exit === 0 : exit !== 0 && hostUnchanged;
    out.push({ name: p.name, expect: p.expect, pass, exit, hostUnchanged, diagnostic: `${r.stderr ?? ""}${r.error ? String(r.error) : ""}`.replaceAll(f.root, "<fixture>").slice(0, 300) });
  }
  return out;
}

function osNow(): Os {
  return process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux";
}

function main(argv: string[]): number {
  const mode = argv[0];
  const f = gateFixture();
  let keep = false;
  try {
    const env: Record<string, string> = { HOME: f.home, PATH: process.env["PATH"] ?? "/usr/bin:/bin", TMPDIR: f.temp, DO_NOT_TRACK: "1" };
    if (mode === "print") {
      const { env: codexEnv } = codexWriter(f.policy, { root: f.work, dir: join(f.root, "setup") });
      console.log(JSON.stringify({
        fixture: f.root, policy: f.policy, codex: { CODEX_CONFIG: codexEnv!["CODEX_CONFIG"], sandboxArgv: codexSandboxArgv(f) },
        claudeCode: { meta: { claudeCode: { options: claudeCodeOptions(f.policy, f.work) } }, srtSettings: srtSettings(f) },
        probes: gateProbes(f).map((p) => `${p.expect}: ${p.name}`),
      }, null, 2));
      keep = argv.includes("--keep");
      return 0;
    }
    let prefix: string[];
    if (mode === "codex") {
      prefix = codexSandboxArgv(f);
      if (argv.includes("--user-codex-home")) {
        if (process.env["CODEX_HOME"]) env["CODEX_HOME"] = process.env["CODEX_HOME"];
        else env["CODEX_HOME"] = join(process.env["HOME"] ?? "", ".codex");
      } else {
        env["CODEX_HOME"] = join(f.root, "codex-home");
        mkdirSync(env["CODEX_HOME"], { recursive: true });
      }
    } else if (mode === "srt") {
      const cli = argv[argv.indexOf("--cli") + 1];
      if (!argv.includes("--cli") || !cli || !existsSync(cli)) {
        console.error("srt needs --cli <path to @anthropic-ai/sandbox-runtime's dist/cli.js>");
        return 2;
      }
      const file = join(f.root, "srt-settings.json");
      writeFileSync(file, JSON.stringify(srtSettings(f)));
      prefix = ["node", cli, "--settings", file, "--"];
    } else {
      console.error("usage: bun live-gates.ts print [--keep] | codex [--user-codex-home] | srt --cli <cli.js>");
      return 2;
    }
    let failed = false;
    for (const r of runProbes(f, gateProbes(f), prefix, env)) {
      console.log(JSON.stringify({ backend: mode, ...r }));
      failed ||= !r.pass;
    }
    return failed ? 1 : 0;
  } finally {
    if (!keep) rmSync(f.root, { recursive: true, force: true });
  }
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));

