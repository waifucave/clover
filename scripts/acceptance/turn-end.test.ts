import { describe, expect, test } from "bun:test";
import { ownTurnCompleted, ownTurnEvents, ownUserMessage } from "./turn-end";

describe("the end of the turn a message started (turn-end.ts)", () => {
  test("an earlier turn interrupted by the send, or another turn ending after it, is not this message's", () => {
    // A routine's turn running at seq 10; the user's message at 12 interrupts it (its aborted completion at 13); the
    // message's own turn starts at 14 and ends at 17.
    const evs = [
      { type: "turn_started", seq: 10 }, { type: "assistant_message", seq: 11 },
      { type: "user_message", seq: 12, text: "ACCEPTANCE-AGENT /x" },
      { type: "turn_completed", seq: 13, stopReason: "aborted" },
      { type: "turn_started", seq: 14 }, { type: "tool_call", seq: 15 }, { type: "tool_result", seq: 16 },
    ];
    expect(ownTurnCompleted(evs, 12, "ACCEPTANCE-AGENT /x")).toBeUndefined();
    const ended = [...evs, { type: "turn_completed", seq: 17, stopReason: "end_turn" }];
    expect(ownTurnCompleted(ended, 12, "ACCEPTANCE-AGENT /x")?.seq).toBe(17);
    // Its own events only: the interrupted turn's aborted completion is not among them.
    expect(ownTurnEvents(ended, 12, "ACCEPTANCE-AGENT /x")?.map((e) => e.seq)).toEqual([14, 15, 16, 17]);
  });
  test("the send's seq is the message's or before it; its text picks it out from a later message", () => {
    const evs = [{ type: "user_message", seq: 21, text: "other" }, { type: "user_message", seq: 22, text: "mine" }];
    expect(ownUserMessage(evs, 20, "mine")?.seq).toBe(22);
    expect(ownUserMessage(evs, 20)?.seq).toBe(21);
    expect(ownUserMessage(evs, 20, "words stored otherwise")?.seq).toBe(21);
  });
  test("no message yet, or no start after it: not ended", () => {
    expect(ownTurnCompleted([{ type: "turn_completed", seq: 5 }], 4)).toBeUndefined();
    expect(ownTurnCompleted([{ type: "user_message", seq: 4, text: "a" }, { type: "turn_completed", seq: 5 }], 4, "a")).toBeUndefined();
  });
});
