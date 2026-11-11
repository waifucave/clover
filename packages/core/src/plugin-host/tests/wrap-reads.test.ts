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
import { CARD_LINE_MAX, cardLines } from "../../registry/ok-cards";
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
  test("a script's own folder; up to its project only each level's node_modules and package.json; a flag's value; nothing outside the home, in an install the fence reads, or not there", () => {
    const h = homes();
    const tool = h.file("tools/server.js");
    h.file("code/monorepo/package.json", "{}");
    h.file("code/monorepo/.git/config");
    h.file("code/monorepo/.env", "SECRET=1");
    h.file("code/monorepo/node_modules/dep/index.js");
    h.file("code/monorepo/packages/mcp/package.json", "{}");
    const built = h.file("code/monorepo/packages/mcp/dist/index.js");
    const flagged = h.file("other/conf.json");
    const nvm = h.file(".nvm/versions/node/v22/bin/node");
    const got = wrapReads({ command: nvm, args: [tool, built, `--config=${flagged}`, "/usr/bin/true", join(h.user, "missing.js"), "relative.js"] }, h);
    // The built script's own folder, then its package's package.json (the marker stops the walk there): never the
    // monorepo, its .git or its .env.
    expect(got).toEqual({ reads: [join(h.user, "tools"), join(h.user, "code/monorepo/packages/mcp/dist"), join(h.user, "code/monorepo/packages/mcp/package.json"), join(h.user, "other")], unreadable: [] });
    // With no marker in between, the walk takes each level's node_modules up to the project.
    const deep = h.file("code/monorepo/tools/x.js");
    expect(wrapReads({ command: "node", args: [deep] }, h).reads).toEqual([join(h.user, "code/monorepo/tools"), join(h.user, "code/monorepo/node_modules"), join(h.user, "code/monorepo/package.json")]);
    // One folder inside another: only the outer one.
    const inner = h.file("tools/lib/helper.js");
    expect(wrapReads({ command: "node", args: [inner, tool] }, h).reads).toEqual([join(h.user, "tools")]);
  });

  test("a Python virtual environment's interpreter opens that environment; a .git folder or .env file named is refused", () => {
    const h = homes();
    h.file("proj/.venv/pyvenv.cfg", "home = /usr/bin");
    const py = h.file("proj/.venv/bin/python3");
    const script = h.file("scripts/server.py");
    expect(wrapReads({ command: py, args: [script] }, h).reads).toEqual([join(h.user, "proj/.venv"), join(h.user, "scripts")]);
    const env = h.file("proj/.env.local");
    const git = h.file("proj/.git/hooks/run.js");
    expect(wrapReads({ command: "node", args: [env, git] }, h).unreadable.map((u) => u.why)).toEqual(["it is a .git folder or an .env file, which no plugin reads", "it is a .git folder or an .env file, which no plugin reads"]);
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

  test("at each start the record is checked again: a folder now refused, gone, or become a link is left out; only the top plugin's", () => {
    const h = homes();
    const ok = join(h.user, "tools");
    mkdirSync(ok, { recursive: true });
    const pkg = h.file("code/package.json", "{}");
    const swapped = join(h.user, "code", "tools");
    mkdirSync(join(h.user, "Documents", "taxes"), { recursive: true });
    symlinkSync(join(h.user, "Documents", "taxes"), swapped);
    const record = (reads: string[]) => ({ get: (id: string) => (id === "mcp-x" ? ({ id, provenance: { by: "user-app", at: 0, wrapped: { from: "mcp-config", reads } } } as never) : undefined) });
    expect(wrapperReads(record([ok, pkg, swapped, h.user, join(h.user, ".ssh"), join(h.user, "gone"), join(h.user, "code/.env")]), "mcp-x", h)).toEqual([ok, pkg]);
    expect(wrapperReads(record([ok]), "mcp-x/child", h)).toEqual([]);
  });

  test("the OK names what it reads, and what it can't with how to fix it", () => {
    const lines = wrappedLines({ from: "mcp-config", network: "any", reads: ["/Users/me/tools"], unreadable: ["/Users/me/server.js"] });
    expect(lines.join("\n")).toContain("It will read: /Users/me/tools (never a .git folder or an .env file in them). Its config runs a program there; it reads it, never writes it.");
    expect(lines.join("\n")).toContain("It can't read /Users/me/server.js, so its server may not start");
    expect(lines.join("\n")).toContain("Move the program into a folder of its own and paste the config again. If its server needs a folder beside its own, its log says which.");
    // A name that hides or reorders text shows each such character as an escape.
    const tricky = wrappedLines({ from: "mcp-config", reads: ["/Users/me/tools\u202Egpj.exe\nx"] }).join("\n");
    expect(tricky).toContain("/Users/me/tools\\u{202E}gpj.exe\\nx");
    expect(tricky).not.toContain("\u202E");
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
      // A whole command line longer than its card shows whole: refused at the paste, with why.
      const huge = JSON.stringify({ huge: { command: "node", args: [long, long, long] } });
      expect(await m["plugin.install"]!({ source: { from: "wrap", kind: "mcp-config", value: huge } }, APP).then(() => "installed", (e: Error) => e.message)).toContain("its OK card shows a command whole");
      const tooLong = JSON.stringify({ more: { command: "node", args: [`${long}x`] } });
      expect(await m["plugin.install"]!({ source: { from: "wrap", kind: "mcp-config", value: tooLong } }, APP).then(() => "installed", (e: Error) => e.message)).toContain("put a longer script in a file");
    } finally {
      opened.close();
    }
  });
});

describe("a long command on its OK card", () => {
  test("an npx server with a 5,000-character argument: the card shows it whole, split across lines with a count, none over the card's limit", async () => {
    const h = homes();
    const clover = temp("clover-wrapr-npx-");
    const broker = new FakeApprovalBroker({ clock: new FakeClock() });
    const opened = await openPluginRegistry({ cloverHome: clover, os: "macos", broker, secrets: new MemorySecretStore(), settleMs: 50 });
    const m = pluginRegistryMethods({ opened, host: { restart: async () => {} }, home: clover, userHome: h.user });
    try {
      const arg = `--prompt=${"word ".repeat(1_000)}end`;
      const config = JSON.stringify({ mcpServers: { thing: { command: "npx", args: ["-y", "@example/mcp-thing", arg] } } });
      await m["plugin.install"]!({ source: { from: "wrap", kind: "mcp-config", value: config } }, APP);
      const card = broker.cards().find((c) => c.kind === "plugin-ok")!;
      const items = (card.fields.what as { items: string[] }).items;
      for (const i of items) expect(i.length).toBeLessThanOrEqual(CARD_LINE_MAX);
      const parts = items.filter((i) => i.includes("It fetches code when it runs") || /^\(\d+ of \d+\) /.test(i));
      expect(parts.length).toBeGreaterThan(1);
      expect(parts[0]).toMatch(/\(1 of \d+, continued below\)$/);
      // Put back together, nothing is missing.
      const whole = parts.map((p) => p.replace(/^\(\d+ of \d+\) /, "").replace(/ \((1 of \d+, )?continued below\)$/, "")).join("");
      expect(whole).toContain(`npx -y @example/mcp-thing ${arg}`);
    } finally {
      opened.close();
    }
  });

  test("cardLines: short lines as they are; more lines than a card holds is refused, with why", () => {
    expect(cardLines(["a", "b"])).toEqual(["a", "b"]);
    expect(() => cardLines(Array.from({ length: 201 }, () => "x"))).toThrow("more than a card shows");
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
    // Inside what is opened, never a .git folder or an .env file.
    const env = h.file("tools/.env.local", "K=1");
    const git = h.file("tools/sub/.git/config", "[remote]");
    const kept = h.file("tools/.envrc-not", "x");
    expect(run([join(h.user, "tools")], probe(env))).toBe("read=denied\nwrite=denied");
    expect(run([join(h.user, "tools")], probe(git))).toBe("read=denied\nwrite=denied");
    expect(run([join(h.user, "tools")], probe(kept))).toBe("read=ok\nwrite=denied");
  });
});
