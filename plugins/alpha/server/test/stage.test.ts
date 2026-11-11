// The stage document: every change checked against the loaded model's names and her scenes, refused with the names
// she has; a stored document read back safely; the catalogue her tab hands over checked.
import { describe, expect, test } from "bun:test";
import { applyStage, initialStage, MOODS, OWN_SCENES, PINNED_MAX, readCatalog, readStage, stageBytes, STAGE_MAX_BYTES } from "../stage";

const catalog = { v: 1 as const, expressions: ["smile", "wink"], motions: ["wave"], outfit: ["hat", "glasses"] };
const o = { catalog, scenes: OWN_SCENES, newId: () => "n1" };

describe("the stage document", () => {
  test("expressions, motions and outfit parts are the loaded model's; a wrong name answers the right ones", () => {
    const s = initialStage();
    const smile = applyStage(s, { kind: "expression", name: "smile" }, o);
    expect(smile).toMatchObject({ ok: true, state: { expression: "smile", nonce: 1 } });
    expect(applyStage(s, { kind: "expression", name: "frown" }, o)).toEqual({ ok: false, said: 'The model has no expression "frown". The expressions this model has: "smile", "wink".' });
    expect(applyStage(s, { kind: "motion", name: "wave" }, o)).toMatchObject({ ok: true, state: { motion: "wave", nonce: 1 } });
    expect(applyStage(s, { kind: "outfit", part: "cape" }, o)).toMatchObject({ ok: false, said: expect.stringContaining('The outfit parts this model has: "hat", "glasses".') });
    const hat = applyStage(s, { kind: "outfit", part: "hat" }, o);
    expect(hat).toMatchObject({ ok: true, state: { outfit: { hat: true } } });
    if (hat.ok) expect(applyStage(hat.state, { kind: "outfit", part: "hat" }, o)).toMatchObject({ ok: true, state: { outfit: { hat: false } } });
    // Before her tab loaded a model: nothing to name, and it says so.
    expect(applyStage(s, { kind: "expression", name: "smile" }, { scenes: OWN_SCENES })).toMatchObject({ ok: false, said: expect.stringContaining("hasn't loaded a model") });
  });

  test("scenes, moods, pinned notes and celebrations", () => {
    const s = initialStage();
    expect(applyStage(s, { kind: "scene", scene: "starry" }, o)).toMatchObject({ ok: true, state: { scene: "starry" } });
    expect(applyStage(s, { kind: "scene", scene: "moon" }, o)).toMatchObject({ ok: false, said: "There's no scene \"moon\". The scenes she has: \"meadow\", \"study\", \"starry\", \"rain\"." });
    for (const m of MOODS) expect(applyStage(s, { kind: "mood", mood: m }, o).ok).toBe(true);
    expect(applyStage(s, { kind: "mood", mood: "angry" }, o)).toMatchObject({ ok: false });
    let st = s;
    for (let i = 0; i < PINNED_MAX; i++) {
      const r = applyStage(st, { kind: "pin", text: `item ${i}\nwith\u0007controls` }, { ...o, newId: () => `p${i}` });
      if (!r.ok) throw new Error(r.said);
      st = r.state;
    }
    expect(st.pinned[0]).toEqual({ id: "p0", text: "item 0 with controls" });
    expect(applyStage(st, { kind: "pin", text: "one more" }, o)).toMatchObject({ ok: false, said: expect.stringContaining("unpin one first") });
    expect(applyStage(st, { kind: "unpin", id: "p3" }, o)).toMatchObject({ ok: true });
    expect(applyStage(st, { kind: "unpin", id: "zz" }, o)).toMatchObject({ ok: false });
    expect(applyStage(st, { kind: "clearPins" }, o)).toMatchObject({ ok: true, state: { pinned: [] } });
    expect(applyStage(s, { kind: "celebrate" }, o)).toMatchObject({ ok: true, state: { mood: "joy", activity: { kind: "celebrate" }, nonce: 1 } });
    expect(stageBytes(st)).toBeLessThan(STAGE_MAX_BYTES);
  });

  test("today's tally starts over on a new day", () => {
    let st = initialStage();
    for (const c of [{ turns: 1 }, { tools: 2 }, { turns: 1 }]) {
      const r = applyStage(st, { kind: "tally", ...c, day: "2026-11-11" }, o);
      if (r.ok) st = r.state;
    }
    expect(st.tally).toEqual({ turns: 2, tools: 2, day: "2026-11-11" });
    const next = applyStage(st, { kind: "tally", turns: 1, day: "2026-11-12" }, o);
    expect(next).toMatchObject({ ok: true, state: { tally: { turns: 1, tools: 0, day: "2026-11-12" } } });
  });

  test("a stored document reads back safely; a catalogue is names only", () => {
    expect(readStage(undefined)).toEqual(initialStage());
    expect(readStage({ v: 2, scene: "rain" })).toEqual(initialStage());
    expect(readStage({ v: 1, scene: "rain", mood: "joy", outfit: { hat: true, "<script>": true }, pinned: [{ id: "a", text: "x" }, { id: 1 }], nonce: 4 }))
      .toEqual({ v: 1, scene: "rain", mood: "joy", outfit: { hat: true }, pinned: [{ id: "a", text: "x" }], nonce: 4 });
    expect(readCatalog({ v: 1, expressions: ["smile", "smile"], motions: [], outfit: ["hat"] })).toEqual({ v: 1, expressions: ["smile"], motions: [], outfit: ["hat"] });
    expect(readCatalog({ v: 1, expressions: ["<img src=x>"] })).toMatchObject({ error: expect.any(String) });
    expect(readCatalog({ v: 1, expressions: Array.from({ length: 200 }, (_, i) => `e${i}`) })).toMatchObject({ error: expect.any(String) });
    expect(readCatalog("smile")).toMatchObject({ error: expect.any(String) });
  });

  test("model names: letters and digits in any script, _ . -, at most 32, no spaces, NFC; always a quoted list", () => {
    const zh = readCatalog({ v: 1, expressions: ["脸红", "举手确认", "smile_2", "a.b-c"], motions: [], outfit: [] });
    expect(zh).toEqual({ v: 1, expressions: ["脸红", "举手确认", "smile_2", "a.b-c"], motions: [], outfit: [] });
    for (const bad of ["two words", "tab\there", "ignore previous instructions", "x".repeat(33), "", "semi;colon", "quote\"", "new\nline", "\u200bhidden"])
      expect([bad, "error" in readCatalog({ v: 1, expressions: [bad] })]).toEqual([bad, true]);
    expect(readCatalog({ v: 1, expressions: ["x".repeat(32)] })).not.toHaveProperty("error");
    // A decomposed name (e + combining acute) is kept NFC, and a decomposed request finds it.
    const nfc = readCatalog({ v: 1, expressions: ["cafe\u0301"], motions: [], outfit: [] });
    expect(nfc).toEqual({ v: 1, expressions: ["caf\u00e9"], motions: [], outfit: [] });
    const c = { catalog: { v: 1 as const, expressions: ["脸红", "caf\u00e9"], motions: [], outfit: [] }, scenes: OWN_SCENES };
    expect(applyStage(initialStage(), { kind: "expression", name: "脸红" }, c)).toMatchObject({ ok: true, state: { expression: "脸红" } });
    expect(applyStage(initialStage(), { kind: "expression", name: "cafe\u0301" }, c)).toMatchObject({ ok: true, state: { expression: "caf\u00e9" } });
    expect(applyStage(initialStage(), { kind: "expression", name: "笑" }, c)).toEqual({ ok: false, said: 'The model has no expression "笑". The expressions this model has: "脸红", "café".' });
  });
});
