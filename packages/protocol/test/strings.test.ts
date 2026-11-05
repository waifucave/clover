// Pins string caps in UTF-16 code units, whatever zod counts: zod 4.6 counts `.max()` in code points, so the
// protocol's caps all go through `utf16`, a refine on `.length`. This test holds under zod 4.4 and under 4.6.6 or later.
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { NoteEvent, PluginMessageEvent } from "../src/sessions";
import { utf16 } from "../src/strings";

const EMOJI = "😀"; // one code point, two UTF-16 units

describe("utf16", () => {
  test("caps count UTF-16 units, as JavaScript's .length does", () => {
    expect(EMOJI.length).toBe(2);
    expect(utf16(5).safeParse(EMOJI.repeat(3)).success).toBe(false); // 6 units, 3 code points
    expect(utf16(6).safeParse(EMOJI.repeat(3)).success).toBe(true);
    expect(utf16(4).safeParse("abcd").success).toBe(true);
    expect(utf16(4).safeParse("abcde").success).toBe(false);
  });

  test("a minimum counts UTF-16 units too, and 1 still means non-empty", () => {
    expect(utf16(10, 4).safeParse(EMOJI.repeat(2)).success).toBe(true); // 4 units, 2 code points
    expect(utf16(10, 4).safeParse("abc").success).toBe(false);
    expect(utf16(10, 1).safeParse("").success).toBe(false);
    expect(utf16(10, 1).safeParse(EMOJI).success).toBe(true);
  });

  test("whatever zod itself counts, the helper's answer is the same", () => {
    // zod 4.4 counts .max() in UTF-16 units; 4.6.6 and later in code points. Either way the cap holds.
    const zodCountsCodePoints = z.string().max(3).safeParse(EMOJI.repeat(3)).success;
    expect(typeof zodCountsCodePoints).toBe("boolean");
    expect(utf16(3).safeParse(EMOJI.repeat(3)).success).toBe(false);
  });

  test("one issue for a string too long by zod's count as well, and later checks still run", () => {
    const codes = (v: string) => utf16(3).regex(/^[a-z]+$/).safeParse(v).error?.issues.map((i) => i.code);
    expect(codes("abcd")).toEqual(["too_big"]);
    expect(codes("ABCD")).toEqual(["too_big", "invalid_format"]);
    // zod 4.4 says too_big; 4.6 and later count 2 code points, so the refine says it.
    expect(codes(EMOJI.repeat(2))?.length).toBe(2);
  });

  test("it chains like any string schema, and the JSON Schemas keep their lengths", () => {
    const id = utf16(8, 2).regex(/^[a-z]+$/);
    expect(id.safeParse("ab").success).toBe(true);
    expect(id.safeParse("a").success).toBe(false);
    expect(id.safeParse("AB").success).toBe(false);
    expect(utf16(8).optional().safeParse(undefined).success).toBe(true);
    expect(z.toJSONSchema(id)).toMatchObject({ type: "string", maxLength: 8, minLength: 2, pattern: "^[a-z]+$" });
    expect(z.toJSONSchema(utf16(8, 1))).toMatchObject({ type: "string", maxLength: 8, minLength: 1 });
  });

  test("the protocol's own caps count units: a 120-unit label holds 60 emoji, not 61", () => {
    const note = (label: string) => NoteEvent.safeParse({ type: "note", seq: 1, sessionId: "s_alpha", ts: 1, from: { kind: "core" }, label, text: "x" });
    expect(note(EMOJI.repeat(60)).success).toBe(true);
    expect(note(EMOJI.repeat(61)).success).toBe(false);
    const msg = PluginMessageEvent.safeParse({ type: "plugin_message", seq: 1, sessionId: "s_alpha", ts: 1, from: { kind: "plugin", pluginId: "blender" }, text: "x", app: { callId: EMOJI.repeat(65) } });
    expect(msg.success).toBe(false);
  });
});
