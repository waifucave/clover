// The upgrade's bots row reads the old home on its own (bot-move-upgrade-step.ts `oldHomeBots`): each bot conversation
// it recorded, under the id its meta names, with the first thing the person said.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { botMoveUpgradeCheck, oldHomeBots } from "./bot-move-upgrade-step";

const temps: string[] = [];
afterEach(() => { for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true }); });

function oldHome(): string {
  const home = mkdtempSync(join(tmpdir(), "bt-old-"));
  temps.push(home);
  const put = (seg: string, file: string, body: string) => { mkdirSync(join(home, "transcripts", seg), { recursive: true }); writeFileSync(join(home, "transcripts", seg, file), body); };
  put("ws-sprout", "b_ws-sprout.meta.json", JSON.stringify({ meta: 1, id: "b_ws-sprout", kind: "bot", title: "Workshop sprout", bot: "ws-sprout" }));
  put("ws-sprout", "b_ws-sprout.ndjson", [{ type: "status", status: "ready" }, { type: "input", input: { from: "user", text: "TAG-1" } }].map((e) => JSON.stringify(e)).join("\n") + "\n{torn");
  put("example-notes--bot", "b_example-notes--bot.meta.json", JSON.stringify({ meta: 1, kind: "bot", title: "Notes keeper", bot: "example-notes/bot" }));
  put("_", "agent_x.meta.json", JSON.stringify({ kind: "agent" }));
  put("impostor", "b_impostor.meta.json", JSON.stringify({ kind: "bot", bot: "someone-else" }));
  return home;
}

describe("the upgrade's bots row", () => {
  test("reads each bot conversation the old home recorded", () => {
    expect(oldHomeBots(oldHome())).toEqual([
      { id: "example-notes/bot", session: "b_example-notes--bot", title: "Notes keeper" },
      { id: "ws-sprout", session: "b_ws-sprout", title: "Workshop sprout", said: "TAG-1" },
    ]);
  });

  test("a bot named twice in the journal, or neither listed nor archived, fails the row", async () => {
    const home = oldHome();
    const rpc = (journal: { id: string; outcome: string }[], records: string[], archived: string[]) => ({
      request: async <T,>(method: string): Promise<T> => ({
        "bot.move.status": { journal: { at: 1, bots: journal }, pending: [] },
        "bot.records": { bots: records.map((id) => ({ id })) },
        "bot.archived": { bots: archived.map((id) => ({ id })) },
        "bot.conversation": { events: [{ seq: 1, text: "TAG-1" }], hasMore: false },
        "bot.restore": {}, "bot.remove": {},
      } as Record<string, unknown>)[method] as T,
    });
    const both = [{ id: "ws-sprout", outcome: "moved" }, { id: "example-notes/bot", outcome: "moved" }];
    expect(await botMoveUpgradeCheck({ rpc: rpc(both, ["example-notes/bot"], ["ws-sprout"]), oldHome: home })).toContain("2 bots of the old home");
    await expect(botMoveUpgradeCheck({ rpc: rpc([...both, both[0]!], [], ["ws-sprout", "example-notes/bot"]), oldHome: home })).rejects.toThrow("2 times");
    await expect(botMoveUpgradeCheck({ rpc: rpc(both, [], ["ws-sprout"]), oldHome: home })).rejects.toThrow("neither listed nor archived");
  });
});
