// A plugin's processes load only its own tree (#234's review, F2, the controller's ruling): the reviewer's probes,
// each run once as a control without Clover's flags (the outside file runs) and once as Clover runs plugins (it
// doesn't). Real Bun processes in temp folders; nothing opens a window.
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PLUGIN_BUN_IDENTIFIER } from "../../bundled-identities";
import { HookRunner } from "../../plugins/hook-runner";
import { PluginSupervisor, isBunCommand } from "../../plugins/supervisor";
import { pluginStdioMcpServer } from "../../runtime-sdk/external-mcp";
import { PLUGIN_BUNFIG, PLUGIN_GUARD_SOURCE, checkPluginBun, pluginBun, pluginBunDigest, pluginBunFor, ensurePluginRunFiles, guardedMcpServer, guardedPluginEnv, pluginBunFlags, pluginHostBunFlags, droppedEnv, envWithoutDropped } from "../plugin-run";

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

  describe("pluginBun: where plugin code runs, and only on a copy Clover made (K1, L1, L2)", () => {
    const darwin = process.platform === "darwin";
    // A small signed binary to sign as the plugin Bun (and as a stand-in core); `true` runs anywhere.
    const tiny = Bun.which("true") ?? "/usr/bin/true";
    const sign = (path: string, identifier: string) => {
      if (darwin) expect(Bun.spawnSync(["/usr/bin/codesign", "--force", "--sign", "-", "--identifier", identifier, path]).exitCode).toBe(0);
    };
    // Ad-hoc copies can't carry Clover's team: the test's requirement names the identifier alone.
    const requirement = `identifier "${PLUGIN_BUN_IDENTIFIER.dist}"`;
    const layout = () => {
      const base = realpathSync(mkdtempSync(join(tmpdir(), "clover-b-plugin-bun-")));
      const daemon = join(base, "Clover.app", "Contents", "Resources", "daemon");
      mkdirSync(daemon, { recursive: true });
      const core = join(daemon, "clover-core");
      writeFileSync(core, readFileSync(tiny));
      chmodSync(core, 0o755);
      sign(core, "com.waifucave.clover.core");
      const home = join(base, "home");
      mkdirSync(join(home, "bin"), { recursive: true });
      const shipped = { compiled: true, execPath: core, profile: "dist" as const, cloverHome: home, requirement };
      const dev = { compiled: true, execPath: core, profile: "dev" as const, cloverHome: home, requirement };
      return { base, daemon, core, home, shipped, dev, plugin: join(daemon, "clover-plugin-bun"), devPlugin: join(home, "bin", "clover-plugin-bun") };
    };
    const good = (path: string) => {
      // Off macOS nothing signs it, so a trailing byte keeps it from being the stand-in core's very bytes.
      writeFileSync(path, darwin ? readFileSync(tiny) : Buffer.concat([readFileSync(tiny), Buffer.from([0])]));
      chmodSync(path, 0o755);
      sign(path, PLUGIN_BUN_IDENTIFIER.dist);
    };

    test("a shipped copy beside a packaged core, signed as the plugin Bun, is the one", () => {
      const l = layout();
      good(l.plugin);
      expect(pluginBunFor(l.shipped)).toBe(l.plugin);
    });

    test("every forged shipped copy is refused", () => {
      const rows: [string, (l: ReturnType<typeof layout>) => void, RegExp][] = [
        ["missing", () => {}, /is missing/],
        ["a symlink to another binary", (l) => symlinkSync(tiny, l.plugin), /isn't a plain file/],
        ["a symlink to the core", (l) => symlinkSync(l.core, l.plugin), /isn't a plain file/],
        ["a hard link to the core", (l) => linkSync(l.core, l.plugin), /hard link/],
        ["a byte copy of the core", (l) => { writeFileSync(l.plugin, readFileSync(l.core)); chmodSync(l.plugin, 0o755); }, /copy of the core/],
        ["a folder in its place", (l) => mkdirSync(l.plugin), /isn't a plain file/],
        ...(darwin ? [["signed under another identifier", (l: ReturnType<typeof layout>) => { writeFileSync(l.plugin, readFileSync(tiny)); chmodSync(l.plugin, 0o755); sign(l.plugin, "com.example.not-plugin-bun"); }, /isn't signed by Clover's team/] as [string, (l: ReturnType<typeof layout>) => void, RegExp]] : []),
      ];
      for (const [name, plant, why] of rows) {
        const l = layout();
        plant(l);
        expect([name, (() => { try { pluginBunFor(l.shipped); return "accepted"; } catch (e) { return why.test((e as Error).message) ? "refused" : (e as Error).message; } })()]).toEqual([name, "refused"]);
      }
    });

    test("the dev copy in the Clover home is the one only with the digest dev:daemon recorded, and a swap is refused", () => {
      const l = layout();
      good(l.devPlugin);
      expect(() => pluginBunFor(l.dev)).toThrow(/no digest recorded/);
      writeFileSync(`${l.devPlugin}.digest`, `${pluginBunDigest(l.devPlugin)}\n`);
      expect(pluginBunFor(l.dev)).toBe(l.devPlugin);
      // Swapped for another binary (here the core's bytes, then a re-signed other one): the digest no longer matches.
      writeFileSync(l.devPlugin, readFileSync(l.core));
      expect(() => pluginBunFor(l.dev)).toThrow(/copy of the core|digest doesn't match/);
      writeFileSync(l.devPlugin, readFileSync(tiny));
      sign(l.devPlugin, "com.example.swapped");
      if (darwin) expect(() => pluginBunFor(l.dev)).toThrow(/digest doesn't match/);
      // A recorded digest that is a link isn't one dev:daemon wrote.
      const m = layout();
      good(m.devPlugin);
      writeFileSync(join(m.base, "d"), `${pluginBunDigest(m.devPlugin)}\n`);
      symlinkSync(join(m.base, "d"), `${m.devPlugin}.digest`);
      expect(() => pluginBunFor(m.dev)).toThrow(/no digest recorded/);
      // The dev rule holds for a dev daemon run from source too, and never reaches for the shipped one.
      expect(() => pluginBunFor({ ...l.dev, compiled: false })).toThrow(/plugin code can't run/);
    });

    test("on Windows every launch re-hashes, and a copy changed since it was first accepted is refused, whatever its times", () => {
      const l = layout();
      good(l.plugin);
      const win = { ...l.shipped, platform: "win32" as const };
      // (The file name here is the POSIX one: the folder layout is what's under test, not the `.exe`.)
      const at = (o: typeof win) => checkPluginBun({ path: l.plugin, folder: l.daemon, core: o.execPath, platform: "win32", kind: "shipped", requirement });
      at(win);
      at(win);
      const { atime, mtime } = statSync(l.plugin);
      const bytes = readFileSync(l.plugin);
      bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
      writeFileSync(l.plugin, bytes);
      utimesSync(l.plugin, atime, mtime); // times put back, as NTFS lets a user do with its ChangeTime too
      expect(() => at(win)).toThrow(/changed since this process first accepted it/);
    });

    test("from source with a test Keychain service: the Bun it runs on", () => {
      expect(pluginBunFor({ compiled: false, execPath: "/usr/local/bin/bun", profile: "dev", cloverHome: "/nowhere", keychainService: "com.waifucave.clover.core.test-isolated" })).toBe("/usr/local/bin/bun");
      expect(pluginBun()).toBe(process.execPath); // this suite's preload sets the test service
    });

    test("never the compiled core's own execPath, whatever the profile", () => {
      for (const profile of ["dist", "dev"] as const) {
        const l = layout();
        let got: string | undefined;
        try {
          got = pluginBunFor({ ...(profile === "dist" ? l.shipped : l.dev) });
        } catch {
          got = undefined;
        }
        expect(got).not.toBe(l.core);
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
    // A manifest's env that sets what loads code is refused outright (#322's review, B1).
    expect(() => pluginStdioMcpServer({ command: "bun", args: ["server.ts"], env: { TOKEN: "t", NODE_OPTIONS: "--require x" } }, root, guard)).toThrow("sets NODE_OPTIONS in its environment, which only Clover sets");
    const cfg = pluginStdioMcpServer({ command: "bun", args: ["server.ts"], env: { TOKEN: "t" } }, root, guard);
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

  // C (#234's check 6, L4): a computed import() no static check can read. A node_modules above the plugin's folder is
  // where it would land, so no plugin process starts beside one: the core refuses, naming the folder, and the guard
  // refuses too for a process started some other way.
  test("the reviewer's plugin C: no plugin process starts with a node_modules above its folder", () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "clover-b-plugin-c-")));
    const files = ensurePluginRunFiles(join(base, "run"));
    const mark = join(base, "mark");
    mkdirSync(join(base, "node_modules", "ghost"), { recursive: true });
    writeFileSync(join(base, "node_modules", "ghost", "index"), `require("node:fs").writeFileSync(${JSON.stringify(mark)}, "ran");\n`);
    writeFileSync(join(base, "node_modules", "ghost", "package.json"), JSON.stringify({ name: "ghost", main: "index" }));
    const root = join(base, "plugin");
    mkdirSync(join(root, "host"), { recursive: true });
    writeFileSync(join(root, "host", "index.ts"), "const name = [\"gh\", \"ost\"].join(\"\");\nawait import(name);\n");
    expect(() => guardedPluginEnv({ PATH: "/bin" }, { pluginRoot: root, files, shared: [] })).toThrow(new RegExp(`node_modules folder at ${join(base, "node_modules").replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")} is above`));
    // The guard on its own: the same environment, built without the core's check.
    const env = { ...process.env, NODE_ENV: undefined, BUN_OPTIONS: pluginBunFlags(files).join(" "), CLOVER_PLUGIN_ROOT: root, CLOVER_PLUGIN_SHARED: "[]" };
    const r = Bun.spawnSync([process.execPath, "host/index.ts"], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
    expect([r.exitCode === 0, r.stderr.toString().includes("is above the plugin's folder"), existsSync(mark)]).toEqual([false, true, false]);
    // A node_modules holding Clover's shared packages is the exception.
    expect(() => guardedPluginEnv({ PATH: "/bin" }, { pluginRoot: root, files, shared: [join(base, "node_modules", "zod")] })).not.toThrow();
    // Gone, the plugin starts.
    rmSync(join(base, "node_modules"), { recursive: true });
    expect(() => guardedPluginEnv({ PATH: "/bin" }, { pluginRoot: root, files, shared: [] })).not.toThrow();
  }, 30_000);

  // #289: a Bun macro runs its module while the importing file is transpiled. --no-macros holds a process's main thread
  // only (a Worker runs one whatever the process was started with, measured on Bun 1.4.4), so the guard refuses a
  // macro's module in every thread. Each case runs once unguarded as the control: the macro runs.
  test("a Bun macro never runs in a plugin process, in its main thread or a worker", () => {
    const mark = join(w.base, "mark");
    const root = w.plugin("macro", {
      "host/mac.ts": `import { writeFileSync } from "node:fs";\nexport function leak(): string { writeFileSync(${JSON.stringify(mark)}, "ran"); return "x"; }\n`,
      "host/index.ts": "import { leak } from \"./mac.ts\" with { type: \"macro\" };\nconsole.log(\"value\", leak());\n",
      "host/worker.ts": settle + "const w = new Worker(new URL(\"./index.ts\", import.meta.url).href);\nconst e = await settle(w);\nconsole.log(\"worker ended:\", e?.message ?? e?.type);\n",
    });
    for (const entry of ["host/index.ts", "host/worker.ts"]) {
      expect([entry, w.run(root, entry, false).ran]).toEqual([entry, true]);
      const guarded = w.run(root, entry, true);
      expect([entry, guarded.ran, /Macros are disabled|a Bun macro/.test(guarded.stderr + guarded.stdout)]).toEqual([entry, false, true]);
    }
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

// #322's review, B1: host mode was an environment variable, which a plugin's MCP server could set in its manifest's env.
// Now nothing a plugin's env says changes what its process is: Clover's names are refused in a manifest's env and
// dropped from every base, and the host's guard is a file of its own that only the daemon's launch names.
describe("a plugin's environment never turns off its guard", () => {
  const w = world();
  const CLOVER_NAMES = ["CLOVER_PLUGIN_HOST", "CLOVER_PLUGIN_ROOT", "CLOVER_PLUGIN_SHARED", "CLOVER_PLUGIN_WORKER"] as const;
  const attack = (outside: string): Record<string, string> => ({
    CLOVER_PLUGIN_HOST: "1", CLOVER_PLUGIN_ROOT: "/", CLOVER_PLUGIN_SHARED: JSON.stringify(["/", outside]), CLOVER_PLUGIN_WORKER: join(outside, "evil.ts"),
  });

  test("a manifest's MCP server env naming each of Clover's variables, or Bun's, Node's or the loader's, is refused by name", () => {
    const root = w.plugin("mcp-env", { "server.ts": "console.log(\"server ran\");\n" });
    const guard = { files: w.files, shared: [] };
    for (const name of [...CLOVER_NAMES, "CLOVER_ANYTHING", "BUN_INSTALL", "NODE_OPTIONS", "NODE_PATH", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES"]) {
      expect(() => guardedMcpServer({ command: "bun", args: ["server.ts"], env: { [name]: "1" } }, root, guard)).toThrow(`sets ${name} in its environment, which only Clover sets`);
      expect(() => guardedMcpServer({ command: "sh", args: ["-c", "bun server.ts"], env: { OK: "1", [name]: "1" } }, root, guard)).toThrow(name);
    }
    // Without case too: Windows' names are case-insensitive, and a manifest runs everywhere.
    expect(() => guardedMcpServer({ command: "bun", args: ["server.ts"], env: { clover_plugin_host: "1" } }, root, guard)).toThrow("clover_plugin_host");
    expect(envWithoutDropped({ Path: "a", PATH: "b", node_options: "x", Clover_Plugin_Host: "1", Home: "h" }, "win32")).toEqual({ PATH: "b", HOME: "h" });
    expect(envWithoutDropped({ Path: "a", PATH: "b", node_options: "x" }, "darwin")).toEqual({ Path: "a", PATH: "b", node_options: "x" });
    expect([droppedEnv("win32").test("node_options"), droppedEnv("win32").test("Clover_Plugin_Root"), droppedEnv("darwin").test("node_options"), droppedEnv("darwin").test("NODE_OPTIONS")]).toEqual([true, true, false, true]);
    // What loads nothing stays the plugin's.
    const ok = guardedMcpServer({ command: "bun", args: ["server.ts"], env: { NODE_ENV: "production", NODE_NO_WARNINGS: "1", MY_TOKEN: "t" } }, root, guard);
    expect([ok.env?.NODE_ENV, ok.env?.NODE_NO_WARNINGS, ok.env?.MY_TOKEN]).toEqual(["production", "1", "t"]);
  });

  test("the reviewer's case: an MCP server with CLOVER_PLUGIN_HOST=1 importing a file outside its folder is refused, and still guarded if its env got through", () => {
    const outside = join(w.base, "outside");
    const root = w.plugin("mcp-host", { "server.ts": "import \"$OUTSIDE/evil.ts\";\nconsole.log(\"server ran\");\n" });
    const guard = { files: w.files, shared: [] };
    expect(() => pluginStdioMcpServer({ command: "bun", args: ["server.ts"], env: { CLOVER_PLUGIN_HOST: "1" } }, root, guard)).toThrow("CLOVER_PLUGIN_HOST");
    // Through every other door (a hook's or a supervised host's base, the daemon's own environment): dropped, then set by
    // Clover alone.
    const env = guardedPluginEnv({ ...process.env, NODE_ENV: undefined, ...attack(outside) }, { pluginRoot: root, files: w.files, shared: [] });
    expect([env.CLOVER_PLUGIN_HOST, env.CLOVER_PLUGIN_WORKER, env.CLOVER_PLUGIN_ROOT, env.CLOVER_PLUGIN_SHARED]).toEqual([undefined, undefined, realpathSync(root), "[]"]);
    expect(w.run(root, "server.ts", true)).toMatchObject({ ran: false });
    // And were CLOVER_PLUGIN_HOST to reach a plugin process anyway, it's no host: the guard holds it to its folder.
    rmSync(join(w.base, "mark"), { force: true });
    const forced = Bun.spawnSync([process.execPath, "server.ts"], { cwd: root, env: { ...env, CLOVER_PLUGIN_HOST: "1" }, stdout: "pipe", stderr: "pipe" });
    expect([existsSync(join(w.base, "mark")), forced.stdout.toString().includes("server ran"), forced.stderr.toString()]).toEqual([false, false, expect.stringContaining("outside the plugin's own folder")]);
  }, 30_000);

  test("the host's guard named in a plugin process's own arguments: the process doesn't run, in either order", () => {
    const root = w.plugin("args-host", { "server.ts": "import \"$OUTSIDE/evil.ts\";\nconsole.log(\"server ran\");\n" });
    const env = guardedPluginEnv({ ...process.env, NODE_ENV: undefined }, { pluginRoot: root, files: w.files, shared: [] });
    // Even with the entry the host's guard asks for (a file standing in for the host bundle, beside it), a plugin process
    // whose own arguments name the host's guard runs two guards, and the second refuses.
    const hostEntry = join(dirname(w.files.hostGuard), "plugin-host.js");
    writeFileSync(hostEntry, `import ${JSON.stringify(join(w.base, "outside", "evil.ts"))};\nconsole.log("server ran");\n`);
    try {
      for (const args of [[`--preload=${w.files.hostGuard}`, hostEntry], ["--preload", w.files.hostGuard, hostEntry]]) {
        rmSync(join(w.base, "mark"), { force: true });
        const r = Bun.spawnSync([process.execPath, ...args], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
        expect([existsSync(join(w.base, "mark")), r.stdout.toString().includes("server ran"), r.stderr.toString()]).toEqual([false, false, expect.stringContaining("a thread runs one load guard")]);
      }
    } finally {
      rmSync(hostEntry, { force: true });
    }
    // The host's guard alone (no plugin flags), over an entry that isn't the host bundle beside it: refused.
    rmSync(join(w.base, "mark"), { force: true });
    const alone = Bun.spawnSync([process.execPath, ...pluginHostBunFlags(w.files), "server.ts"], { cwd: root, env: { ...env, BUN_OPTIONS: "" }, stdout: "pipe", stderr: "pipe" });
    expect([existsSync(join(w.base, "mark")), alone.stderr.toString()]).toEqual([false, expect.stringContaining("runs only the plugin host")]);
    // Its guard file is the host's: the plugin guard, with the plugin flags, for each worker it starts.
    const text = readFileSync(w.files.hostGuard, "utf8");
    expect([text.includes(JSON.stringify(w.files.guard)), text.includes(JSON.stringify(pluginBunFlags(w.files).join(" ")))]).toEqual([true, true]);
  }, 30_000);
});
