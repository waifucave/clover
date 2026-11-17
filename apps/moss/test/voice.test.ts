// MOSS's microphone button and talk key (voice.ts): the voice plugin's talk command, read from the plugins' own
// declarations (the voice point's active filler and its held command), held down then up (or cancelled when the window
// loses the focus), one hold at a time; the talk key is Ctrl+Shift+Space and nothing else.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isTalkKey, Talk, talkCommandOf, VOICE_POINT } from "../src/main/voice";

const VOICE = { point: VOICE_POINT, declaredBy: "moss/voice", active: { pluginId: "moss/voice" } };
const PTT = { name: "moss.push-to-talk", pluginId: "moss/voice", hold: true as const };

describe("which command the microphone runs", () => {
  test("the active voice filler's own held command", () => {
    expect(talkCommandOf([VOICE], [{ name: "moss.speak", pluginId: "moss/voice" }, PTT])).toEqual({ command: "moss.push-to-talk", pluginId: "moss/voice" });
    // Another plugin's mode, active, with a held command of its own: that one.
    const other = { name: "luna.talk", pluginId: "luna/voice", hold: true as const };
    expect(talkCommandOf([{ ...VOICE, active: { pluginId: "luna/voice" } }], [PTT, other])).toEqual({ command: "luna.talk", pluginId: "luna/voice" });
  });

  test("a mode that declares none: the held command of the plugin that declares the voice point", () => {
    expect(talkCommandOf([{ ...VOICE, active: { pluginId: "luna/hears" } }], [PTT, { name: "luna.x", pluginId: "luna/hears" }])).toEqual({ command: "moss.push-to-talk", pluginId: "moss/voice" });
  });

  test("no voice point, no held command, or the lists not read: none, with why in words", () => {
    expect("why" in talkCommandOf([], [PTT])).toBe(true);
    expect("why" in talkCommandOf([VOICE], [{ ...PTT, hold: undefined } as never])).toBe(true);
    expect("why" in talkCommandOf(undefined, [PTT])).toBe(true);
  });

  test("MOSS names no voice plugin's command: the shipped voice plugin declares the one it runs", () => {
    const main = ["voice.ts", "index.ts", "engine.ts"].map((f) => readFileSync(join(import.meta.dir, "..", "src", "main", f), "utf8")).join("\n");
    expect(main).not.toContain("push-to-talk");
    const manifest = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "..", "plugins", "moss", "plugins", "voice", "moss.json"), "utf8")) as { contributes: { commands: { name: string; hold?: boolean }[]; "moss.voice.modes"?: unknown }; host: { declares: Record<string, unknown> } };
    expect(manifest.contributes.commands.some((c) => c.hold === true)).toBe(true);
    expect(Object.keys(manifest.host.declares)).toContain(VOICE_POINT);
  });
});

describe("the talk command", () => {
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
