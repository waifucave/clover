// The pin in her replies' row of actions (ui.pinReply, run by the conversation's message action with { session, seq }):
// the reply read from her own log, its first sentence as plain text, cut on a word with an ellipsis, pinned to her stage
// the way her pin_note tool pins a note; anything else, or a full stage, answers a note.
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

/** Her conversation's log as the conversation API reads it: `b_alpha` is hers, `b_luna` another bot's. */
function withConversation(api: object, events: { seq: number; type: string; text?: string }[]) {
  const asked: unknown[] = [];
  return Object.assign(api, {
    conversation: {
      get: async (id: string) => (id === "b_alpha" ? { id, bot: "alpha", kind: "bot" } : id === "b_luna" ? { id, bot: "luna", kind: "bot" } : Promise.reject(new Error("no session"))),
      history: async (id: string, page: { before?: number; limit: number }) => {
        asked.push([id, page]);
        const upTo = events.filter((e) => page.before === undefined || e.seq < page.before);
        return { events: upTo.slice(-page.limit), hasMore: false };
      },
    },
  });
}

test("a press names the message ({ session, seq }); her reply is read from the log and its first sentence pinned as pin_note pins", async () => {
  const f = fakeApi();
  const log = [
    { seq: 3, type: "user_message", text: "Remind me tonight." },
    { seq: 4, type: "assistant_message", text: "Perfect. Remind me about it tonight at 8?" },
    { seq: 6, type: "assistant_message", text: "```\ncode\n```" },
  ];
  await server.start(withConversation(f.api, log) as never);
  expect(await server.ui.pinReply({ session: "b_alpha", seq: 4 })).toEqual({ ok: true });
  expect((f.store.get(STAGE_KEY) as { pinned: { id: string; text: string }[] }).pinned).toEqual([{ id: "n1", text: "Perfect.", at: expect.any(Number) }]);
  expect(f.sent.at(-1)?.event).toBe("stage");
  // Not a reply of hers: a user's message, a seq with nothing there, another bot's conversation; a bad press.
  expect(await server.ui.pinReply({ session: "b_alpha", seq: 3 })).toEqual({ note: "Only her replies pin to her stage." });
  expect(await server.ui.pinReply({ session: "b_alpha", seq: 5 })).toEqual({ note: "Only her replies pin to her stage." });
  expect(await server.ui.pinReply({ session: "b_luna", seq: 4 })).toEqual({ note: "Only her own replies pin to her stage." });
  expect(await server.ui.pinReply({ session: "nope", seq: 4 })).toEqual({ note: "Only her own replies pin to her stage." });
  expect(await server.ui.pinReply({ session: "b_alpha", seq: 6 })).toEqual({ note: "That reply has no words to pin." });
  for (const bad of [null, {}, { session: "b_alpha" }, { session: "b_alpha", seq: -1 }, { session: "b_alpha", seq: 1.5 }, { text: "pin this instead" }]) {
    expect(await server.ui.pinReply(bad)).toEqual({ note: "Nothing to pin." });
  }
  expect((f.store.get(STAGE_KEY) as { pinned: unknown[] }).pinned).toHaveLength(1);
});

test("a full stage answers its sentence as the note; without conversation.read nothing is read", async () => {
  const f = fakeApi();
  const log = Array.from({ length: PINNED_MAX + 1 }, (_, i) => ({ seq: i, type: "assistant_message", text: `Note ${i}.` }));
  await server.start(withConversation(f.api, log) as never);
  for (let i = 0; i < PINNED_MAX; i++) expect(await server.ui.pinReply({ session: "b_alpha", seq: i })).toEqual({ ok: true });
  const full = await server.ui.pinReply({ session: "b_alpha", seq: PINNED_MAX });
  expect("note" in full && full.note).toStartWith(`Her stage holds ${PINNED_MAX} notes; unpin one first`);
  expect("note" in full && full.note.length).toBeLessThanOrEqual(300);
  await server.stop();
  await server.start(fakeApi().api as never);
  expect(await server.ui.pinReply({ session: "b_alpha", seq: 0 })).toEqual({ note: "Her stage can't read the conversation here." });
});
