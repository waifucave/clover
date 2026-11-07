// verify:sealed-core — the compiled core runs only its own code, and its environment can't make it leak a key
// (lane M's door audit, scripts/seal-bun-doors.ts).
//
// Runs the built `clover-core` with every door a Bun-compiled binary has — its environment, its arguments, its
// working folder — and fails unless, for each one:
//   - a payload that writes a marker file never ran;
//   - the core STAYED ITSELF: with the door set, `--version` still prints `clover <version>` (a binary that became
//     plain Bun writes no marker for a door that is only half the attack, so a missing marker alone proves nothing);
//   - no debugger port opened and no debugger connected out;
//   - a request the core makes with a dummy key (`__fetch-probe`) never shows that key on stdout or stderr
//     (BUN_CONFIG_VERBOSE_FETCH printed request headers, keys included).
// The doors are the audit's list, `=`-led entries through a raw execve (macOS and Linux: Darwin's `getenv` matched an
// empty name to the first `=…` entry), the seal's own replacements, the TLS trust variables (a release refuses to
// start with them), and a SWEEP of every `BUN_*` and `NODE_*` name the binary's code contains outside the module graph,
// each set to `1`, `*`, `--preload=<payload>` and `<payload>`, so a variable a future Bun adds is tried too.
//
// macOS: the binary is signed as a release signs it — hardened runtime, scripts/clover-core.entitlements — and the
// gate asserts the hardened runtime and that no `allow-dyld-environment-variables` entitlement is there (the macOS
// seal is `DYLD_*` names, which dyld removes only from a hardened process). DYLD_INSERT_LIBRARIES is tried too.
// Windows: the binary must NOT be sealed (seal-bun-doors.ts says why); Bun's own variables are open there by design
// and are not tried, the rest (the ladder, TLS, the working folder, argv, the key) is.
// TLS trust: a self-signed certificate is refused (main thread and Worker); the OS store is trusted (`--use-system-ca`,
// baked in by build-daemon): on macOS through a CA only the OS holds (Apple's root, gdmf.apple.com), on Linux runners
// through a throwaway CA added to the OS store with sudo and removed afterwards. Each TLS variable refuses the start
// set alone and as a duplicate entry, first and last (native code reads the first, JS the last).
// HOME: every run has none (macOS then takes the account's home from the password database); a planted HOME must be
// refused on macOS (startup-guard.ts: HOME chooses the keychains and trust settings).
// `__fetch-probe` refuses any URL but loopback and the one Apple URL, and any key but 32 hex characters, and never
// follows a redirect (a local 302 to a second listener must reach nothing).
// A door that could not run at all (the binary missing, the raw helper's execve failing) is an ERROR, never "closed"
// or "OPEN", and any ERROR fails the gate.
//
//   bun run verify:sealed-core                      build this machine's target (scripts/build-daemon.ts), then check
//   bun run verify:sealed-core --binary <path>      check an existing binary (signed already: add --signed)
//   … --no-sweep                                    skip the sweep (a quicker local run)
//
// Nothing here starts a daemon or reads a secret store: every run is `--version`, `bridge` without its session,
// `__runtimes-probe` or `__fetch-probe` to a local server (or Apple's), on a temp CLOVER_HOME and no HOME, with no
// keychain involved.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createConnection, createServer, type Server } from "node:net";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { daemonOutput, hostTarget } from "./build-daemon";
import { TLS_TRUST_ENV } from "../packages/core/src/build-kind";
import { accountHome } from "../packages/core/src/startup-guard";
import { DYLD_ENTITLEMENT, moduleGraphRange, SEALED_ENV_NAMES, sealedReplacement, sealFiller, sealProblems, sealsFormat } from "./seal-bun-doors";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = readFileSync(join(ROOT, "VERSION"), "utf8").trim();

export interface Door {
  name: string;
  env?: Record<string, string>;
  /** Raw environment entries, passed through execve exactly (`=…` among them). macOS and Linux only. */
  raw?: string[];
  args?: string[];
  /** Files to put in the working folder before the run (relative path → content). */
  cwdFiles?: Record<string, string>;
  /** `probe`: `__runtimes-probe` must resolve no planted runtime. */
  check?: "probe";
  /** False for an argv door: there is no `--version` run with the same door. */
  stayItself?: boolean;
  /** Bun's own variables, open on Windows by design (not sealed there). */
  bunEnv?: boolean;
  os?: NodeJS.Platform[];
}

/** Every named door. `$PAYLOAD`, `$NP` (a planted NODE_PATH), `$BUNFIG` and `$DYLIB` are filled in per run. */
export function doors(): Door[] {
  const write = `require("fs").writeFileSync(process.env.DOOR_MARK, "ran")`;
  const posix: NodeJS.Platform[] = ["darwin", "linux"];
  const out: Door[] = [
    { name: "BUN_BE_BUN=1 <script>", env: { BUN_BE_BUN: "1" }, args: ["$PAYLOAD"], bunEnv: true },
    { name: "BUN_BE_BUN=1 -e", env: { BUN_BE_BUN: "1" }, args: ["-e", write], bunEnv: true },
    { name: "BUN_OPTIONS=--preload", env: { BUN_OPTIONS: "--preload $PAYLOAD" }, bunEnv: true },
    { name: "BUN_OPTIONS=-r", env: { BUN_OPTIONS: "-r $PAYLOAD" }, bunEnv: true },
    { name: "BUN_OPTIONS=--require", env: { BUN_OPTIONS: "--require $PAYLOAD" }, bunEnv: true },
    { name: "BUN_OPTIONS=--import", env: { BUN_OPTIONS: "--import $PAYLOAD" }, bunEnv: true },
    { name: "BUN_OPTIONS=--config=<bunfig with a preload>", env: { BUN_OPTIONS: "--config=$BUNFIG" }, bunEnv: true },
    { name: "BUN_OPTIONS=--eval", env: { BUN_OPTIONS: `--eval ${write}` }, bunEnv: true },
    { name: "BUN_OPTIONS=-r with another command", env: { BUN_OPTIONS: "-r $PAYLOAD" }, args: ["bridge"], bunEnv: true },
    { name: "NODE_OPTIONS=--require", env: { NODE_OPTIONS: "--require $PAYLOAD" } },
    { name: "NODE_OPTIONS=--import", env: { NODE_OPTIONS: "--import $PAYLOAD" } },
    { name: "BUN_CONFIG_FILE=<bunfig with a preload>", env: { BUN_CONFIG_FILE: "$BUNFIG" }, bunEnv: true },
    { name: "BUN_INSPECT_PRELOAD", env: { BUN_INSPECT_PRELOAD: "$PAYLOAD" }, bunEnv: true },
    { name: "argv --preload", args: ["--preload", "$PAYLOAD", "--version"], stayItself: false },
    { name: "argv -r", args: ["-r", "$PAYLOAD", "--version"], stayItself: false },
    { name: "argv -e", args: ["-e", write], stayItself: false },
    { name: "argv --eval", args: ["--eval", write], stayItself: false },
    { name: "argv <script>", args: ["$PAYLOAD"], stayItself: false },
    { name: "argv run <script>", args: ["run", "$PAYLOAD"], stayItself: false },
    { name: "working folder bunfig.toml preload", cwdFiles: { "bunfig.toml": `preload = ["./payload.js"]\n` } },
    { name: "working folder .env (BUN_OPTIONS, NODE_OPTIONS, BUN_BE_BUN)", cwdFiles: { ".env": "BUN_OPTIONS=--preload ./payload.js\nNODE_OPTIONS=--require ./payload.js\nBUN_BE_BUN=1\n" } },
    { name: "working folder tsconfig.json and package.json", cwdFiles: { "tsconfig.json": `{"compilerOptions":{"paths":{"@waifucave/*":["./payload.js"]}}}`, "package.json": `{"name":"x","main":"payload.js","bun":{"preload":["./payload.js"]}}` } },
    { name: "NODE_PATH (the runtime ladder's package rung)", env: { NODE_PATH: "$NP" }, args: ["__runtimes-probe"], check: "probe" },
    { name: "working folder node_modules (the runtime ladder's package rung)", args: ["__runtimes-probe"], check: "probe", cwdFiles: { "node_modules": "$PLANT" } },
    { name: "CLOVER_RUNTIME_EXECUTABLE (dist ignores it)", env: { CLOVER_RUNTIME_EXECUTABLE: "$NP/@yanlinglabs/winter-agent-sdk-darwin-arm64/bin/winter" }, args: ["__runtimes-probe"], check: "probe" },
    { name: "DYLD_INSERT_LIBRARIES (hardened runtime)", env: { DYLD_INSERT_LIBRARIES: "$DYLIB" }, os: ["darwin"] },
    { name: "HTTPS_PROXY (allowed)", env: { HTTPS_PROXY: "http://127.0.0.1:9", HTTP_PROXY: "http://127.0.0.1:9" } },
    // An empty variable name: Darwin's getenv matched one to every name a NUL-led seal made empty.
    { name: `env {"": <payload>}`, env: { "": "$PAYLOAD" }, os: posix, bunEnv: true },
    { name: `env {"": --preload <payload>}`, env: { "": "--preload $PAYLOAD" }, os: posix, bunEnv: true },
    { name: `env {"": 1} <script>`, env: { "": "1" }, args: ["$PAYLOAD"], os: posix, bunEnv: true },
    { name: "raw =<payload>", raw: ["=$PAYLOAD"], os: posix, bunEnv: true },
    { name: "raw =--preload=<payload> <script>", raw: ["=--preload=$PAYLOAD"], args: ["$PAYLOAD"], os: posix, bunEnv: true },
    { name: "raw =1 <script>", raw: ["=1"], args: ["$PAYLOAD"], os: posix, bunEnv: true },
    { name: "raw =x", raw: ["=x"], os: posix, bunEnv: true },
    { name: "raw DYLD_=1 <script>", raw: ["DYLD_=1"], args: ["$PAYLOAD"], os: ["darwin"], bunEnv: true },
  ];
  // The seal's own replacements, read out of the binary: on macOS the whole DYLD_ name, on Linux the visible letters.
  for (const name of SEALED_ENV_NAMES) {
    const value = name === "BUN_BE_BUN" ? "1" : name === "BUN_CONFIG_VERBOSE_FETCH" ? "curl" : name.startsWith("BUN_INSPECT") ? "ws://127.0.0.1:47999/sealed?wait=1" : "--preload=$PAYLOAD";
    const args = name === "BUN_BE_BUN" ? ["$PAYLOAD"] : undefined;
    const dyld = new TextDecoder().decode(sealedReplacement(name, "native", "macho").bytes);
    out.push({ name: `${name}'s macOS replacement ${dyld}`, raw: [`${dyld}=${value}`], ...(args ? { args } : {}), os: ["darwin"], bunEnv: true });
    out.push({ name: `${name}'s Linux replacement's letters`, env: { [sealFiller(name, name.length - 1)]: value }, ...(args ? { args } : {}), os: ["linux"], bunEnv: true });
  }
  return out;
}

/** The environments a release must refuse to start with (exit 78): each TLS variable alone, and as a duplicate entry
 *  with the refused value first and last (raw, macOS and Linux); on macOS a planted HOME. `$CA` is a file. */
export function refusalDoors(): Door[] {
  const posix: NodeJS.Platform[] = ["darwin", "linux"];
  const out: Door[] = [];
  for (const name of TLS_TRUST_ENV) {
    const bad = name === "NODE_TLS_REJECT_UNAUTHORIZED" ? "0" : name === "SSL_CERT_DIR" ? "$CADIR" : "$CA";
    const harmless = name === "NODE_TLS_REJECT_UNAUTHORIZED" ? "1" : "";
    out.push({ name: `${name}=${bad === "0" ? "0" : "<set>"}`, env: { [name]: bad } });
    if (harmless === "") out.push({ name: `${name}= (empty)`, env: { [name]: "" } });
    out.push({ name: `raw ${name} twice, the refused value first`, raw: [`${name}=${bad}`, `${name}=${harmless}`], os: posix });
    out.push({ name: `raw ${name} twice, the refused value last`, raw: [`${name}=${harmless}`, `${name}=${bad}`], os: posix });
  }
  out.push({ name: "HOME=<a planted home>", env: { HOME: "$PLANTED_HOME" }, os: ["darwin"] });
  return out;
}

interface Run { marker: boolean; timedOut: boolean; stdout: string; stderr: string; code: number | null; error?: string }

function runBinary(file: string, args: string[], cwd: string, env: Record<string, string>, mark: string, timeoutMs = 10_000): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", timedOut = false;
    let error: string | undefined;
    child.stdout.on("data", (d) => { stdout += String(d); });
    child.stderr.on("data", (d) => { stderr += String(d); });
    const t = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.on("error", (err) => { error = String(err); });
    child.on("close", (code) => {
      clearTimeout(t);
      // The raw helper says so when its execve failed: the door never ran.
      if (error === undefined && code === 127 && stderr.includes(EXEC_ENV_FAILED)) error = stderr.trim();
      resolve({ marker: existsSync(mark), timedOut, stdout, stderr, code, ...(error === undefined ? {} : { error }) });
    });
  });
}

function baseEnv(dir: string, mark: string): Record<string, string> {
  // No HOME: macOS refuses one that isn't the account's own (and takes the account's home from the password database
  // without one); the core's own state goes to the temp CLOVER_HOME.
  const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", CLOVER_HOME: join(dir, "home"), DOOR_MARK: mark };
  for (const k of ["SystemRoot", "windir", "TEMP", "TMP"]) if (process.env[k] !== undefined) env[k] = process.env[k]!;
  if (process.platform === "win32") env.USERPROFILE = join(dir, "h");
  return env;
}

const EXEC_ENV_FAILED = "exec-env: execve failed";
/** A tiny execve helper: `exec-env <n> <entry>… <program> <args>…` runs the program with exactly those n entries. */
const EXEC_ENV_C = `#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
int main(int argc, char **argv) {
  if (argc < 3) return 2;
  int n = atoi(argv[1]);
  if (n < 0 || 2 + n >= argc) return 2;
  char **envp = calloc((size_t)n + 1, sizeof(char *));
  for (int i = 0; i < n; i++) envp[i] = argv[2 + i];
  execve(argv[2 + n], &argv[2 + n], envp);
  perror("${EXEC_ENV_FAILED}");
  return 127;
}
`;

async function listen(server: Server, at: string | number): Promise<void> {
  await new Promise<void>((res, rej) => { server.once("error", rej); server.listen(at as never, () => res()); });
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((res) => {
    const s = createConnection({ host: "127.0.0.1", port });
    s.once("connect", () => { s.destroy(); res(true); });
    s.once("error", () => res(false));
    setTimeout(() => { s.destroy(); res(false); }, 1000);
  });
}

/** Every `BUN_*` / `NODE_*` name in the binary's code outside the module graph. Names Bun keeps packed together are
 *  split at each `BUN_`/`NODE_` start, so both halves of a run are tried. */
export function envNamesIn(bytes: Uint8Array): string[] {
  const graph = moduleGraphRange(bytes);
  const text = Buffer.from(bytes.subarray(0, graph.start)).toString("latin1") + "\0" + Buffer.from(bytes.subarray(graph.end)).toString("latin1");
  const names = new Set<string>();
  for (const m of text.matchAll(/(?:BUN|NODE)_[A-Z0-9_]{2,}/g)) {
    const run = m[0];
    const starts = [...run.matchAll(/(?:BUN|NODE)_/g)].map((x) => x.index!);
    for (const s of starts) {
      for (const e of [...starts.filter((x) => x > s), run.length]) {
        const name = run.slice(s, e).replace(/_+$/, "");
        if (/^(?:BUN|NODE)_[A-Z0-9][A-Z0-9_]+$/.test(name)) names.add(name);
      }
    }
  }
  return [...names].sort();
}

/** openssl, or undefined when this machine has none (some Windows runners). */
function openssl(args: string[], cwd: string): boolean {
  const r = spawnSync("openssl", args, { cwd, encoding: "utf8" });
  return r.status === 0;
}

/** A local HTTPS server with `cert`/`key`, for one check. */
async function httpsServer(cert: string, key: string): Promise<{ url: string; close(): void }> {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", tls: { cert, key }, fetch: () => new Response("ok") });
  return { url: `https://localhost:${server.port}/sealed-core`, close: () => server.stop(true) };
}

/**
 * The TLS trust checks. On every OS: a self-signed certificate is refused (main thread and Worker). macOS: a CA only
 * the OS trusts (Apple's own root, behind gdmf.apple.com, which Bun's bundled roots don't hold) is trusted, which shows
 * `--use-system-ca` took. Linux with password-less sudo (CI's runners): a throwaway CA added to the OS store and
 * removed again afterwards is trusted for a local server it signed.
 */
async function trustChecks(work: string, nonce: string, run: (args: string[]) => Promise<Run>): Promise<string[]> {
  const problems: string[] = [];
  const say = (ok: boolean, what: string) => console.log(`verify:sealed-core: ${ok ? "ok    " : "WRONG "} ${what}`);
  const dir = join(work, "tls");
  mkdirSync(dir, { recursive: true });
  const outcome = (r: Run) => (r.error !== undefined ? `ERROR: it did not run (${r.error.slice(0, 120)})` : /^fetch-probe: (.*)$/m.exec(r.stdout)?.[1] ?? `no answer (exit ${r.code}: ${(r.stdout + r.stderr).trim().slice(0, 120)})`);
  if (openssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost", "-keyout", "self.key", "-out", "self.pem"], dir)) {
    const server = await httpsServer(readFileSync(join(dir, "self.pem"), "utf8"), readFileSync(join(dir, "self.key"), "utf8"));
    try {
      for (const worker of [false, true]) {
        const got = outcome(await run(["__fetch-probe", server.url, nonce, ...(worker ? ["--worker"] : [])]));
        const ok = got.startsWith("failed (") && !got.includes("ECONNREFUSED");
        if (!ok) problems.push(`a self-signed certificate must be refused${worker ? " (from a Worker)" : ""}: ${got}`);
        say(ok, `a self-signed certificate is refused${worker ? " from a Worker" : ""} (${got})`);
      }
    } finally {
      server.close();
    }
  } else if (process.platform !== "win32") {
    problems.push("openssl is missing: the TLS trust checks can't run");
  }
  if (process.platform === "darwin") {
    for (const worker of [false, true]) {
      const got = outcome(await run(["__fetch-probe", "https://gdmf.apple.com/v2/pmv", nonce, ...(worker ? ["--worker"] : [])]));
      const ok = /^\d+$/.test(got);
      if (!ok) problems.push(`a CA only the OS store holds (Apple's root, gdmf.apple.com) must be trusted${worker ? " from a Worker" : ""} (--use-system-ca): ${got}`);
      say(ok, `the OS store's CA is trusted${worker ? " from a Worker" : ""} (gdmf.apple.com: ${got})`);
    }
  }
  if (process.platform === "linux" && spawnSync("sudo", ["-n", "true"]).status === 0 && existsSync("/usr/local/share/ca-certificates")) {
    const made = openssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-subj", "/CN=Clover sealed-core gate CA", "-keyout", "ca.key", "-out", "ca.pem"], dir)
      && openssl(["req", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=localhost", "-keyout", "leaf.key", "-out", "leaf.csr"], dir)
      && (writeFileSync(join(dir, "leaf.ext"), "subjectAltName=DNS:localhost\n"), openssl(["x509", "-req", "-in", "leaf.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-days", "2", "-extfile", "leaf.ext", "-out", "leaf.pem"], dir));
    if (!made) problems.push("openssl could not make the throwaway CA");
    else {
      const installed = "/usr/local/share/ca-certificates/clover-sealed-core-gate.crt";
      const server = await httpsServer(readFileSync(join(dir, "leaf.pem"), "utf8"), readFileSync(join(dir, "leaf.key"), "utf8"));
      try {
        const before = outcome(await run(["__fetch-probe", server.url, nonce]));
        spawnSync("sudo", ["-n", "cp", join(dir, "ca.pem"), installed]);
        spawnSync("sudo", ["-n", "update-ca-certificates"]);
        for (const worker of [false, true]) {
          const got = outcome(await run(["__fetch-probe", server.url, nonce, ...(worker ? ["--worker"] : [])]));
          const ok = got === "200" && before !== "200";
          if (!ok) problems.push(`a CA added to the OS store must be trusted${worker ? " from a Worker" : ""} (before it: ${before}; after: ${got})`);
          say(ok, `a CA in the OS store is trusted${worker ? " from a Worker" : ""} (before it was added: ${before}; after: ${got})`);
        }
      } finally {
        server.close();
        spawnSync("sudo", ["-n", "rm", "-f", installed]);
        spawnSync("sudo", ["-n", "update-ca-certificates", "--fresh"]);
      }
    }
  }
  return problems;
}

export async function verifySealedCore(given: string, opts: { signed: boolean; sweep: boolean }): Promise<string[]> {
  const problems: string[] = [];
  // Absolute: every run has its own temp working folder.
  const binary = resolve(given);
  if (!existsSync(binary)) return [`ERROR: no binary at ${binary}`];
  const bytes = new Uint8Array(readFileSync(binary));
  const format = moduleGraphRange(bytes).format;
  const sealed = sealsFormat(format);
  problems.push(...sealProblems(bytes).map((p) => `byte check: ${p}`));
  const win = process.platform === "win32";

  const work = mkdtempSync(join(tmpdir(), "clover-sealed-core-"));
  // `__fetch-probe` takes only a 32-hex key (fetch-probe.ts).
  const nonce = randomBytes(16).toString("hex");
  let hits = 0;
  const http = createHttpServer((_req, res) => { hits++; res.writeHead(200); res.end("ok"); });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", () => r()));
  const probeUrl = `http://127.0.0.1:${(http.address() as { port: number }).port}/sealed-core`;
  try {
    let bin = binary;
    let dylib = "";
    let execEnv = "";
    if (process.platform === "darwin") {
      if (!opts.signed) {
        bin = join(work, "clover-core");
        copyFileSync(binary, bin);
        const s = spawnSync("codesign", ["--force", "--sign", "-", "--options", "runtime", "--entitlements", join(ROOT, "scripts", "clover-core.entitlements"), bin], { encoding: "utf8" });
        if (s.status !== 0) return [...problems, `codesign (hardened runtime, ad hoc) failed: ${s.stderr.trim()}`];
      }
      // The macOS seal holds only under the hardened runtime and without the DYLD entitlement.
      const flags = spawnSync("codesign", ["-dv", bin], { encoding: "utf8" }).stderr;
      if (!/flags=0x[0-9a-f]+\([^)]*runtime/.test(flags)) problems.push("the binary is not signed with the hardened runtime: the macOS seal (DYLD_* names) is open");
      const ents = spawnSync("codesign", ["-d", "--entitlements", "-", "--xml", bin], { encoding: "utf8" });
      if (`${ents.stdout}${ents.stderr}`.includes(DYLD_ENTITLEMENT)) problems.push(`the binary's entitlements grant ${DYLD_ENTITLEMENT}: the macOS seal (DYLD_* names) is open`);
      writeFileSync(join(work, "inj.c"), `#include <stdio.h>\n#include <stdlib.h>\n__attribute__((constructor)) static void hit(void) { const char *m = getenv("DOOR_MARK"); if (m) { FILE *f = fopen(m, "w"); if (f) { fputs("dylib", f); fclose(f); } } }\n`);
      dylib = join(work, "inj.dylib");
      const cc = spawnSync("clang", ["-dynamiclib", "-o", dylib, join(work, "inj.c")], { encoding: "utf8" });
      if (cc.status !== 0) problems.push(`clang could not build the DYLD probe: ${cc.stderr.trim()}`);
      else spawnSync("codesign", ["--force", "--sign", "-", dylib]);
    }
    if (!win) {
      writeFileSync(join(work, "exec-env.c"), EXEC_ENV_C);
      execEnv = join(work, "exec-env");
      const cc = spawnSync(process.platform === "darwin" ? "clang" : "cc", ["-o", execEnv, join(work, "exec-env.c")], { encoding: "utf8" });
      if (cc.status !== 0) problems.push(`could not build the raw execve helper: ${cc.stderr.trim()}`);
    }
    const payload = join(work, "payload.js");
    writeFileSync(payload, `require("fs").writeFileSync(process.env.DOOR_MARK, "ran " + process.argv.join(" "));\n`);
    const bunfig = join(work, "preload-bunfig.toml");
    writeFileSync(bunfig, `preload = [${JSON.stringify(payload)}]\n`);
    const versions = readFileSync(join(ROOT, "packages", "core", "src", "runtime-sdk", "versions.ts"), "utf8");
    const pin = /CODING_AGENT_BINARY_VERSION = "([^"]+)"/.exec(versions)?.[1] ?? "0.0.0";
    const np = join(work, "np");
    const pkg = join(np, "@yanlinglabs", "winter-agent-sdk-darwin-arm64");
    mkdirSync(join(pkg, "bin"), { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@yanlinglabs/winter-agent-sdk-darwin-arm64", version: pin }));
    writeFileSync(join(pkg, "bin", "winter"), "#!/bin/sh\necho planted\n");
    chmodSync(join(pkg, "bin", "winter"), 0o755);

    // The checks themselves work: plain Bun runs the payload, and (macOS, Linux) the raw helper passes `=…` through.
    {
      const controlMark = join(work, "control-mark");
      const control = spawnSync(process.execPath, [payload], { env: { ...process.env, DOOR_MARK: controlMark }, encoding: "utf8" });
      if (control.status !== 0 || !existsSync(controlMark)) problems.push("the control run (plain Bun running the payload) wrote no marker: the check itself is broken");
      if (execEnv !== "" && existsSync(execEnv)) {
        const shown = spawnSync(execEnv, ["2", "=control", "X=1", "/usr/bin/env"], { encoding: "utf8" });
        if (!shown.stdout.split("\n").includes("=control")) problems.push("the raw execve helper did not pass `=control` through: the check itself is broken");
      }
    }

    let n = 0;
    const fresh = () => {
      const dir = join(work, `run-${++n}`);
      mkdirSync(join(dir, "cwd"), { recursive: true });
      mkdirSync(join(dir, "h"), { recursive: true });
      copyFileSync(payload, join(dir, "cwd", "payload.js"));
      return dir;
    };
    const planted = join(work, "planted-home");
    mkdirSync(join(planted, "Library", "Keychains"), { recursive: true });
    writeFileSync(join(work, "ca.pem"), "not a certificate\n");
    const fill = (s: string) => s.replaceAll("$PAYLOAD", payload).replaceAll("$NP", np).replaceAll("$BUNFIG", bunfig).replaceAll("$DYLIB", dylib).replaceAll("$CADIR", work).replaceAll("$CA", join(work, "ca.pem")).replaceAll("$PLANTED_HOME", planted);
    /** One run of the binary with a door set. */
    const runDoor = async (door: Door, args: string[]): Promise<Run & { mark: string }> => {
      const dir = fresh();
      const cwd = join(dir, "cwd");
      const mark = join(dir, "mark");
      for (const [rel, content] of Object.entries(door.cwdFiles ?? {})) {
        if (content === "$PLANT") cpSync(np, join(cwd, rel), { recursive: true });
        else writeFileSync(join(cwd, rel), content);
      }
      const env = baseEnv(dir, mark);
      for (const [k, v] of Object.entries(door.env ?? {})) env[k] = fill(v);
      if (door.raw !== undefined) {
        const entries = [...Object.entries(env).map(([k, v]) => `${k}=${v}`), ...door.raw.map(fill)];
        return { ...(await runBinary(execEnv, [String(entries.length), ...entries, bin, ...args], cwd, env, mark)), mark };
      }
      return { ...(await runBinary(bin, args, cwd, env, mark)), mark };
    };
    const itself = (r: Run) => r.code === 0 && r.stdout.trim() === `clover ${VERSION}`;
    /** A run that never happened: an ERROR, which fails the gate, never "closed" or "OPEN". */
    const errored = (name: string, ...runs: Run[]): boolean => {
      const bad = runs.find((r) => r.error !== undefined);
      if (bad === undefined) return false;
      problems.push(`ERROR ${name}: the door did not run: ${bad.error!.slice(0, 200)}`);
      console.log(`verify:sealed-core: ERROR  ${name}`);
      return true;
    };

    {
      const r = await runDoor({ name: "baseline" }, ["--version"]);
      if (errored("baseline", r)) return problems;
      if (!itself(r)) problems.push(`baseline: \`clover-core --version\` did not answer \`clover ${VERSION}\` (exit ${r.code}): ${(r.stdout + r.stderr).trim().slice(0, 200)}`);
    }

    for (const door of doors()) {
      if (door.os !== undefined && !door.os.includes(process.platform)) continue;
      if (door.name.startsWith("DYLD_INSERT") && dylib === "") continue;
      if (door.raw !== undefined && (execEnv === "" || !existsSync(execEnv))) continue;
      if (door.bunEnv && !sealed) continue; // Windows: not sealed by design
      const before = problems.length;
      const r = await runDoor(door, (door.args ?? ["--version"]).map(fill));
      if (errored(door.name, r)) continue;
      if (r.marker) problems.push(`${door.name}: FOREIGN CODE RAN (${readFileSync(r.mark, "utf8").slice(0, 80)})`);
      if (r.timedOut) problems.push(`${door.name}: the binary did not exit (a debugger waiting?)`);
      if (door.check === "probe" && (r.stdout.includes('"source":"platform-package"') || r.stdout.includes('"source":"env"'))) problems.push(`${door.name}: the runtime ladder resolved a planted runtime: ${r.stdout.trim().slice(0, 300)}`);
      if (door.stayItself !== false && door.args !== undefined) {
        const v = await runDoor(door, ["--version"]);
        if (errored(`${door.name} (--version)`, v)) continue;
        if (v.marker) problems.push(`${door.name} (--version): FOREIGN CODE RAN`);
        if (!itself(v)) problems.push(`${door.name}: with it set the core did not stay itself (--version gave exit ${v.code}: ${(v.stdout + v.stderr).trim().slice(0, 160)})`);
      } else if (door.stayItself !== false && !itself(r)) {
        problems.push(`${door.name}: with it set the core did not stay itself (--version gave exit ${r.code}: ${(r.stdout + r.stderr).trim().slice(0, 160)})`);
      }
      console.log(`verify:sealed-core: ${problems.length > before ? "OPEN  " : "closed"} ${door.name}`);
    }

    // TLS trust from the environment (alone, and duplicated either way round) and, on macOS, a planted HOME: a
    // release refuses to start. The account's own HOME starts.
    for (const door of refusalDoors()) {
      if (door.os !== undefined && !door.os.includes(process.platform)) continue;
      if (door.raw !== undefined && (execEnv === "" || !existsSync(execEnv))) continue;
      const r = await runDoor(door, ["--version"]);
      if (errored(door.name, r)) continue;
      const refused = r.code === 78 && r.stderr.includes("refusing to start") && !r.stdout.includes("clover ");
      if (!refused) problems.push(`${door.name}: a release build must refuse to start with it (exit ${r.code}: ${(r.stdout + r.stderr).trim().slice(0, 160)})`);
      console.log(`verify:sealed-core: ${refused ? "refused" : "OPEN   "} ${door.name}`);
    }
    if (process.platform === "darwin") {
      const own = accountHome();
      const r = await runDoor({ name: "HOME=<the account's own>", env: own === undefined ? {} : { HOME: own } }, ["--version"]);
      if (own === undefined) problems.push("ERROR the account's home could not be read from the password database");
      else if (!errored("HOME=<the account's own>", r)) {
        if (!itself(r)) problems.push(`HOME=<the account's own>: the core must start with it (exit ${r.code}: ${(r.stdout + r.stderr).trim().slice(0, 160)})`);
        console.log(`verify:sealed-core: ${itself(r) ? "starts " : "WRONG  "} HOME=<the account's own>`);
      }
    }

    // `__fetch-probe` fetches only loopback or the one Apple URL, with a 32-hex key: anything else exits 2, unsent.
    for (const [what, url, key] of [
      ["another host", "https://example.com/sealed-core", nonce],
      ["the Apple host on another path", "https://gdmf.apple.com/sealed-core", nonce],
      ["a non-loopback address", "http://127.0.0.2:9/sealed-core", nonce],
      ["a key that isn't 32 hex", probeUrl, `sk-${nonce}`],
      ["a short key", probeUrl, nonce.slice(1)],
    ] as const) {
      const was = hits;
      const r = await runDoor({ name: what }, ["__fetch-probe", url, key]);
      if (errored(`__fetch-probe with ${what}`, r)) continue;
      const refused = r.code === 2 && r.stderr.includes("fetch-probe: refused") && hits === was && !`${r.stdout}${r.stderr}`.includes(nonce);
      if (!refused) problems.push(`__fetch-probe with ${what}: it must exit 2 without a request (exit ${r.code}: ${(r.stdout + r.stderr).trim().slice(0, 160)})`);
      console.log(`verify:sealed-core: ${refused ? "refused" : "OPEN   "} __fetch-probe with ${what}`);
    }

    // `__fetch-probe` never follows a redirect (main thread and Worker): a local 302 to a second local listener comes
    // back as 302, and the second listener sees no request (the key would have gone with it).
    {
      let second = 0;
      const target = createHttpServer((_req, res) => { second++; res.writeHead(200); res.end("ok"); });
      await new Promise<void>((r) => target.listen(0, "127.0.0.1", () => r()));
      const bounce = createHttpServer((_req, res) => { res.writeHead(302, { location: `http://127.0.0.1:${(target.address() as { port: number }).port}/bounced` }); res.end(); });
      await new Promise<void>((r) => bounce.listen(0, "127.0.0.1", () => r()));
      try {
        for (const worker of [false, true]) {
          const name = `__fetch-probe with a 302 to another listener${worker ? " (from a Worker)" : ""}`;
          const r = await runDoor({ name }, ["__fetch-probe", `http://127.0.0.1:${(bounce.address() as { port: number }).port}/sealed-core`, nonce, ...(worker ? ["--worker"] : [])]);
          if (errored(name, r)) continue;
          const held = /^fetch-probe: 302$/m.test(r.stdout) && second === 0;
          if (!held) problems.push(`${name}: the redirect was followed (${second} request(s) reached the second listener; ${(r.stdout + r.stderr).trim().slice(0, 120)})`);
          console.log(`verify:sealed-core: ${held ? "closed" : "OPEN  "} ${name}`);
        }
      } finally {
        bounce.close();
        target.close();
      }
    }

    // The key: a request with a dummy key, with the verbose-fetch variables set, never shows it.
    const keyDoors: Door[] = [{ name: "BUN_CONFIG_VERBOSE_FETCH=curl", env: { BUN_CONFIG_VERBOSE_FETCH: "curl" }, bunEnv: true }, { name: "BUN_CONFIG_VERBOSE_FETCH=1", env: { BUN_CONFIG_VERBOSE_FETCH: "1" }, bunEnv: true }, { name: "NODE_DEBUG=*", env: { NODE_DEBUG: "*" } }, { name: "no variable", env: {} }];
    for (const door of keyDoors) {
      if (door.bunEnv && !sealed) continue;
      const r = await runDoor(door, ["__fetch-probe", probeUrl, nonce]);
      if (errored(`key in the output with ${door.name}`, r)) continue;
      const ok = /^fetch-probe: /m.test(r.stdout) && !`${r.stdout}${r.stderr}`.includes(nonce);
      if (!/^fetch-probe: 200$/m.test(r.stdout) && door.name === "no variable") problems.push(`__fetch-probe did not reach the local server: ${(r.stdout + r.stderr).trim().slice(0, 200)}`);
      if (!ok) problems.push(`${door.name}: the request's key showed in the output, or the core did not stay itself`);
      console.log(`verify:sealed-core: ${ok ? "closed" : "OPEN  "} key in the output with ${door.name}`);
    }

    // Whom TLS trusts (main thread and a Worker, as an embedded session's requests are): the OS store, baked in with
    // `--use-system-ca` (build-daemon.ts) — never a self-signed certificate.
    problems.push(...(await trustChecks(work, nonce, async (args) => runDoor({ name: "tls" }, args))));

    // The debugger: BUN_INSPECT with wait must neither block nor open its port; CONNECT_TO must not connect out.
    if (sealed) {
      const port = 47_000 + Math.floor(Math.random() * 2000);
      const dir = fresh();
      const mark = join(dir, "mark");
      const pending = runBinary(bin, ["--version"], join(dir, "cwd"), { ...baseEnv(dir, mark), BUN_INSPECT: `ws://127.0.0.1:${port}/sealed?wait=1` }, mark, 6000);
      await new Promise((r) => setTimeout(r, 1500));
      const open = await portOpen(port);
      const r = await pending;
      if (!errored("BUN_INSPECT=ws://…?wait=1", r)) {
        if (open || r.timedOut || !itself(r)) problems.push(`BUN_INSPECT: ${open ? "a debugger port opened" : r.timedOut ? "a debugger held the process" : "the core did not stay itself"}`);
        console.log(`verify:sealed-core: ${open || r.timedOut || !itself(r) ? "OPEN  " : "closed"} BUN_INSPECT=ws://…?wait=1`);
      }
    }
    if (sealed && !win) {
      const dir = fresh();
      const mark = join(dir, "mark");
      const sock = join(dir, "i.sock");
      let connected = false;
      const server = createServer((s) => { connected = true; s.destroy(); });
      await listen(server, sock);
      const r = await runBinary(bin, ["--version"], join(dir, "cwd"), { ...baseEnv(dir, mark), BUN_INSPECT_CONNECT_TO: `unix://${sock}` }, mark, 6000);
      await new Promise((res) => setTimeout(res, 300));
      server.close();
      if (!errored("BUN_INSPECT_CONNECT_TO=unix://…", r)) {
        const open = connected || r.timedOut || !itself(r);
        if (open) problems.push("BUN_INSPECT_CONNECT_TO: the binary connected a debugger out, or did not stay itself");
        console.log(`verify:sealed-core: ${open ? "OPEN  " : "closed"} BUN_INSPECT_CONNECT_TO=unix://…`);
      }
    }

    // The sweep: every BUN_*/NODE_* name in Bun's code, each with four values, run through __fetch-probe.
    if (opts.sweep && sealed) {
      const names = envNamesIn(new Uint8Array(readFileSync(bin)));
      const values = ["1", "*", "--preload=$PAYLOAD", "$PAYLOAD"];
      const jobs = names.flatMap((name) => values.map((value) => ({ name, value })));
      const failures: string[] = [];
      let next = 0;
      const worker = async () => {
        while (next < jobs.length) {
          const { name, value } = jobs[next++]!;
          const r = await runDoor({ name, env: { [name]: value } }, ["__fetch-probe", probeUrl, nonce]);
          if (r.error !== undefined) {
            failures.push(`ERROR ${name}=${value.replace("$PAYLOAD", "<payload>")}: the door did not run: ${r.error.slice(0, 120)}`);
            continue;
          }
          const refusedTls = r.code === 78 && r.stderr.includes("refusing to start");
          const ranOwn = /^fetch-probe: /m.test(r.stdout) || refusedTls;
          if (r.marker || r.timedOut || !ranOwn || `${r.stdout}${r.stderr}`.includes(nonce)) {
            failures.push(`${name}=${value.replace("$PAYLOAD", "<payload>")}: ${r.marker ? "FOREIGN CODE RAN" : r.timedOut ? "did not exit" : !ranOwn ? `did not stay itself (exit ${r.code}: ${(r.stdout + r.stderr).trim().slice(0, 120)})` : "the key showed"}`);
          }
        }
      };
      await Promise.all(Array.from({ length: 8 }, worker));
      problems.push(...failures.sort().map((f) => `sweep: ${f}`));
      console.log(`verify:sealed-core: sweep of ${names.length} BUN_*/NODE_* names × ${values.length} values: ${failures.length === 0 ? "all closed" : `${failures.length} open`}`);
    }
  } finally {
    http.close();
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
  const problems = await verifySealedCore(binary, { signed: argv.includes("--signed"), sweep: !argv.includes("--no-sweep") });
  for (const p of problems) console.error(`verify:sealed-core: ${p}`);
  console.log(problems.length === 0 ? "verify:sealed-core: ok — the compiled core runs only its own code and shows no key" : `verify:sealed-core: ${problems.length} problem(s)`);
  process.exit(problems.length === 0 ? 0 : 1);
}
