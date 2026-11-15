// The stage document: every change checked against the loaded model's names and her scenes, refused with the names
// she has; a stored document read back safely; the catalogue her tab hands over checked.
import { describe, expect, test } from "bun:test";
import { applyStage, CATALOG_MAX_BYTES, initialStage, MOODS, NAMES_MAX, nextHandle, noteGist, OWN_SCENES, PINNED_MAX, readCatalog, readStage, stageBytes, STAGE_MAX_BYTES } from "../stage";

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
    expect(st.pinned[0]).toEqual({ id: "p0", text: "item 0 with controls", at: expect.any(Number) });
    expect(applyStage(st, { kind: "pin", text: "one more" }, o)).toMatchObject({ ok: false, said: expect.stringContaining("unpin one first") });
    expect(applyStage(st, { kind: "unpin", id: "p3" }, o)).toMatchObject({ ok: true });
    expect(applyStage(st, { kind: "unpin", id: "p3" }, o)).toMatchObject({ said: "Unpinned: item 3 with controls", shown: { kind: "unpin", handle: "p3" } });
    expect(applyStage(st, { kind: "unpin", id: "zz" }, o)).toMatchObject({ ok: false, said: expect.stringContaining('their handles: "p0", "p1"') });
    expect(applyStage(st, { kind: "clearPins" }, o)).toMatchObject({ ok: true, state: { pinned: [] } });
    const party = applyStage(s, { kind: "celebrate" }, o);
    expect(party).toMatchObject({ ok: true, state: { mood: "joy", activity: { kind: "celebrate" }, nonce: 1, celebrations: 1 } });
    // Each celebration counts once more, whatever is written in between (her tab plays one burst per count).
    if (party.ok) {
      const between = applyStage(party.state, { kind: "mood", mood: "calm" }, o);
      if (!between.ok) throw new Error(between.said);
      expect(between.state.celebrations).toBe(1);
      expect(applyStage(between.state, { kind: "celebrate" }, o)).toMatchObject({ ok: true, state: { celebrations: 2 } });
    }
    expect(s).not.toHaveProperty("celebrations");
    expect(stageBytes(st)).toBeLessThan(STAGE_MAX_BYTES);
  });

  test("results in words the user reads, with what they show for the tool strip; handles are short and reused", () => {
    const s = initialStage();
    expect(applyStage(s, { kind: "scene", scene: "starry" }, o)).toMatchObject({ said: "Scene: Starry night", shown: { kind: "scene", label: "Scene", value: "Starry night" } });
    expect(applyStage(s, { kind: "mood", mood: "calm" }, o)).toMatchObject({ said: "Mood: calm", shown: { swatch: "#8EC5E8" } });
    expect(applyStage(s, { kind: "pin", text: "a\u202enote" }, { catalog, scenes: OWN_SCENES })).toMatchObject({ said: "Pinned: a note", shown: { handle: "n1" } });
    expect(nextHandle([{ id: "n1", text: "" }, { id: "n3", text: "" }])).toBe("n2");
    expect(nextHandle([{ id: "x9k2", text: "" }])).toBe("n1");
    expect(noteGist("x".repeat(60))).toBe("x".repeat(60));
    expect(noteGist("x".repeat(61))).toBe(`${"x".repeat(59)}…`);
    expect(noteGist(`${"word ".repeat(12)}more`)).toBe(`${"word ".repeat(12).slice(0, 59).trimEnd()}…`);
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
    expect(readStage({ v: 1, scene: "rain", mood: "joy", outfit: { hat: true, "<script>": true }, pinned: [{ id: "a", text: "x" }, { id: 1 }], nonce: 4, celebrations: 2 }))
      .toEqual({ v: 1, scene: "rain", mood: "joy", outfit: { hat: true }, pinned: [{ id: "a", text: "x" }], nonce: 4, celebrations: 2 });
    for (const bad of [-1, 2.5, "2", null]) expect(readStage({ v: 1, scene: "rain", nonce: 1, celebrations: bad })).not.toHaveProperty("celebrations");
    expect(readCatalog({ v: 1, expressions: ["smile", "smile"], motions: [], outfit: ["hat"] })).toEqual({ v: 1, expressions: ["smile"], motions: [], outfit: ["hat"] });
    expect(readCatalog({ v: 1, expressions: ["<img src=x>"] })).toMatchObject({ error: expect.any(String) });
    expect(readCatalog({ v: 1, expressions: Array.from({ length: 200 }, (_, i) => `e${i}`) })).toMatchObject({ error: expect.any(String) });
    expect(readCatalog("smile")).toMatchObject({ error: expect.any(String) });
  });

  test("a hostile page's catalogue: junk of any shape is refused, extra fields dropped, every list and the whole capped", () => {
    const bad: unknown[] = [
      null, 1, [], [1], { v: "1" }, { v: 2 }, { expressions: ["smile"] },
      { v: 1, expressions: "smile" }, { v: 1, expressions: { 0: "smile", length: 1 } }, { v: 1, expressions: [["smile"]] },
      { v: 1, expressions: [{ toString: "smile" }] }, { v: 1, expressions: [1, 2] }, { v: 1, expressions: [null] },
      { v: 1, motions: ["x".repeat(1_000_000)] }, { v: 1, outfit: Array.from({ length: NAMES_MAX + 1 }, (_, i) => `o${i}`) },
      { v: 1, expressions: Array(1_000_000).fill("smile") },
      Object.assign(Object.create({ v: 1, expressions: ["smile"] }) as object, {}),
      JSON.parse('{"__proto__": {"v": 1}, "expressions": ["smile"]}'),
    ];
    for (const raw of bad) expect("error" in readCatalog(raw)).toBe(true);
    // Only its own three lists are kept: nothing else in it reaches the store.
    expect(readCatalog(JSON.parse('{"v":1,"expressions":["smile"],"__proto__":{"polluted":true},"constructor":{"x":1},"extra":"yyyyyyyyy"}')))
      .toEqual({ v: 1, expressions: ["smile"], motions: [], outfit: [] });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    // At most NAMES_MAX names a list and CATALOG_MAX_BYTES in all: three full lists of long wide names are too much.
    const full = (p: string) => Array.from({ length: NAMES_MAX }, (_, i) => `${p}${i}`.padEnd(32, "脸"));
    expect(readCatalog({ v: 1, expressions: full("e"), motions: full("m"), outfit: full("o") })).toMatchObject({ error: expect.stringContaining(`${CATALOG_MAX_BYTES} bytes`) });
    const ok = readCatalog({ v: 1, expressions: Array.from({ length: NAMES_MAX }, (_, i) => `expression_${i}`), motions: [], outfit: [] });
    expect(ok).not.toHaveProperty("error");
    expect(stageBytes(ok as never)).toBeLessThanOrEqual(CATALOG_MAX_BYTES);
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

describe("when a note was pinned", () => {
  test("the time is kept with the note, survives a read, and a note without one stays without", () => {
    const r = applyStage(initialStage(), { kind: "pin", text: "tram 28" }, { scenes: OWN_SCENES, now: () => 1_700_000_000_000 });
    if (!r.ok) throw new Error(r.said);
    expect(r.state.pinned).toEqual([{ id: "n1", text: "tram 28", at: 1_700_000_000_000 }]);
    expect(readStage(JSON.parse(JSON.stringify(r.state))).pinned[0]?.at).toBe(1_700_000_000_000);
    expect(readStage({ v: 1, scene: "meadow", mood: "calm", outfit: {}, pinned: [{ id: "n1", text: "old" }], nonce: 0 }).pinned[0]).toEqual({ id: "n1", text: "old" });
  });
});
