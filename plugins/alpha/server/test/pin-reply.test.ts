// The pin under one of her replies (ui.pinReply, her tab's call): the reply's first sentence, as plain text, cut on a
// word with an ellipsis, pinned to her stage the way her pin_note tool pins a note; a full stage says so.
import { afterEach, expect, test } from "bun:test";
import * as server from "../index";
import { PINNED_MAX, REPLY_GIST_MAX, replyGist, STAGE_KEY } from "../stage";
import { fakeApi } from "./fakes";

afterEach(() => server.stop());

test("the gist is the first sentence, Markdown's marks left out", () => {
  expect(replyGist("Your train leaves Tokyo at 9:12 on Thursday and arrives in Kyoto at 11:26. I added both times to your calendar.")).toBe("Your train leaves Tokyo at 9:12 on Thursday and arrives in Kyoto at 11:26.");
  expect(replyGist("**Done.** I'll ring at 8:00.")).toBe("Done.");
  expect(replyGist("## Packing\n\n- The [rail pass](https://example.com/pass) and a `plug adapter` are *still* missing\n- the scarf")).toBe("Packing");
  expect(replyGist("```ts\nconst x = 1;\n```\nThat sets x to 3.5 units! Then more.")).toBe("That sets x to 3.5 units!");
  expect(replyGist("今日は晴れです。明日は雨。")).toBe("今日は晴れです。");
  expect(replyGist("No full stop at all")).toBe("No full stop at all");
  expect(replyGist("  \n```\nonly code\n```\n")).toBe("");
  expect(replyGist("a‮b\u0007c.")).toBe("a b c.");
});

test("a long reply: its first sentence cut on a word at 120 characters, with an ellipsis", () => {
  const long = "Four things are still unchecked on your Kyoto list: the rail pass, a plug adapter for the hotel, the blue scarf and your camera charger, which people forget. The charger is the one.";
  const gist = replyGist(long);
  expect(gist).toBe("Four things are still unchecked on your Kyoto list: the rail pass, a plug adapter for the hotel, the blue scarf and…");
  expect(gist.length).toBeLessThanOrEqual(REPLY_GIST_MAX);
  // One word longer than the limit is cut inside it.
  expect(replyGist("x".repeat(300))).toBe(`${"x".repeat(REPLY_GIST_MAX - 1)}…`);
});

test("pinned to her stage as her pin_note tool pins a note; a full stage, a reply with no words or a bad call pins nothing", async () => {
  const f = fakeApi();
  await server.start(f.api as never);
  expect(await server.ui.pinReply({ v: 1, text: "Perfect. Remind me about it tonight at 8?" })).toEqual({ ok: true, said: "Pinned: Perfect." });
  expect((f.store.get(STAGE_KEY) as { pinned: { id: string; text: string }[] }).pinned).toEqual([{ id: "n1", text: "Perfect." }]);
  expect(f.sent.at(-1)?.event).toBe("stage");
  expect(await server.ui.pinReply({ v: 1, text: "```\ncode\n```" })).toEqual({ ok: false, said: "That reply has no words to pin." });
  expect(await server.ui.pinReply({ text: "no version" })).toEqual({ ok: false, said: "Nothing to pin." });
  expect(await server.ui.pinReply(null)).toEqual({ ok: false, said: "Nothing to pin." });
  for (let i = 1; i < PINNED_MAX; i++) expect((await server.ui.pinReply({ v: 1, text: `Note ${i}.` })).ok).toBe(true);
  const full = await server.ui.pinReply({ v: 1, text: "One more." });
  expect(full.ok).toBe(false);
  expect(full.said).toStartWith(`Her stage holds ${PINNED_MAX} notes; unpin one first`);
});
