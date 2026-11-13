// Row 2.31: `files.*` from a plugin's host half, through `areas` in a real plugin host over a real computer node (lane
// J's folder tree, the cluster support's computer): with `files` it reads, writes, lists, globs and greps inside the
// folders the tree gives it, acting as the plugin whoever asked; it is refused Clover's own folder and anything outside
// the tree; without `files` it has none of it. Temp homes, the fake approval broker; nothing opens a window.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLUGIN_API_VERSION } from "@waifucave/clover-plugin-sdk";
import type { Caller } from "@waifucave/clover-protocol";
import { Cluster } from "../../../test/tree/cluster-support";
import { FakeApprovalBroker } from "../../contracts/fakes/approval-broker";
import { FakeClock } from "../../contracts/fakes/clock";
import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import { openPluginRegistry } from "../../registry/open";
import { startPluginHost } from "../daemon-host";

const temps: string[] = [];
let cluster: Cluster | undefined;
afterAll(() => { cluster?.close(); for (const d of temps) rmSync(d, { recursive: true, force: true }); });
const USER: Caller = { kind: "user", client: "app" };

const HOST_JS = `
const plain = (v) => (v === undefined ? "undefined" : v instanceof Uint8Array ? "bytes:" + v.length : v);
export const call = async (args, ctx) => {
  const fn = ctx.api.files?.[args.member];
  if (typeof fn !== "function") return { absent: true };
  try { return { value: plain(await fn(...args.args)) }; } catch (e) { return { error: (e.code ? e.code + ": " : "") + e.message }; }
};
`;

function plugin(home: string, id: string, capabilities: string[]): void {
  const folder = join(home, "plugins", id);
  mkdirSync(join(folder, "host"), { recursive: true });
  writeFileSync(join(folder, "clover.json"), JSON.stringify({ manifest: 1, id, name: id, version: "1.0.0", engines: { clover: `^${PLUGIN_API_VERSION}` }, host: { entry: "host/index.js" }, capabilities }));
  writeFileSync(join(folder, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(join(folder, "host", "index.js"), HOST_JS);
}

describe("files.* from a host half (row 2.31)", () => {
  test("with files: stat, read, write, list, glob and grep in the tree's folders, as the plugin; Clover's folder and outside the tree refused; without files, nothing", async () => {
    cluster = new Cluster();
    const studio = await cluster.add("Studio");
    await cluster.join();
    mkdirSync(join(studio.home, "proj", "src"), { recursive: true });
    writeFileSync(join(studio.home, "proj", "src", "a.ts"), "export const answer = 42;\n");
    const home = realpathSync(mkdtempSync(join(tmpdir(), "clover-a-files-")));
    temps.push(home);
    plugin(home, "editor", ["files"]);
    plugin(home, "plain", []);
    const broker = new FakeApprovalBroker({ clock: new FakeClock() });
    const secrets = new MemorySecretStore();
    const opened = await openPluginRegistry({ cloverHome: home, os: "macos", broker, secrets, settleMs: 50 });
    const ph = await startPluginHost({ home, computer: "Studio", registry: opened.registry, secrets, fence: false, areas: { bots: () => undefined, node: () => studio.node, links: () => undefined } });
    try {
      for (const id of ["editor", "plain"]) {
        const { card } = await opened.registry.installed(id, "app");
        const shown = broker.cards().find((c) => c.id === card)!;
        await broker.answer(card!, { optionId: "approve", hash: shown.hash, proof: { via: "sealed-frame", frame: broker.frameChannel(card!)!, input: "click", at: Date.now() } }, { role: "app" });
        for (let i = 0; i < 200 && opened.registry.get(id)?.state === "found"; i++) await Bun.sleep(20);
      }
      const call = <R>(id: string, member: string, ...args: unknown[]) => ph.host.invoke<R>({ pluginId: id, handler: "call", args: { member, args }, caller: USER });
      const p = "home/Studio/proj";
      expect(await call("editor", "stat", `${p}/src/a.ts`)).toEqual({ value: expect.objectContaining({ type: "file" }) });
      expect(await call("editor", "readText", `${p}/src/a.ts`)).toEqual({ value: "export const answer = 42;\n" });
      expect(await call("editor", "readBytes", `${p}/src/a.ts`)).toEqual({ value: "bytes:26" });
      expect((await call<{ value?: unknown; error?: string }>("editor", "write", `${p}/notes.md`, "written by the plugin\n")).error).toBeUndefined();
      expect(readFileSync(join(studio.home, "proj", "notes.md"), "utf8")).toBe("written by the plugin\n");
      const listed = await call<{ value: { path: string; type: string }[] }>("editor", "list", p);
      expect(listed.value.map((e) => [e.path, e.type]).sort()).toEqual([[`${p}/notes.md`, "file"], [`${p}/src`, "dir"]]);
      expect(await call("editor", "glob", "**/*.ts", { cwd: p })).toEqual({ value: { paths: [`${p}/src/a.ts`], truncated: false } });
      const grepped = await call<{ value: unknown }>("editor", "grep", "answer", { cwd: p });
      expect(JSON.stringify(grepped.value)).toContain("a.ts");
      // Clover's own folder on that computer, and a path outside the tree: refused, nothing read or written.
      expect(await call("editor", "readText", "home/Studio/.clover/run/x")).toEqual({ error: expect.stringMatching(/^fenced: /) });
      expect(await call("editor", "write", "home/Studio/.clover/planted", "x")).toEqual({ error: expect.stringMatching(/^fenced: /) });
      expect(existsSync(join(studio.home, ".clover", "planted"))).toBe(false);
      for (const outside of ["/etc/hosts", "home/Studio/../../etc/hosts", "elsewhere/x"]) {
        expect(await call("editor", "readText", outside)).toEqual({ error: expect.stringMatching(/^invalid: .* isn't in the folder tree/) });
      }
      // Without `files`: none of it.
      for (const m of ["stat", "readText", "write", "list", "glob", "grep"]) {
        const out = await call<{ absent?: true; error?: string }>("plain", m, `${p}/src/a.ts`, "x");
        expect(out.absent === true || /^refused: files\.\w+ needs the capability files/.test(out.error ?? "")).toBe(true);
      }
      expect(readFileSync(join(studio.home, "proj", "src", "a.ts"), "utf8")).toBe("export const answer = 42;\n");
    } finally {
      await ph.close();
      opened.close();
    }
  }, 120_000);
});
