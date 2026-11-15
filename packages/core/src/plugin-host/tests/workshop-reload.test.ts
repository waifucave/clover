// A bot-built plugin edited in place (the workshop rule, spec §5.6) runs its new code: over the real plugin registry,
// the real plugin host (its process and worker) and the bots' MCP door, an edit to its host half that asks for nothing
// new applies with no card, and the next tool call answers the new code; a tool's changed description is listed again;
// and the registry's plugin event goes out for the app's layers (its client half). Temp home, the fake approval broker
// and an in-memory secret store; nothing opens a window. (Try 14c row 48: the edit was recorded and the old worker kept
// answering, since an in-place change keeps the plugin `running` and only `watchTrees` says so.)
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { templateFiles } from "@waifucave/clover-plugin-sdk/templates";
import type { Caller } from "@waifucave/clover-protocol";
import { FakeApprovalBroker } from "../../contracts/fakes/approval-broker";
import { FakeClock } from "../../contracts/fakes/clock";
import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import { openPluginRegistry } from "../../registry/open";
import { registryEvents } from "../registry-events";
import { PluginMcp } from "../../runtime-sdk/turn-loop/plugin-mcp";
import { startPluginHost } from "../daemon-host";

const temps: string[] = [];
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

const ID = "ws-greeter";
const SERVER = "ws-greeter-tools";
const BOT: Caller = { kind: "session", sessionId: "b_alpha", botId: "alpha" } as unknown as Caller;

async function until<T>(what: string, ms: number, f: () => T | undefined | Promise<T | undefined>): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error(`${what}: not within ${ms} ms`);
    await Bun.sleep(25);
  }
}

describe("a workshop plugin edited in place", () => {
  test("its host half reloads: the next tool call answers the new code with no card, a changed description is listed again, and the plugin event goes out", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "clover-b-ws-reload-")));
    temps.push(home);
    const folder = join(home, "plugins", ID);
    const broker = new FakeApprovalBroker({ clock: new FakeClock() });
    const secrets = new MemorySecretStore();
    // The folder watch's settle is long, so the test reads each change itself (`installed`, `refresh`), as a settled
    // change would: the install is read with its builder, never first as a folder that appeared.
    const opened = await openPluginRegistry({ cloverHome: home, os: "macos", broker, secrets, settleMs: 60_000 });
    // What PluginInstall puts in place: the SDK's tool template.
    const made = templateFiles("tool", { id: ID, name: "Workshop greeter" });
    if ("error" in made) throw new Error(made.error);
    for (const [path, body] of Object.entries(made.files)) {
      mkdirSync(dirname(join(folder, path)), { recursive: true });
      writeFileSync(join(folder, path), body);
    }
    const ph = await startPluginHost({ home, computer: "Studio", registry: opened.registry, secrets });
    const lines: string[] = [];
    const mcp = new PluginMcp({ registry: opened.registry, host: ph.host, self: () => "Studio", log: (l) => lines.push(l) });
    const events: { type: string; id?: unknown }[] = [];
    const offEvents = registryEvents({ registry: opened.registry, trees: (fn) => opened.registry.watchTrees!(fn), emit: (e) => events.push(e) });
    const call = async () => {
      const r = await mcp.call({ server: SERVER, tool: "hello", input: { name: "Acceptance" }, as: BOT, session: "b_alpha" } as never);
      return (r.content[0] as { text?: string }).text;
    };
    const description = () => mcp.servers("bot").find((s) => s.server === SERVER)?.tools.find((t) => t.name === "hello")?.description;
    try {
      // Built by a bot, OK'd by the user.
      await opened.folders.installed(ID, "bot", { bot: "alpha" });
      const { card } = await opened.registry.installed(ID, "bot");
      const shown = broker.cards().find((c) => c.id === card)!;
      await broker.answer(card!, { optionId: "approve", hash: shown.hash, proof: { via: "sealed-frame", frame: broker.frameChannel(card!)!, input: "click", at: Date.now() } }, { role: "app" });
      await until("running after its OK", 10_000, () => (opened.registry.get(ID)?.state === "running" ? true : undefined));
      await until("its tool listed", 20_000, () => description()).catch((err) => { throw new Error(`${(err as Error).message}; servers ${JSON.stringify(mcp.servers("bot")).slice(0, 600)}; log ${lines.join(" | ")}; state ${JSON.stringify(opened.registry.get(ID)?.state)}`); });
      expect(await call()).toBe("Hello, Acceptance!");
      const cardsBefore = broker.cards().length;
      const hashAtOk = opened.registry.get(ID)!.treeHash;

      // The builder edits its code in place: the greeting and the tool's description. Nothing new is asked for.
      const host = join(folder, "host", "index.ts");
      writeFileSync(host, readFileSync(host, "utf8").replace("`Hello, ${who}!`", "`Hi again, ${who}!`").replace("Says hello to someone by name.", "Greets someone again."));
      events.length = 0;
      await opened.folders.refresh(folder);
      await until("the edit applied", 10_000, () => (opened.registry.get(ID)?.treeHash !== hashAtOk ? true : undefined));
      expect(opened.registry.get(ID)).toMatchObject({ state: "running" });
      expect(opened.registry.get(ID)!.okHash).toBe(opened.registry.get(ID)!.treeHash);
      expect(broker.cards().length).toBe(cardsBefore);
      // The app hears it (its layers read the plugin again: the client half).
      expect(events).toContainEqual(expect.objectContaining({ type: "plugin_changed", id: ID }));

      // The next call answers the new code, and the new description is what the bots are offered.
      await until("the new code answering", 20_000, async () => ((await call().catch(() => undefined)) === "Hi again, Acceptance!" ? true : undefined));
      await until("the new description listed", 20_000, () => (description() === "Greets someone again." ? true : undefined));
      expect(lines.some((l) => l.includes(`${ID}: its tree changed; its servers are listed again`))).toBe(true);

      // Its manifest changed in a way that adds nothing (its own description): no card, and it is listed again on the
      // reloaded worker, which still answers.
      const relists = () => lines.filter((l) => l.includes(`${ID}: its tree changed; its servers are listed again`)).length;
      const before = relists();
      const manifest = join(folder, "clover.json");
      const hashBefore = opened.registry.get(ID)!.treeHash;
      writeFileSync(manifest, readFileSync(manifest, "utf8").replace("Workshop greeter, a tool.", "Greets people, twice."));
      await opened.folders.refresh(folder);
      await until("the manifest edit applied", 10_000, () => (opened.registry.get(ID)?.treeHash !== hashBefore ? true : undefined));
      expect(opened.registry.get(ID)).toMatchObject({ state: "running" });
      expect(broker.cards().length).toBe(cardsBefore);
      await until("listed again", 20_000, () => (relists() > before ? true : undefined));
      await until("still answering", 20_000, async () => ((await call().catch(() => undefined)) === "Hi again, Acceptance!" ? true : undefined));
    } finally {
      offEvents();
      mcp.close();
      await ph.close();
      opened.close();
    }
  }, 90_000);
});
