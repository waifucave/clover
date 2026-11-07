// Lane D's bot side driven by lane A's bot driver on the real embedded runtime: the user's message starts a bot's
// turn, its `SendMessage` (lane D's tool, registered by the driver under its plain name) reaches another bot, whose
// own turn takes it as a bot's message, and both conversations end their turns with the runtime's usage.
import { afterAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { SystemClock } from "../../../src/clock/system-clock";
import { FakePluginRegistry } from "../../../src/contracts/fakes/plugin-registry";
import { createBotSide, type BotSide } from "../../../src/bots/wiring";
import { botManifest, pluginFromFolder, tempDir, writePlugin } from "../../../src/bots/tests/fixtures";
import { catalogPointDecl } from "../../../../plugin-sdk/src/catalogs/index";
import { mainSessionIdFor } from "../../../src/sessions/ids";
import { botDriverFactory } from "../../../src/runtime-sdk/turn-loop/driver";
import { botCoreTools } from "../../../src/runtime-sdk/turn-loop/wiring";
import type { SessionRecord } from "../../../src/contracts/session-host";
import { describeWithEmbeddedRuntime } from "../../helpers/embedded-runtime";

const temps: string[] = [];
afterAll(() => { for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true }); });

async function until(what: string, fn: () => boolean, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(50);
  }
}

describeWithEmbeddedRuntime("the bot side on the bot driver", (spawn) => {
  test("a bot's SendMessage reaches another bot's conversation, which answers in a turn of its own", async () => {
    const home = tempDir("clover-a3-side-");
    const root = tempDir("clover-a3-plugins-");
    temps.push(home, root);
    const model = { default: "winter-test/calls" };
    const luna = writePlugin(root, "luna", { "clover.json": botManifest("luna", "Luna", { model }), "bot/instructions.md": "You are Luna." });
    const sol = writePlugin(root, "sol", { "clover.json": botManifest("sol", "Sol", { model }), "bot/instructions.md": "You are Sol." });
    const registry = new FakePluginRegistry({ catalog: catalogPointDecl, plugins: [...(await pluginFromFolder(luna)).inputs, ...(await pluginFromFolder(sol)).inputs] });
    let side: BotSide | undefined;
    const drivers = botDriverFactory({
      home, spawn,
      canUseTool: () => async (_n, input) => ({ behavior: "allow", updatedInput: input as Record<string, unknown> }),
      sandbox: () => ({ enabled: false }),
      coreTools: (ctx, origin) => botCoreTools({ side: side! })(ctx, origin),
      stopGraceMs: 5_000,
    });
    side = createBotSide({ home, computer: "Studio", registry, drivers, clock: new SystemClock(), defaultModel: () => ({ model: "winter-test/calls" }) });
    await side.start();
    try {
      const lunaId = mainSessionIdFor("luna");
      const solId = mainSessionIdFor("sol");
      await side.host.sendUser(lunaId, { text: 'CALL SendMessage {"to":"sol","message":"hello from luna"}', device: "d_1", sentAt: Date.now(), clientMessageId: "m1" });
      const ended = (id: string) => side!.host.history(id).filter((r): r is SessionRecord & { type: "turn_ended" } => r.type === "turn_ended");
      await until("luna's turn", () => ended(lunaId).length >= 1);
      await until("sol's turn", () => ended(solId).length >= 1);
      const lunaEnd = ended(lunaId)[0]!.end;
      expect(lunaEnd.reason).toBe("end_turn");
      const lunaResults = JSON.parse(lunaEnd.text ?? "[]") as { name: string; isError: boolean }[];
      expect(lunaResults).toEqual([expect.objectContaining({ name: "SendMessage", isError: false })]);
      expect((lunaEnd.usage as { contextTokens?: number } | undefined)?.contextTokens).toBeGreaterThan(0);
      // Sol got it as a bot's message, never as the user's.
      const solInput = side.host.history(solId).find((r) => r.type === "input" && r.input.from === "bot");
      expect(solInput).toBeDefined();
      expect(solInput!.type === "input" && solInput!.input.from === "bot" && solInput!.input.text).toBe("hello from luna");
      expect(ended(solId)[0]!.end.reason).toBe("end_turn");
      // The runtime's tool call and its result are in Luna's log as the inherited events.
      const events = side.host.history(lunaId).flatMap((r) => (r.type === "driver" ? [r.event.type] : []));
      expect(events).toContain("tool_call");
      expect(events).toContain("tool_result");
    } finally {
      await side.close();
    }
  }, 90_000);
});
