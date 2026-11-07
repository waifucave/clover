// verify:sealed-core — the compiled core runs only its own code (lane M's door audit, scripts/seal-bun-doors.ts).
//
// Runs the built `clover-core` with every door a Bun-compiled binary has — its environment, its arguments, its
// working folder — set to run a payload that writes a marker file, and fails if any marker appears, a debugger port
// opens or a debugger connects out. The doors that worked before the seal (BUN_BE_BUN, BUN_OPTIONS' preloads,
// BUN_INSPECT, BUN_INSPECT_CONNECT_TO, NODE_PATH and the working folder's node_modules on the runtime ladder) and
// the ones that never did (so a Bun upgrade that opens one fails here) are all checked. On macOS the binary is first
// signed the way a release signs it — hardened runtime, scripts/clover-core.entitlements — and DYLD_INSERT_LIBRARIES
// is checked against it. The byte check (`seal-bun-doors.ts --check`) runs first.
//
//   bun run verify:sealed-core                      build this machine's target (scripts/build-daemon.ts), then check
//   bun run verify:sealed-core --binary <path>      check an existing binary (signed already: add --signed)
//
// Nothing here starts a daemon or reads a secret store: every run is `--version`, `bridge` without its session, or
// `__runtimes-probe`, on a temp CLOVER_HOME and HOME, with no keychain involved.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { daemonOutput, hostTarget } from "./build-daemon";
import { sealProblems } from "./seal-bun-doors";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export interface Door {
  name: string;
  env?: Record<string, string>;
  args?: string[];
  /** Files to put in the working folder before the run (relative path → content). */
  cwdFiles?: Record<string, string>;
  /** What must hold: the default is "no marker"; `probe` checks `__runtimes-probe` resolved no planted runtime. */
  check?: "marker" | "probe";
  os?: NodeJS.Platform[];
}

/** Every door, as a run of the binary. `$PAYLOAD`, `$MARK`, `$NP` (a planted NODE_PATH), `$BUNFIG`, `$SOCK` and
 *  `$PORT` are filled in per run. */
export function doors(): Door[] {
  const write = `require("fs").writeFileSync(process.env.DOOR_MARK, "ran")`;
  return [
    { name: "BUN_BE_BUN=1 <script>", env: { BUN_BE_BUN: "1" }, args: ["$PAYLOAD"] },
    { name: "BUN_BE_BUN=1 -e", env: { BUN_BE_BUN: "1" }, args: ["-e", write] },
    { name: "BUN_OPTIONS=--preload", env: { BUN_OPTIONS: "--preload $PAYLOAD" } },
    { name: "BUN_OPTIONS=-r", env: { BUN_OPTIONS: "-r $PAYLOAD" } },
    { name: "BUN_OPTIONS=--require", env: { BUN_OPTIONS: "--require $PAYLOAD" } },
    { name: "BUN_OPTIONS=--import", env: { BUN_OPTIONS: "--import $PAYLOAD" } },
    { name: "BUN_OPTIONS=--config=<bunfig with a preload>", env: { BUN_OPTIONS: "--config=$BUNFIG" } },
    { name: "BUN_OPTIONS=--eval", env: { BUN_OPTIONS: `--eval ${write}` } },
    { name: "BUN_OPTIONS=-r with another command", env: { BUN_OPTIONS: "-r $PAYLOAD" }, args: ["bridge"] },
    { name: "NODE_OPTIONS=--require", env: { NODE_OPTIONS: "--require $PAYLOAD" } },
    { name: "NODE_OPTIONS=--import", env: { NODE_OPTIONS: "--import $PAYLOAD" } },
    { name: "BUN_CONFIG_FILE=<bunfig with a preload>", env: { BUN_CONFIG_FILE: "$BUNFIG" } },
    { name: "BUN_INSPECT_PRELOAD", env: { BUN_INSPECT_PRELOAD: "$PAYLOAD" } },
    { name: "argv --preload", args: ["--preload", "$PAYLOAD", "--version"] },
    { name: "argv -r", args: ["-r", "$PAYLOAD", "--version"] },
    { name: "argv -e", args: ["-e", write] },
    { name: "argv --eval", args: ["--eval", write] },
    { name: "argv <script>", args: ["$PAYLOAD"] },
    { name: "argv run <script>", args: ["run", "$PAYLOAD"] },
    { name: "working folder bunfig.toml preload", cwdFiles: { "bunfig.toml": `preload = ["./payload.js"]\n` } },
    { name: "working folder .env (BUN_OPTIONS, NODE_OPTIONS)", cwdFiles: { ".env": "BUN_OPTIONS=--preload ./payload.js\nNODE_OPTIONS=--require ./payload.js\nBUN_BE_BUN=1\n" } },
    { name: "working folder tsconfig.json and package.json", cwdFiles: { "tsconfig.json": `{"compilerOptions":{"paths":{"@waifucave/*":["./payload.js"]}}}`, "package.json": `{"name":"x","main":"payload.js","bun":{"preload":["./payload.js"]}}` } },
    { name: "NODE_PATH (the runtime ladder's package rung)", env: { NODE_PATH: "$NP" }, args: ["__runtimes-probe"], check: "probe" },
    { name: "working folder node_modules (the runtime ladder's package rung)", args: ["__runtimes-probe"], check: "probe", cwdFiles: { "node_modules": "$PLANT" } },
    { name: "CLOVER_RUNTIME_EXECUTABLE (dist ignores it)", env: { CLOVER_RUNTIME_EXECUTABLE: "$NP/@yanlinglabs/winter-agent-sdk-darwin-arm64/bin/winter" }, args: ["__runtimes-probe"], check: "probe" },
    { name: "DYLD_INSERT_LIBRARIES (hardened runtime)", env: { DYLD_INSERT_LIBRARIES: "$DYLIB" }, os: ["darwin"] },
  ];
}

interface Run { marker: boolean; timedOut: boolean; stdout: string; stderr: string; code: number | null }

function runBinary(binary: string, cwd: string, env: Record<string, string>, args: string[], timeoutMs = 10_000): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(binary, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", timedOut = false;
    child.stdout.on("data", (d) => { stdout += String(d); });
    child.stderr.on("data", (d) => { stderr += String(d); });
    const t = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.on("close", (code) => { clearTimeout(t); resolve({ marker: existsSync(env.DOOR_MARK!), timedOut, stdout, stderr, code }); });
  });
}

function baseEnv(home: string, mark: string): Record<string, string> {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: join(home, "h"), CLOVER_HOME: join(home, "home"), DOOR_MARK: mark };
  for (const k of ["SystemRoot", "windir", "TEMP", "TMP", "USERPROFILE"]) if (process.env[k] !== undefined) env[k] = process.env[k]!;
  if (process.platform === "win32") env.USERPROFILE = join(home, "h");
  return env;
}

async function listen(server: Server, at: string | number): Promise<void> {
  await new Promise<void>((res, rej) => { server.once("error", rej); server.listen(at as never, () => res()); });
}

/** Is anything listening on 127.0.0.1:port? */
function portOpen(port: number): Promise<boolean> {
  return new Promise((res) => {
    const s = createConnection({ host: "127.0.0.1", port });
    s.once("connect", () => { s.destroy(); res(true); });
    s.once("error", () => res(false));
    setTimeout(() => { s.destroy(); res(false); }, 1000);
  });
}

export async function verifySealedCore(binary: string, opts: { signed: boolean }): Promise<string[]> {
  const problems: string[] = [];
  const bytes = sealProblems(new Uint8Array(readFileSync(binary)));
  problems.push(...bytes.map((p) => `byte check: ${p}`));

  const work = mkdtempSync(join(tmpdir(), "clover-sealed-core-"));
  try {
    let bin = binary;
    let dylib = "";
    if (process.platform === "darwin") {
      if (!opts.signed) {
        bin = join(work, "clover-core");
        copyFileSync(binary, bin);
        const s = spawnSync("codesign", ["--force", "--sign", "-", "--options", "runtime", "--entitlements", join(ROOT, "scripts", "clover-core.entitlements"), bin], { encoding: "utf8" });
        if (s.status !== 0) return [...problems, `codesign (hardened runtime, ad hoc) failed: ${s.stderr.trim()}`];
      }
      const flags = spawnSync("codesign", ["-dv", bin], { encoding: "utf8" }).stderr;
      if (!/flags=0x[0-9a-f]+\([^)]*runtime/.test(flags)) problems.push("the binary is not signed with the hardened runtime");
      writeFileSync(join(work, "inj.c"), `#include <stdio.h>\n#include <stdlib.h>\n__attribute__((constructor)) static void hit(void) { const char *m = getenv("DOOR_MARK"); if (m) { FILE *f = fopen(m, "w"); if (f) { fputs("dylib", f); fclose(f); } } }\n`);
      dylib = join(work, "inj.dylib");
      const cc = spawnSync("clang", ["-dynamiclib", "-o", dylib, join(work, "inj.c")], { encoding: "utf8" });
      if (cc.status !== 0) problems.push(`clang could not build the DYLD probe: ${cc.stderr.trim()}`);
      else spawnSync("codesign", ["--force", "--sign", "-", dylib]);
    }
    const payload = join(work, "payload.js");
    writeFileSync(payload, `require("fs").writeFileSync(process.env.DOOR_MARK, "ran " + process.argv.join(" "));\n`);
    const bunfig = join(work, "preload-bunfig.toml");
    writeFileSync(bunfig, `preload = [${JSON.stringify(payload)}]\n`);
    // The planted runtime: a platform package with the pinned version and a bin/winter, for NODE_PATH and node_modules.
    const versions = readFileSync(join(ROOT, "packages", "core", "src", "runtime-sdk", "versions.ts"), "utf8");
    const pin = /CODING_AGENT_BINARY_VERSION = "([^"]+)"/.exec(versions)?.[1] ?? "0.0.0";
    const np = join(work, "np");
    const pkg = join(np, "@yanlinglabs", "winter-agent-sdk-darwin-arm64");
    mkdirSync(join(pkg, "bin"), { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@yanlinglabs/winter-agent-sdk-darwin-arm64", version: pin }));
    writeFileSync(join(pkg, "bin", "winter"), "#!/bin/sh\necho planted\n");
    chmodSync(join(pkg, "bin", "winter"), 0o755);

    // The marker works: plain Bun runs the payload (otherwise every "no" below would mean nothing).
    const controlMark = join(work, "control-mark");
    const control = spawnSync(process.execPath, [payload], { env: { ...process.env, DOOR_MARK: controlMark }, encoding: "utf8" });
    if (control.status !== 0 || !existsSync(controlMark)) problems.push("the control run (plain Bun running the payload) wrote no marker: the check itself is broken");

    let n = 0;
    const fresh = () => {
      const dir = join(work, `run-${++n}`);
      mkdirSync(join(dir, "cwd"), { recursive: true });
      mkdirSync(join(dir, "h"), { recursive: true });
      copyFileSync(payload, join(dir, "cwd", "payload.js"));
      return dir;
    };
    const fill = (s: string, mark: string) => s.replaceAll("$PAYLOAD", payload).replaceAll("$MARK", mark).replaceAll("$NP", np).replaceAll("$BUNFIG", bunfig).replaceAll("$DYLIB", dylib);

    // Baseline: the binary works at all, so a refusal below is never a crash passing for a closed door.
    {
      const dir = fresh();
      const r = await runBinary(bin, join(dir, "cwd"), baseEnv(dir, join(dir, "mark")), ["--version"]);
      if (r.code !== 0 || !/^clover \d/.test(r.stdout)) problems.push(`baseline: \`clover-core --version\` did not answer (exit ${r.code}): ${(r.stdout + r.stderr).trim().slice(0, 200)}`);
    }

    for (const door of doors()) {
      if (door.os !== undefined && !door.os.includes(process.platform)) continue;
      if (door.name.startsWith("DYLD") && dylib === "") continue;
      const dir = fresh();
      const cwd = join(dir, "cwd");
      const mark = join(dir, "mark");
      for (const [rel, content] of Object.entries(door.cwdFiles ?? {})) {
        if (content === "$PLANT") cpSync(np, join(cwd, rel), { recursive: true });
        else writeFileSync(join(cwd, rel), content);
      }
      const env = baseEnv(dir, mark);
      for (const [k, v] of Object.entries(door.env ?? {})) env[k] = fill(v, mark);
      const args = (door.args ?? ["--version"]).map((a) => fill(a, mark));
      const r = await runBinary(bin, cwd, env, args);
      const before = problems.length;
      if (r.marker) problems.push(`${door.name}: FOREIGN CODE RAN (${readFileSync(mark, "utf8").slice(0, 80)})`);
      if (r.timedOut) problems.push(`${door.name}: the binary did not exit (a debugger waiting?)`);
      if (door.check === "probe") {
        if (r.stdout.includes('"source":"platform-package"') || r.stdout.includes('"source":"env"')) problems.push(`${door.name}: the runtime ladder resolved a planted runtime: ${r.stdout.trim().slice(0, 300)}`);
      }
      console.log(`verify:sealed-core: ${problems.length > before ? "OPEN  " : "closed"} ${door.name}`);
    }

    // The debugger: BUN_INSPECT with wait must neither block nor open its port; CONNECT_TO must not connect out.
    {
      const dir = fresh();
      const port = 47_000 + Math.floor(Math.random() * 2000);
      const env = { ...baseEnv(dir, join(dir, "mark")), BUN_INSPECT: `ws://127.0.0.1:${port}/sealed?wait=1` };
      const pending = runBinary(bin, join(dir, "cwd"), env, ["--version"], 6000);
      await new Promise((r) => setTimeout(r, 1500));
      const open = await portOpen(port);
      const r = await pending;
      if (open || r.timedOut) problems.push(`BUN_INSPECT: a debugger ${open ? "port opened" : "held the process"}`);
      console.log(`verify:sealed-core: ${open || r.timedOut ? "OPEN  " : "closed"} BUN_INSPECT=ws://…?wait=1`);
    }
    if (process.platform !== "win32") {
      const dir = fresh();
      const sock = join(dir, "i.sock");
      let connected = false;
      const server = createServer((s) => { connected = true; s.destroy(); });
      await listen(server, sock);
      const r = await runBinary(bin, join(dir, "cwd"), { ...baseEnv(dir, join(dir, "mark")), BUN_INSPECT_CONNECT_TO: `unix://${sock}` }, ["--version"], 6000);
      await new Promise((res) => setTimeout(res, 300));
      server.close();
      if (connected || r.timedOut) problems.push("BUN_INSPECT_CONNECT_TO: the binary connected a debugger out");
      console.log(`verify:sealed-core: ${connected ? "OPEN  " : "closed"} BUN_INSPECT_CONNECT_TO=unix://…`);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return problems;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const at = argv.indexOf("--binary");
  let binary = at === -1 ? undefined : argv[at + 1];
  if (binary === undefined) {
    const target = hostTarget();
    if (target === undefined) {
      console.error("verify:sealed-core: no daemon target for this machine");
      process.exit(1);
    }
    const built = spawnSync(process.execPath, ["scripts/build-daemon.ts", "--target", target], { cwd: ROOT, stdio: "inherit" });
    if (built.status !== 0) process.exit(1);
    binary = join(ROOT, daemonOutput(target));
  }
  const problems = await verifySealedCore(binary, { signed: argv.includes("--signed") });
  for (const p of problems) console.error(`verify:sealed-core: ${p}`);
  console.log(problems.length === 0 ? "verify:sealed-core: ok — the compiled core runs only its own code" : `verify:sealed-core: ${problems.length} problem(s)`);
  process.exit(problems.length === 0 ? 0 : 1);
}
