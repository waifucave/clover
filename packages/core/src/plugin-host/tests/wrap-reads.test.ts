// A pasted MCP config's own files (wrap-reads.ts, the controller's ruling on acceptance step 31's finding B): the
// folders its stdio server's script lives in are opened to it read-only, on its install record, named on its OK; never
// the home, a big folder whole, a secret place or the Clover home; re-checked at each start; real under the fence.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginDetail } from "@waifucave/clover-protocol";
import { darwinDescribe } from "../../../test/helpers/darwin-only";
import { FakeApprovalBroker } from "../../contracts/fakes/approval-broker";
import { FakeClock } from "../../contracts/fakes/clock";
import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import { wrappedLines } from "../../registry/folders";
import { openPluginRegistry } from "../../registry/open";
import { fencedCommand, toolFence } from "../../registry/plugin-fence";
import { ensurePluginRunFiles } from "../../registry/plugin-run";
import { MCP_ARG_MAX } from "../../registry/wrap";
import { wrapReadRefused, wrapReads, wrapperReads, type WrapHomes } from "../../registry/wrap-reads";
import { pluginRegistryMethods } from "../registry-methods";

const temps: string[] = [];
const temp = (prefix: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(d);
  return d;
};
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});
const APP = { caller: { kind: "user", client: "app" } } as never;

/** A temp user home with a few of a real one's places, and a Clover home inside it. */
function homes(): WrapHomes & { file(rel: string, text?: string): string } {
  const user = temp("clover-wrapr-user-");
  const clover = join(user, ".clover");
  mkdirSync(clover, { recursive: true });
  const file = (rel: string, text = "x") => {
    const p = join(user, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, text);
    return p;
  };
  return { user, clover, os: "macos", file };
}

describe("which folders a pasted server's files open", () => {
  test("a script's folder, or its project's (the nearest marker above it); a flag's value; nothing for a path outside the home, an install the fence reads, or no file", () => {
    const h = homes();
    const tool = h.file("tools/server.js");
    h.file("work/mcp-thing/package.json", "{}");
    const built = h.file("work/mcp-thing/dist/index.js");
    const flagged = h.file("other/conf.json");
    const nvm = h.file(".nvm/versions/node/v22/bin/node");
    const got = wrapReads({ command: nvm, args: [tool, built, `--config=${flagged}`, "/usr/bin/true", join(h.user, "missing.js"), "relative.js"] }, h);
    expect(got).toEqual({ reads: [join(h.user, "tools"), join(h.user, "work/mcp-thing"), join(h.user, "other")], unreadable: [] });
    // One folder inside another: only the outer one.
    const inner = h.file("tools/lib/helper.js");
    expect(wrapReads({ command: "node", args: [inner, tool] }, h).reads).toEqual([join(h.user, "tools")]);
  });

  test("never the home, a big folder whole, a secret place, Clover's home; a walk up stops below the first it may not open", () => {
    const h = homes();
    const atHome = h.file("server.js");
    const inDocs = h.file("Documents/server.js");
    const inSsh = h.file(".ssh/agent.js");
    const inClover = h.file(".clover/plugins/x/run.js");
    const deep = h.file("Documents/proj/src/index.js");
    // A marker at the home itself must not pull the walk up to it.
    h.file("package.json", "{}");
    const got = wrapReads({ command: "node", args: [atHome, inDocs, inSsh, inClover, deep] }, h);
    expect(got.reads).toEqual([join(h.user, "Documents/proj/src")]);
    expect(got.unreadable).toEqual([
      { path: atHome, why: "it is your home folder or holds it" },
      { path: inDocs, why: "it is your whole Documents folder" },
      { path: inSsh, why: "it is inside a place that keeps keys or sign-ins" },
      { path: inClover, why: "it is Clover's own folder or holds it" },
    ]);
    // A folder holding a secret place (the Library's Application Support, which holds the browsers' profiles).
    expect(wrapReadRefused(join(h.user, "Library/Application Support"), h)).toBe("it holds a place that keeps keys or sign-ins");
    expect(wrapReadRefused(join(h.user, "Library"), h)).toBe("it is your whole Library folder");
  });

  test("a link is judged where it leads: one into a secret place opens nothing", () => {
    const h = homes();
    const key = h.file(".aws/run.js");
    mkdirSync(join(h.user, "innocent"), { recursive: true });
    symlinkSync(join(h.user, ".aws"), join(h.user, "innocent", "aws"));
    const got = wrapReads({ command: "node", args: [join(h.user, "innocent", "aws", "run.js")] }, h);
    expect(got.reads).toEqual([]);
    expect(got.unreadable.map((u) => u.why)).toEqual(["it is inside a place that keeps keys or sign-ins"]);
    expect(key).toBeTruthy();
  });

  test("at each start the record is checked again: a folder now refused, or gone, is left out; only the top plugin's", () => {
    const h = homes();
    const ok = join(h.user, "tools");
    mkdirSync(ok, { recursive: true });
    const record = (reads: string[]) => ({ get: (id: string) => (id === "mcp-x" ? ({ id, provenance: { by: "user-app", at: 0, wrapped: { from: "mcp-config", reads } } } as never) : undefined) });
    expect(wrapperReads(record([ok, h.user, join(h.user, ".ssh"), join(h.user, "gone")]), "mcp-x", h)).toEqual([ok]);
    expect(wrapperReads(record([ok]), "mcp-x/child", h)).toEqual([]);
  });

  test("the OK names what it reads, and what it can't with how to fix it", () => {
    const lines = wrappedLines({ from: "mcp-config", network: "any", reads: ["/Users/me/tools"], unreadable: ["/Users/me/server.js"] });
    expect(lines.join("\n")).toContain("It will read: /Users/me/tools. Its config runs a program there; it reads it, never writes it.");
    expect(lines.join("\n")).toContain("It can't read /Users/me/server.js, so its server may not start");
    expect(lines.join("\n")).toContain("Move the program into a folder of its own and paste the config again.");
  });
});

describe("pasting a config", () => {
  test("its install record holds what it reads and what it can't; an argument up to MCP_ARG_MAX characters is kept", async () => {
    const h = homes();
    const clover = temp("clover-wrapr-");
    const tool = h.file("tools/server.js");
    const atHome = h.file("loose.js");
    const opened = await openPluginRegistry({ cloverHome: clover, os: "macos", broker: new FakeApprovalBroker({ clock: new FakeClock() }), secrets: new MemorySecretStore(), settleMs: 50 });
    const m = pluginRegistryMethods({ opened, host: { restart: async () => {} }, home: clover, userHome: h.user });
    try {
      const long = "x".repeat(MCP_ARG_MAX);
      const config = JSON.stringify({ mcpServers: { tools: { command: "node", args: [tool, atHome, "--inline", long] } } });
      const r = (await m["plugin.install"]!({ source: { from: "wrap", kind: "mcp-config", value: config } }, APP)) as { id: string };
      const detail = PluginDetail.parse(((await m["plugin.get"]!({ id: r.id }, APP)) as { plugin: unknown }).plugin);
      expect(detail.provenance.wrapped).toEqual({ from: "mcp-config", network: "any", reads: [join(h.user, "tools")], unreadable: [atHome] });
      const tooLong = JSON.stringify({ more: { command: "node", args: [`${long}x`] } });
      expect(await m["plugin.install"]!({ source: { from: "wrap", kind: "mcp-config", value: tooLong } }, APP).then(() => "installed", (e: Error) => e.message)).toContain("put a longer script in a file");
    } finally {
      opened.close();
    }
  });
});

darwinDescribe("under the fence", () => {
  test("the opened folder is read and never written; a folder next to it stays closed", () => {
    const h = homes();
    const clover = temp("clover-wrapr-c-");
    const files = ensurePluginRunFiles(join(clover, "run", "plugin-host"), { cloverHome: clover });
    const tool = h.file("tools/server.js", "console.log('hi')");
    const other = h.file("private/notes.txt", "mine");
    const root = join(clover, "plugins", "mcp-tools");
    mkdirSync(root, { recursive: true });
    const run = (reads: string[], script: string) => {
      const { fence } = toolFence({ files, shared: [], pluginRoot: root, pluginId: "mcp-tools", userHome: h.user, name: "test-mcp-tools", reads });
      return Bun.spawnSync(fencedCommand(["/bin/sh", "-c", script], fence), { stdout: "pipe", stderr: "pipe" }).stdout.toString().trim();
    };
    const probe = (p: string) => `cat ${JSON.stringify(p)} >/dev/null 2>&1 && echo read=ok || echo read=denied; (echo x >> ${JSON.stringify(p)}) 2>/dev/null && echo write=ok || echo write=denied`;
    expect(run([], probe(tool))).toBe("read=denied\nwrite=denied");
    expect(run([join(h.user, "tools")], probe(tool))).toBe("read=ok\nwrite=denied");
    expect(run([join(h.user, "tools")], probe(other))).toBe("read=denied\nwrite=denied");
  });
});
