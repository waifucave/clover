// MOSS's microphone button and talk key (voice.ts): the voice plugin's talk command, held down then up (or cancelled when
// the window loses the focus), one hold at a time; the talk key is Ctrl+Shift+Space and nothing else.
import { describe, expect, test } from "bun:test";
import { isTalkKey, Talk, TALK_COMMAND } from "../src/main/voice";

describe("the talk command", () => {
  test("is the voice plugin's push-to-talk", () => {
    expect(TALK_COMMAND).toBe("moss.push-to-talk");
  });

  test("held: down once, then up; a second down while held is no new hold", async () => {
    const sent: string[] = [];
    const t = new Talk(async (h) => { sent.push(h); return true; });
    t.down("button");
    t.down("key");
    t.up();
    t.up();
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toEqual(["down", "up"]);
  });

  test("the window losing the focus mid-hold cancels it", async () => {
    const sent: string[] = [];
    const t = new Talk(async (h) => { sent.push(h); return true; });
    t.down("key");
    t.cancel();
    t.up();
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toEqual(["down", "cancel"]);
  });

  test("the talk key is Ctrl+Shift+Space only", () => {
    expect(isTalkKey({ type: "keyDown", code: "Space", control: true, shift: true })).toBe(true);
    expect(isTalkKey({ type: "keyDown", code: "Space", control: true, shift: true, meta: true })).toBe(false);
    expect(isTalkKey({ type: "keyDown", code: "Space", shift: true })).toBe(false);
    expect(isTalkKey({ type: "keyDown", code: "KeyA", control: true, shift: true })).toBe(false);
  });
});
