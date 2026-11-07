// A plugin's processes load only its own tree (#234's review, F2, the controller's ruling): the reviewer's probes,
// each run once as a control without Clover's flags (the outside file runs) and once as Clover runs plugins (it
// doesn't). Real Bun processes in temp folders; nothing opens a window.
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HookRunner } from "../../plugins/hook-runner";
import { PluginSupervisor, isBunCommand } from "../../plugins/supervisor";
import { pluginStdioMcpServer } from "../../runtime-sdk/external-mcp";
import { PLUGIN_BUNFIG, PLUGIN_GUARD_SOURCE, pluginBun, pluginBunFor, ensurePluginRunFiles, guardedMcpServer, guardedPluginEnv, pluginBunFlags } from "../plugin-run";

function world() {
  const base = mkdtempSync(join(tmpdir(), "clover-b-plugin-run-"));
  const files = ensurePluginRunFiles(join(base, "run"));
  const outside = join(base, "outside");
  mkdirSync(join(outside, "jsx"), { recursive: true });
  const mark = join(base, "mark");
  const evil = `require("node:fs").writeFileSync(${JSON.stringify(mark)}, "ran");\nexport const x = 1;\nexport const jsx = () => null, jsxs = jsx, jsxDEV = jsx, Fragment = 0;\n`;
  writeFileSync(join(outside, "evil.ts"), evil);
  writeFileSync(join(outside, "jsx", "jsx-runtime.ts"), evil);
  writeFileSync(join(outside, "jsx", "jsx-dev-runtime.ts"), evil);
  const cjs = `require("node:fs").writeFileSync(${JSON.stringify(mark)}, "ran");\n`;
  writeFileSync(join(outside, "noext"), cjs); // no extension: loaded as JavaScript
  writeFileSync(join(outside, "evil.txt"), cjs); // loaded as TypeScript on request
  const plugin = (name: string, tree: Record<string, string>) => {
    const root = join(base, name);
    for (const [path, text] of Object.entries(tree)) {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), text.replaceAll("$OUTSIDE", outside));
    }
    return root;
  };
  /** Runs `entry` in the plugin folder (its cwd, as a hook's): the inner `bun` takes what the env gives it. */
  const run = (root: string, entry: string, guarded: boolean) => {
    rmSync(mark, { force: true });
    // NODE_ENV=test (bun test's) would have Bun read `.env.test` rather than `.env`; a plugin process has none.
    const plain = { ...process.env, NODE_ENV: undefined };
    const env = guarded ? guardedPluginEnv(plain, { pluginRoot: root, files, shared: [] }) : { ...plain, BUN_OPTIONS: "" };
    const r = Bun.spawnSync([process.execPath, entry], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
    return { ran: existsSync(mark), stderr: r.stderr.toString(), stdout: r.stdout.toString(), code: r.exitCode };
  };
  return { base, files, plugin, run };
}

describe("a plugin process loads only its own tree", () => {
  const w = world();
  // Waits for a worker to finish, fail or run 3 s.
  const settle = "const settle = (w) => new Promise((r) => { for (const e of [\"close\", \"exit\", \"error\", \"messageerror\"]) (w.addEventListener ?? w.on).call(w, e, r); setTimeout(r, 3000); });\n";
  const probes: [string, Record<string, string>, string][] = [
    ["a tsconfig paths target with .. after its *", {
      "tsconfig.json": JSON.stringify({ compilerOptions: { paths: { "lib/*": ["./host/a/*/../../../../outside/evil.ts"] } } }),
      "host/a/x/keep.txt": "", "host/index.ts": "import \"lib/x\";\nconsole.log(\"host ran\");\n",
    }, "host/index.ts"],
    ["a dependency's main climbing out of node_modules", {
      "node_modules/dep/package.json": JSON.stringify({ name: "dep", main: "lib/../../../../outside/evil.ts" }),
      "host/index.ts": "import \"dep\";\nconsole.log(\"host ran\");\n",
    }, "host/index.ts"],
    ["a jsxImportSource outside the plugin", {
      "host/index.tsx": "/** @jsxImportSource ../../outside/jsx */\nconst a = <div />;\nconsole.log(\"host ran\", a);\n",
    }, "host/index.tsx"],
    ["a dynamic import outside the plugin", { "host/index.ts": "await import(\"../../outside/evil.ts\");\nconsole.log(\"host ran\");\n" }, "host/index.ts"],
    // #234's check 3, G1: workers.
    ["a Worker started on an outside file", { "host/index.ts": `${settle}await settle(new Worker("$OUTSIDE/evil.ts"));\nprocess.exit(0);\n` }, "host/index.ts"],
    ["a Worker on an inside file that imports an outside one", {
      "host/w.ts": "import \"../../outside/evil.ts\";\n",
      "host/index.ts": `${settle}await settle(new Worker(new URL("./w.ts", import.meta.url).href));\nprocess.exit(0);\n`,
    }, "host/index.ts"],
    ["a node:worker_threads Worker on an outside file", {
      "host/index.ts": `import { Worker as W } from "node:worker_threads";\n${settle}await settle(new W("$OUTSIDE/evil.ts"));\nprocess.exit(0);\n`,
    }, "host/index.ts"],
    ["a Worker after the plugin points its folder elsewhere in process.env", {
      "host/index.ts": `process.env.CLOVER_PLUGIN_ROOT = "/";\nprocess.env.CLOVER_PLUGIN_SHARED = "[\\"/\\"]";\n${settle}await settle(new Worker("$OUTSIDE/evil.ts", { env: { CLOVER_PLUGIN_ROOT: "/" } }));\nprocess.exit(0);\n`,
    }, "host/index.ts"],
    ["the original Worker reached through the wrapper", {
      "host/index.ts": `${settle}const C = Worker.prototype.constructor;\nawait settle(new C("$OUTSIDE/evil.ts"));\nprocess.exit(0);\n`,
    }, "host/index.ts"],
    // #234's check 3, G2: any outside file, whatever its name or loader.
    ["a require of an outside file with no extension", { "host/index.ts": "require(\"$OUTSIDE/noext\");\n" }, "host/index.ts"],
    ["an import of an outside .txt as TypeScript", { "host/index.ts": "await import(\"$OUTSIDE/evil.txt\", { with: { type: \"ts\" } });\n" }, "host/index.ts"],
    ["the resolver put back, then a require outside", {
      "host/index.ts": "const M = require(\"node:module\");\ntry { M._resolveFilename = (r) => r; } catch {}\ntry { Object.defineProperty(M, \"_resolveFilename\", { value: (r) => r }); } catch {}\nrequire(\"$OUTSIDE/noext\");\n",
    }, "host/index.ts"],
    ["a Worker with an outside preload of its own", {
      "host/w.ts": "postMessage(1);\n",
      "host/index.ts": `${settle}await settle(new Worker(new URL("./w.ts", import.meta.url).href, { preload: ["$OUTSIDE/evil.ts"] }));\nprocess.exit(0);\n`,
    }, "host/index.ts"],
    // #234's check 4, H2.
    ["a ShadowRealm importing an outside file", { "host/index.ts": "try { await new ShadowRealm().importValue(\"$OUTSIDE/evil.ts\", \"x\"); } catch {}\n" }, "host/index.ts"],
    ["Bun.plugin.clearAll, then an outside import", { "host/index.ts": "try { Bun.plugin.clearAll(); } catch {}\nawait import(\"$OUTSIDE/evil.ts\");\n" }, "host/index.ts"],
    ["a bunfig.toml preload", { "bunfig.toml": "preload = [\"$OUTSIDE/evil.ts\"]\n", "host/index.ts": "console.log(\"host ran\");\n" }, "host/index.ts"],
  ];
  // A plugin folder's .env reaches the process's env (Bun loads it), and from there any node a plugin starts runs
  // its NODE_OPTIONS --require. Without node on the machine, the env itself is the check.
  test("a .env NODE_OPTIONS never reaches a plugin process, nor a node it starts", () => {
    writeFileSync(join(w.base, "outside", "evil.cjs"), `require("node:fs").writeFileSync(${JSON.stringify(join(w.base, "mark"))}, "ran");\n`);
    const node = Bun.which("node");
    const root = w.plugin("dotenv", {
      ".env": "NODE_OPTIONS=--require $OUTSIDE/evil.cjs\n",
      "host/index.ts": `${node ? `Bun.spawnSync([${JSON.stringify(node)}, "-e", "1"], { env: process.env });\n` : ""}console.log(process.env.NODE_OPTIONS ?? "none");\n`,
    });
    const control = w.run(root, "host/index.ts", false);
    expect(control.stdout).toContain("--require");
    if (node) expect(control.ran).toBe(true);
    const guarded = w.run(root, "host/index.ts", true);
    expect([guarded.stdout.trim(), guarded.ran]).toEqual(["none", false]);
  }, 30_000);
  for (const [name, tree, entry] of probes) {
    test(`${name}: runs without Clover's flags, never with them`, () => {
      const root = w.plugin(name.replace(/[^a-z]+/gi, "-"), tree);
      expect(w.run(root, entry, false).ran).toBe(true); // the probe is real
      const guarded = w.run(root, entry, true);
      expect(guarded.ran).toBe(false);
    }, 30_000);
  }

  test("a plugin's own files, its own node_modules and data files still load", () => {
    const root = w.plugin("fine", {
      "node_modules/dep/package.json": JSON.stringify({ name: "dep", main: "index.js" }), "node_modules/dep/index.js": "module.exports = 2;\n",
      "host/lib.ts": "export const y = 1;\n", "host/data.json": "{\"z\":3}", "host/icon.png": "png",
      "host/index.ts": "import { y } from \"./lib\";\nimport dep from \"dep\";\nimport d from \"./data.json\";\nimport icon from \"./icon.png\";\nconsole.log(\"ok\", y, dep, d.z, typeof icon);\n",
    });
    const r = w.run(root, "host/index.ts", true);
    expect([r.code, r.stdout.trim(), r.stderr]).toEqual([0, "ok 1 2 3 string", ""]);
  }, 30_000);

  test("a plugin's own workers still run, both kinds, its own imports included", () => {
    const root = w.plugin("fine-workers", {
      "host/lib.ts": "export const y = 2;\n",
      "host/w.ts": "import { y } from \"./lib\";\npostMessage(y);\n",
      "host/n.ts": "import { parentPort } from \"node:worker_threads\";\nimport { y } from \"./lib\";\nparentPort.postMessage(y + 1);\n",
      "host/index.ts": [
        "import { Worker as NW } from \"node:worker_threads\";",
        "const a = await new Promise((r) => { const x = new Worker(new URL(\"./w.ts\", import.meta.url).href); x.onmessage = (e) => { r(e.data); x.terminate(); }; });",
        "const b = await new Promise((r) => { const x = new NW(new URL(\"./n.ts\", import.meta.url)); x.on(\"message\", (m) => { r(m); x.terminate(); }); });",
        "console.log(\"ok\", a, b);", "process.exit(0);", "",
      ].join("\n"),
    });
    const r = w.run(root, "host/index.ts", true);
    expect([r.code, r.stdout.trim(), r.stderr]).toEqual([0, "ok 2 3", ""]);
  }, 30_000);

  // Bun 1.4.4 hands an ESM load of a file without an extension to neither onResolve nor onLoad (#234's check 4, H1),
  // so the guard can't see it: the fence keeps runners from planting one above a plugin, and the OK refuses a plugin
  // that imports what it doesn't ship. This pins the gap: a Bun that closes it fails here, and the guard can then
  // refuse these loads too.
  test("pinned Bun behaviour: an ESM import of an outside file with no extension still skips the guard", () => {
    const root = w.plugin("pin-noext", { "host/index.ts": "import \"$OUTSIDE/noext\";\n" });
    expect(w.run(root, "host/index.ts", true).ran).toBe(true);
  }, 30_000);

  test("Clover's bunfig turns off auto-install: a dependency the plugin doesn't ship isn't fetched", () => {
    expect(PLUGIN_BUNFIG).toContain("[install]\nauto = \"disable\"");
    const root = w.plugin("no-auto-install", { "host/index.ts": "import pad from \"is-odd\";\nconsole.log(pad);\n" });
    const started = performance.now();
    const r = w.run(root, "host/index.ts", true);
    expect([r.code === 0, /Cannot find (package|module)/.test(r.stderr)]).toEqual([false, true]);
    expect(performance.now() - started).toBeLessThan(10_000);
  }, 30_000);

  test("a supervised host runs on the plugin Bun, never a bun the plugin ships (K1)", async () => {
    const ranOwn = join(w.base, "own-bun-ran");
    const hostRan = join(w.base, "host-ran");
    const root = w.plugin("ships-bun", {
      "bun": `#!/bin/sh\necho ran > ${JSON.stringify(ranOwn)}\n`,
      "host/index.ts": `require("node:fs").writeFileSync(${JSON.stringify(hostRan)}, process.execPath);\nsetTimeout(() => {}, 60_000);\n`,
    });
    chmodSync(join(root, "bun"), 0o755);
    const sup = new PluginSupervisor({ runDir: join(w.base, "sup-run-3"), socketPath: "/s", mintToken: () => "t", pluginRun: { files: w.files, shared: [] } });
    sup.startAll([{ id: "ships@local", dir: root, entry: { command: "./bun", args: ["host/index.ts"] } }]);
    for (let i = 0; i < 100 && !existsSync(hostRan); i++) await Bun.sleep(50);
    sup.stopAll();
    expect([readFileSync(hostRan, "utf8"), existsSync(ranOwn)]).toEqual([pluginBun(), false]);
  }, 30_000);

  test("a hook's bun is the plugin Bun", async () => {
    const root = w.plugin("hook-bun", { "keep.txt": "" });
    const runner = new HookRunner({ files: w.files, shared: [] });
    const r = await runner.run({ pluginId: "p", command: "command -v bun", cwd: root }, { event: "e", sessionId: "s", pluginId: "p", ts: 0 });
    expect([r.status, r.stdout.trim()]).toEqual(["ok", join(w.files.bin, "bun")]);
    expect(realpathSync(join(w.files.bin, "bun"))).toBe(realpathSync(pluginBun()));
  }, 30_000);

  describe("pluginBun: where plugin code runs (K1, lane M's layout)", () => {
    const core = "/Applications/Clover.app/Contents/Resources/daemon/clover-core";
    const beside = "/Applications/Clover.app/Contents/Resources/daemon/clover-plugin-bun";
    const id = (p: string) => p;
    test("a compiled core: the one beside it, failing closed without it", () => {
      expect(pluginBunFor({ compiled: true, execPath: core, exists: (p) => p === beside, real: id })).toBe(beside);
      expect(() => pluginBunFor({ compiled: true, execPath: core, exists: () => false, real: id })).toThrow(/isn't at .*clover-plugin-bun/);
      // A test service changes nothing for a compiled core.
      expect(pluginBunFor({ compiled: true, execPath: core, keychainService: "com.waifucave.clover.core.test-isolated", exists: (p) => p === beside, real: id })).toBe(beside);
    });
    test("from source with a test Keychain service: the Bun it runs on", () => {
      expect(pluginBunFor({ compiled: false, execPath: "/usr/local/bin/bun", keychainService: "com.waifucave.clover.core.test-isolated" })).toBe("/usr/local/bin/bun");
      expect(pluginBun()).toBe(process.execPath); // this suite's preload sets the test service
    });
    test("from source otherwise (a dev daemon under plain Bun): dist/dev's, failing closed without it", () => {
      const dev = "/repo/dist/dev";
      for (const keychainService of [undefined, "com.waifucave.clover.core.dev", "com.waifucave.clover.core"]) {
        expect(pluginBunFor({ compiled: false, execPath: "/usr/local/bin/bun", keychainService, devDist: dev, exists: (p) => p === `${dev}/clover-plugin-bun` })).toBe(`${dev}/clover-plugin-bun`);
        expect(() => pluginBunFor({ compiled: false, execPath: "/usr/local/bin/bun", keychainService, devDist: dev, exists: () => false })).toThrow(/isn't at \/repo\/dist\/dev\/clover-plugin-bun/);
      }
    });
    test("never the compiled core's own execPath, by any name", () => {
      // The core itself, a link to it, a copy that resolves to it: refused.
      expect(() => pluginBunFor({ compiled: true, execPath: core, exists: () => true, real: () => core })).toThrow(/the core's own binary/);
      expect(() => pluginBunFor({ compiled: true, execPath: core, exists: () => true, real: () => { throw new Error("gone"); } })).toThrow(/the core's own binary/);
      for (const exists of [() => true, (p: string) => p === beside]) {
        let got: string | undefined;
        try {
          got = pluginBunFor({ compiled: true, execPath: core, exists, real: id });
        } catch {
          got = undefined;
        }
        expect(got).not.toBe(core);
      }
    });
  });

  test("BUN_BE_BUN never reaches a plugin process, whoever set it", () => {
    expect(guardedPluginEnv({ BUN_BE_BUN: "1", PATH: "/bin" }, { pluginRoot: w.base, files: w.files, shared: [] }).BUN_BE_BUN).toBeUndefined();
    // The guard deletes it at startup too, for a process started some other way.
    const root = w.plugin("be-bun", { "host/index.ts": "console.log(process.env.BUN_BE_BUN ?? \"unset\");\n" });
    const env = { ...guardedPluginEnv({ ...process.env, NODE_ENV: undefined }, { pluginRoot: root, files: w.files, shared: [] }), BUN_BE_BUN: "1" };
    const r = Bun.spawnSync([process.execPath, "host/index.ts"], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
    expect(r.stdout.toString().trim()).toBe("unset");
  }, 30_000);

  test("a plugin's Bun stdio MCP server runs guarded, whatever environment the runtime merges under it", () => {
    const root = w.plugin("mcp", { "bunfig.toml": "preload = [\"$OUTSIDE/evil.ts\"]\n", ".env": "X=1\n", "server.ts": "console.log(\"server ran\");\n" });
    const guard = { files: w.files, shared: [] };
    const cfg = pluginStdioMcpServer({ command: "bun", args: ["server.ts"], env: { TOKEN: "t", NODE_OPTIONS: "--require x" } }, root, guard);
    if (cfg.type !== "stdio") throw new Error("stdio expected");
    expect(cfg.command).toBe(pluginBun());
    expect([cfg.env?.BUN_OPTIONS, cfg.env?.CLOVER_PLUGIN_ROOT, cfg.env?.TOKEN, cfg.env?.NODE_OPTIONS, cfg.env?.NODE_PATH]).toEqual([pluginBunFlags(w.files).join(" "), realpathSync(root), "t", "", ""]);
    // The worst merge: the whole parent environment under the config's, the parent's BUN_OPTIONS and NODE_OPTIONS in it.
    const parent = { ...process.env, NODE_ENV: undefined, BUN_OPTIONS: "--preload=/elsewhere.ts", NODE_OPTIONS: "--require /elsewhere.js" };
    const r = Bun.spawnSync([cfg.command, ...(cfg.args ?? [])], { cwd: root, env: { ...parent, ...cfg.env }, stdout: "pipe", stderr: "pipe" });
    expect([r.stdout.toString().trim(), existsSync(join(w.base, "mark"))]).toEqual(["server ran", false]);
    // A program that isn't Bun keeps its command, and gets the guarded environment all the same: a `bun` it starts
    // is the plugin Bun, guarded (check 5).
    const sh = guardedMcpServer<{ command: string; args?: string[]; env?: Record<string, string> }>({ command: "sh", args: ["-c", "bun server.ts"], env: { A: "1" } }, root, guard);
    expect([sh.command, sh.env?.A, sh.env?.BUN_OPTIONS, sh.env?.PATH?.split(":")[0], sh.env?.BUN_BE_BUN]).toEqual(["sh", "1", pluginBunFlags(w.files).join(" "), w.files.bin, undefined]);
    const viaShell = Bun.spawnSync([sh.command, ...(sh.args ?? [])], { cwd: root, env: { ...parent, ...sh.env }, stdout: "pipe", stderr: "pipe" });
    expect([viaShell.stdout.toString().trim(), existsSync(join(w.base, "mark"))]).toEqual(["server ran", false]);
  }, 30_000);

  test("a hook's bun runs guarded: the outside file never loads", async () => {
    const root = w.plugin("hook", { "hooks/check.ts": "await import(\"../../outside/evil.ts\");\n" });
    const runner = new HookRunner({ files: w.files, shared: [] });
    const r = await runner.run({ pluginId: "p", command: `${JSON.stringify(process.execPath)} hooks/check.ts`, cwd: root }, { event: "e", sessionId: "s", pluginId: "p", ts: 0 });
    expect([r.status, existsSync(join(w.base, "mark"))]).toEqual(["error", false]);
  }, 30_000);

  test("a supervised plugin process gets Clover's flags and its own root", () => {
    const seen: Record<string, string>[] = [];
    const sup = new PluginSupervisor({
      runDir: join(w.base, "sup-run"), socketPath: "/s", mintToken: () => "t",
      pluginRun: { files: w.files, shared: [] },
      spawn: (_cmd, o) => { seen.push(o.env); return { pid: 999_999, exited: new Promise<number>(() => {}), kill() {} }; },
      isAlivePid: () => false, signalPid: () => {}, processStartedAt: () => null,
    });
    const root = w.plugin("sup", { "host/index.ts": "" });
    sup.startAll([{ id: "sup@local", dir: root, entry: { command: "bun", args: ["host/index.ts"] } }]);
    expect([seen[0]?.BUN_OPTIONS, seen[0]?.CLOVER_PLUGIN_ROOT, seen[0]?.CLOVER_PLUGIN_TOKEN]).toEqual([pluginBunFlags(w.files).join(" "), realpathSync(root), "t"]);
    sup.stopAll();
  });

  test("a supervised host whose command isn't Bun never starts", () => {
    const seen: string[][] = [];
    const sup = new PluginSupervisor({
      runDir: join(w.base, "sup-run-2"), socketPath: "/s", mintToken: () => "t",
      pluginRun: { files: w.files, shared: [] },
      spawn: (cmd) => { seen.push(cmd); return { pid: 999_998, exited: new Promise<number>(() => {}), kill() {} }; },
      isAlivePid: () => false, signalPid: () => {}, processStartedAt: () => null,
    });
    const root = w.plugin("sup-node", { "host/index.js": "" });
    sup.startAll([{ id: "node@local", dir: root, entry: { command: "node", args: ["host/index.js"] } }, { id: "bun@local", dir: root, entry: { command: "/opt/bin/bun", args: ["host/index.js"] } }]);
    // The Bun one runs, on the plugin Bun whatever path the manifest gave (K1).
    expect(seen.map((c) => c[0])).toEqual([pluginBun()]);
    expect([isBunCommand("bun"), isBunCommand("C:\\bun\\bun.exe"), isBunCommand("node"), isBunCommand("/x/bunx")]).toEqual([true, true, false, false]);
    sup.stopAll();
  });

  test("the env drops what changes loading, and the run files are Clover's own", () => {
    const env = guardedPluginEnv({ PATH: "/bin", NODE_OPTIONS: "--require x", BUN_OPTIONS: "--preload y", NODE_PATH: "/z", BUN_CONFIG_REGISTRY: "r" }, { pluginRoot: w.base, files: w.files, shared: [] });
    expect([env.NODE_OPTIONS, env.NODE_PATH, env.BUN_CONFIG_REGISTRY, env.PATH]).toEqual([undefined, undefined, undefined, "/bin"]);
    expect(env.BUN_OPTIONS).toBe(pluginBunFlags(w.files).join(" "));
    expect(env.BUN_OPTIONS).not.toMatch(/\s--preload=y/);
    expect([readFileSync(w.files.bunfig, "utf8"), readFileSync(w.files.guard, "utf8")]).toEqual([PLUGIN_BUNFIG, PLUGIN_GUARD_SOURCE]);
    // A run folder with a space falls back to one without: BUN_OPTIONS takes no quotes.
    const spaced = ensurePluginRunFiles(join(w.base, "run dir"));
    expect(/\s/.test(spaced.guard)).toBe(false);
  });
});
