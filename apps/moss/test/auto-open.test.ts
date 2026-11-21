import { expect, test } from "bun:test";
import { autoOpenBot } from "../src/window/auto-open";
import type { BotRow } from "../src/shared/view";

const bot = (id: string, extra: Partial<BotRow> = {}): BotRow => ({ id, name: id, mood: "idle", unread: false, ...extra });

test("the window opens on the default bot even when another bot's older conversation sorts ahead of her", () => {
  // The list is newest activity first: the default bot with no message yet has no time and sorts after a bot with an old one.
  const list = [bot("chronicle", { last: { text: "hi", from: "bot", at: 1 } }), bot("alpha", { default: true })];
  expect(autoOpenBot(list)?.id).toBe("alpha");
  // And it stays hers when she moves to the top, or other bots come and go around her.
  expect(autoOpenBot([list[1]!, list[0]!])?.id).toBe("alpha");
  expect(autoOpenBot([bot("x"), list[0]!, list[1]!])?.id).toBe("alpha");
});

test("with no default bot (archived, or not yet listed) the first of the list opens; with none there is none", () => {
  expect(autoOpenBot([bot("a"), bot("b")])?.id).toBe("a");
  expect(autoOpenBot([])).toBeUndefined();
});
