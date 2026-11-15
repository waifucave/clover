// What a host half's `api` has, read in a real plugin host (its process, its worker, its fence where the OS has one),
// never only in the contracts' fake: `api.storage.dataFolder` is the plugin's own folder, made before it starts, and
// its code writes there from `start`, in a worker of the shared process and in a process of its own; and every member
// the SDK's catalog lists for host code is there to read, and calling it never answers that it doesn't exist.
// (Try 14c: a bot-built plugin, `host.process: "own"`, crashed three times at start on `api.storage.dataFolder doesn't
// exist in the plugin API`: the proxy answered the catalog's calls only, and the folder is data, not a call.)
// Temp home, the fake approval broker and an in-memory secret store; nothing opens a window.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API_CALLS, PLUGIN_API_VERSION } from "@waifucave/clover-plugin-sdk";
import type { Caller } from "@waifucave/clover-protocol";
import { FakeApprovalBroker } from "../../contracts/fakes/approval-broker";
import { FakeClock } from "../../contracts/fakes/clock";
import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import { openPluginRegistry } from "../../registry/open";
import { startPluginHost } from "../daemon-host";

const temps: string[] = [];
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

const USER: Caller = { kind: "user", client: "app" };

/** Every call the catalog lists for host code and serves (not a component's alone, not `notYet`). */
const HOST_CALLS = (Object.entries(API_CALLS) as [string, { where: string; notYet?: string }][])
  .filter(([, info]) => info.where !== "ui" && info.notYet === undefined)
  .map(([call]) => call);
/** Calls that wait on the user (a sealed card): read, never called here. */
const WAITS_ON_THE_USER = new Set(["confirm", "confirmCard"]);

/** A host half that writes in its data folder from `start`, and reads and calls what it is asked to. */
const HOST_JS = [
  "import { readFileSync, writeFileSync } from \"node:fs\";",
  "import { join } from \"node:path\";",
  "let atStart;",
  "export async function start(api) {",
  "  atStart = api.storage.dataFolder;",
  "  writeFileSync(join(atStart, \"started.txt\"), \"started in \" + api.plugin.id);",
  "}",
  "export const folder = async (args, ctx) => ({",
  "  atStart, now: ctx.api.storage.dataFolder, has: \"dataFolder\" in ctx.api.storage,",
  "  file: readFileSync(join(atStart, \"started.txt\"), \"utf8\"),",
  "});",
  "const walk = (api, path) => path.split(\".\").reduce((o, k) => o[k], api);",
  "export const audit = async (args, ctx) => {",
  "  const missing = [];",
  "  const answers = {};",
  "  for (const path of args.read) {",
  "    try { const v = walk(ctx.api, path); if (typeof v !== \"function\") missing.push(path + \": \" + typeof v); }",
  "    catch (e) { missing.push(path + \": \" + e.message); }",
  "  }",
  "  await Promise.all(args.call.map(async (path) => {",
  "    const parent = path.split(\".\").slice(0, -1).join(\".\");",
  "    const fn = walk(ctx.api, path);",
  "    const watchLike = /(^|\\.)(watch|on[A-Z][a-zA-Z]*)$/.test(path);",
  "    try {",
  "      const out = fn.call(parent === \"\" ? ctx.api : walk(ctx.api, parent), ...(watchLike ? [() => {}] : []));",
  "      if (typeof out === \"function\") { out(); answers[path] = \"unsubscribe\"; return; }",
  "      await Promise.race([Promise.resolve(out), new Promise((r) => setTimeout(r, 3000))]);",
  "      answers[path] = \"answered\";",
  "    } catch (e) { answers[path] = (e && e.code ? e.code + \": \" : \"\") + (e && e.message ? e.message : String(e)); }",
  "  }));",
  "  return { missing, answers };",
  "};",
  "",
].join("\n");

function plugin(home: string, id: string, process?: "own"): string {
  const folder = join(home, "plugins", id);
  mkdirSync(join(folder, "host"), { recursive: true });
  writeFileSync(join(folder, "clover.json"), JSON.stringify({
    manifest: 1, id, name: id, version: "1.0.0", engines: { clover: `^${PLUGIN_API_VERSION}` },
    host: { entry: "host/index.js", ...(process === undefined ? {} : { process }) }, capabilities: ["files"],
  }));
  writeFileSync(join(folder, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(join(folder, "host", "index.js"), HOST_JS);
  return folder;
}

describe("a host half's api in a real plugin host", () => {
  test("api.storage.dataFolder is its own folder, written from start, in a shared worker and in a process of its own; every host call the catalog lists is there", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "clover-b-api-truth-")));
    temps.push(home);
    plugin(home, "shared-one");
    plugin(home, "own-one", "own");
    const broker = new FakeApprovalBroker({ clock: new FakeClock() });
    const secrets = new MemorySecretStore();
    const opened = await openPluginRegistry({ cloverHome: home, os: "macos", broker, secrets, settleMs: 50 });
    const lines: string[] = [];
    const ph = await startPluginHost({ home, computer: "Studio", registry: opened.registry, secrets, userHome: join(home, "user"), log: (l) => lines.push(l) });
    try {
      for (const id of ["shared-one", "own-one"]) {
        const { card } = await opened.registry.installed(id, "app");
        const shown = broker.cards().find((c) => c.id === card)!;
        await broker.answer(card!, { optionId: "approve", hash: shown.hash, proof: { via: "sealed-frame", frame: broker.frameChannel(card!)!, input: "click", at: Date.now() } }, { role: "app" });
      }
      const until = async (id: string) => {
        const end = Date.now() + 10_000;
        while (opened.registry.get(id)?.state !== "running" && Date.now() < end) await Bun.sleep(25);
        expect(opened.registry.get(id)?.state).toBe("running");
      };
      await until("shared-one");
      await until("own-one");

      for (const id of ["shared-one", "own-one"]) {
        const data = join(home, "plugin-data", id);
        const r = await ph.host.invoke({ pluginId: id, handler: "folder", args: null, caller: USER }).catch((err: unknown) => {
          throw new Error(`${id}: ${(err as Error).message}; log ${lines.join(" | ")}`);
        });
        expect(r).toEqual({ atStart: data, now: data, has: true, file: `started in ${id}` });
        expect(existsSync(join(data, "started.txt"))).toBe(true);
        expect(readFileSync(join(data, "started.txt"), "utf8")).toBe(`started in ${id}`);

        const audit = (await ph.host.invoke({
          pluginId: id, handler: "audit", caller: USER,
          args: { read: HOST_CALLS, call: HOST_CALLS.filter((c) => !WAITS_ON_THE_USER.has(c)) },
        })) as { missing: string[]; answers: Record<string, string> };
        // Each is there to read, as a call.
        expect(audit.missing).toEqual([]);
        // Called with nothing, each answers, or refuses for its own reasons (a capability, its arguments, its
        // process): never that the member doesn't exist in the plugin API or isn't available yet. (Which handler
        // serves each is host-calls-served.test.ts's: the areas' handlers, `files.*` among them, are the daemon's to
        // compose, and this host has none, so those answer "not served on this computer" here.)
        const absent = Object.entries(audit.answers).filter(([, a]) => /doesn't exist|isn't available/i.test(a));
        expect(absent).toEqual([]);
        expect(Object.keys(audit.answers).length).toBe(HOST_CALLS.length - WAITS_ON_THE_USER.size);
      }
    } finally {
      await ph.close();
    }
  }, 60_000);
});
