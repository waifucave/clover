// A child plugin of a bot-built tree (`<parent>/<folder>`, spec §5.1) contributes like any plugin: over the real plugin
// registry, the real plugin host (a process and worker per host half) and the bots' MCP door, its MCP tool is listed to
// the bot and callable, its hook runs on its event, its `ui` entry is an active entry the spot catalog knows, and its
// host handler answers a call under its own id. Temp home, the fake approval broker, an in-memory secret store; nothing
// opens a window. (Row 28 of lane B's plugins checklist: only a child's crash and PluginStatus were tested before.)
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PLUGIN_API_VERSION, spotInfo } from "@waifucave/clover-plugin-sdk";
import type { Caller } from "@waifucave/clover-protocol";
import { FakeApprovalBroker } from "../../contracts/fakes/approval-broker";
import { FakeClock } from "../../contracts/fakes/clock";
import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import { openPluginRegistry } from "../../registry/open";
import { pluginHooks } from "../../runtime-sdk/turn-loop/hooks";
import { PluginMcp, pluginMcpServerKey } from "../../runtime-sdk/turn-loop/plugin-mcp";
import { startPluginHost } from "../daemon-host";

const temps: string[] = [];
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

const BOT: Caller = { kind: "session", sessionId: "b_alpha", botId: "alpha" } as unknown as Caller;
const USER: Caller = { kind: "user", client: "app" };
const engines = { clover: `^${PLUGIN_API_VERSION}` };

async function until<T>(what: string, ms: number, f: () => T | undefined | Promise<T | undefined>): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error(`${what}: not within ${ms} ms`);
    await Bun.sleep(25);
  }
}

/** The child's host half: an MCP server `tools` with one tool, and two handlers (a hook's and a plain call's). */
const CHILD_HOST = `
const TOOLS = [{ name: "kid_hello", description: "Says hello from the child.", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } }];
function answer(method, params) {
  if (method === "initialize") return { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "kid", version: "0.1.0" } };
  if (method === "tools/list") return { tools: TOOLS };
  if (method === "tools/call" && params?.name === "kid_hello") return { content: [{ type: "text", text: "Hello from the child, " + String(params.arguments?.name) + "!" }] };
  throw new Error("unknown method " + method);
}
export const mcp = {
  tools: async (transport) => {
    transport.onmessage = (m) => {
      if (typeof m.id !== "number" && typeof m.id !== "string") return;
      try { void transport.send({ jsonrpc: "2.0", id: m.id, result: answer(String(m.method), m.params) }); }
      catch (err) { void transport.send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: String(err && err.message || err) } }); }
    };
    await transport.start();
  },
};
export const note = async () => ({ note: { label: "kid", text: "the child's hook ran" } });
export const whoami = async () => "kid";
`;

describe("a child plugin of a bot-built tree", () => {
  test("its MCP tool is listed to the bot and callable, its hook runs, its ui entry is active in the spot catalog, its handler answers under its own id", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "clover-e-child-")));
    temps.push(home);
    const broker = new FakeApprovalBroker({ clock: new FakeClock() });
    const secrets = new MemorySecretStore();
    const opened = await openPluginRegistry({ cloverHome: home, os: "macos", broker, secrets, settleMs: 60_000 });
    // Stands in for the bundled shell, which declares `main` (a catalog spot: its entries wait until a shell does).
    const stub: Record<string, string> = {
      "clover.json": JSON.stringify({
        manifest: 1, id: "stubshell", name: "Stub shell", version: "1.0.0", engines, client: { entry: "client/index.tsx" },
        contributes: { ui: [{ spot: "app.root", component: "Shell", declares: { main: { shape: "keyed" } } }] },
      }),
      "client/index.tsx": "export function Shell() { return <div />; }\n",
    };
    const files: Record<string, string> = {
      "clover.json": JSON.stringify({ manifest: 1, id: "pack", name: "Pack", version: "1.0.0", engines, description: "A parent with one child." }),
      "plugins/kid/clover.json": JSON.stringify({
        manifest: 1, name: "Pack kid", description: "The child.", engines, host: { entry: "host/index.js" },
        client: { entry: "client/index.tsx" },
        contributes: {
          mcpServers: { tools: { type: "host", tools: { kid_hello: "preload" } } },
          hooks: [{ id: "kid-note", on: ["turn.start"], handler: "note" }],
          ui: [{ spot: "main", key: "pack-kid", component: "KidMain" }],
        },
      }),
      "plugins/kid/package.json": "{\"type\":\"module\"}",
      "plugins/kid/host/index.js": CHILD_HOST,
      "plugins/kid/client/index.tsx": "export function KidMain() { return <p>Kid page</p>; }\n",
    };
    for (const [id, tree] of [["pack", files], ["stubshell", stub]] as const) {
      for (const [path, body] of Object.entries(tree)) {
        mkdirSync(dirname(join(home, "plugins", id, path)), { recursive: true });
        writeFileSync(join(home, "plugins", id, path), body);
      }
    }
    const ph = await startPluginHost({ home, computer: "Studio", registry: opened.registry, secrets });
    const lines: string[] = [];
    const mcp = new PluginMcp({ registry: opened.registry, host: ph.host, self: () => "Studio", log: (l) => lines.push(l) });
    try {
      // Before the shell: the child's page waits for the spot, and says which.
      await opened.folders.installed("pack", "bot", { bot: "alpha" });
      const { card } = await opened.registry.installed("pack", "bot");
      const shown = broker.cards().find((c) => c.id === card)!;
      await broker.answer(card!, { optionId: "approve", hash: shown.hash, proof: { via: "sealed-frame", frame: broker.frameChannel(card!)!, input: "click", at: Date.now() } }, { role: "app" });
      await until("the child running", 15_000, () => (opened.registry.get("pack/kid")?.state === "waiting" || opened.registry.get("pack/kid")?.state === "running" ? true : undefined));
      expect(opened.registry.entries("ui").find((e) => e.pluginId === "pack/kid")).toMatchObject({ state: "waiting", reason: "waiting for `main`" });
      await opened.folders.installed("stubshell", "user-app");
      const shell = (await opened.registry.installed("stubshell", "app")).card;
      const shellShown = broker.cards().find((c) => c.id === shell)!;
      await broker.answer(shell!, { optionId: "approve", hash: shellShown.hash, proof: { via: "sealed-frame", frame: broker.frameChannel(shell!)!, input: "click", at: Date.now() } }, { role: "app" });
      await until("the tree running after its OK", 15_000, () => (opened.registry.get("pack")?.state === "running" && opened.registry.get("pack/kid")?.state === "running" ? true : undefined)).catch((e) => {
        throw new Error(`${(e as Error).message}; pack ${opened.registry.get("pack")?.state}; kid ${opened.registry.get("pack/kid")?.state} ${opened.registry.get("pack/kid")?.reason ?? ""}`);
      });

      // Registry level: each of the child's contributions is an active entry under the child's own id; its `ui` entry
      // names a spot the catalog knows, and the key is the page's.
      for (const point of ["mcpServers", "hooks", "ui"]) {
        const mine = opened.registry.entries(point).filter((e) => e.pluginId === "pack/kid");
        expect([point, mine.map((e) => e.state)]).toEqual([point, ["active"]]);
      }
      const ui = opened.registry.entries("ui").find((e) => e.pluginId === "pack/kid")!;
      const spot = (ui.value as { spot: string }).spot;
      expect(spotInfo(spot)).toMatchObject({ name: "main", shape: "keyed" });
      expect(ui.key).toBe("pack-kid");

      // The tool: listed to a bot's session under the child's key, and called as the bot.
      const key = pluginMcpServerKey("pack/kid", "tools")!;
      expect(key).toBe("pack-kid-tools");
      const listed = await until("the child's server listed", 20_000, () => mcp.servers("bot").find((s) => s.server === key)).catch((e) => {
        throw new Error(`${(e as Error).message}; servers ${JSON.stringify(mcp.servers("bot").map((s) => s.server))}; log ${lines.join(" | ")}`);
      });
      expect(listed.tools.map((t) => t.name)).toEqual(["kid_hello"]);
      const r = await mcp.call({ server: key, tool: "kid_hello", input: { name: "Alpha" }, as: BOT, session: "b_alpha" } as never);
      expect((r.content[0] as { text?: string }).text).toBe("Hello from the child, Alpha!");

      // The hook: the child's `turn.start` handler adds its note to the bot's turn.
      const hooks = pluginHooks({ registry: opened.registry, host: ph.host });
      const notes = await hooks.turnStart({ id: "b_alpha", kind: "bot", caller: BOT, bot: "alpha", computer: "Studio" });
      expect(notes).toEqual([{ label: "kid", text: "the child's hook ran", pluginId: "pack/kid", hook: "kid-note" }]);

      // Its host half answers under its own id, in a process of its own.
      expect(await ph.host.invoke({ pluginId: "pack/kid", handler: "whoami", args: null, caller: USER })).toBe("kid");

      // The parent off switches the child off: its tool leaves the bots' list (spec §5.1).
      await opened.registry.setEnabled("pack", false);
      await until("the child's entries gone", 15_000, () => (opened.registry.entries("ui").every((e) => e.pluginId !== "pack/kid" || e.state !== "active") ? true : undefined));
      expect(opened.registry.get("pack/kid")?.state).toBe("off");
      await until("the child's server gone from the bots' list", 15_000, () => (mcp.servers("bot").every((s) => s.server !== key) ? true : undefined));
    } finally {
      mcp.close();
      await ph.close();
      opened.close();
    }
  }, 90_000);
});
