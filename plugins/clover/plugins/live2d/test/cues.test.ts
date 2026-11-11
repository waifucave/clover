import { describe, expect, test } from "bun:test";
import { SwitchDriver, catalogOf, cleanName, paramNames, readTable, switchNamed, switchesOf } from "../src/cues";
import { StageBridge } from "../src/ui/stage-bridge";

// A model made for a VTuber app, described the way its display info does, in its maker's language. The names are the
// kind a real model carries; none of its files are here.
const params = new Map<string, string>([
  ["key2", "2. 落泪"], ["key7", "7. 脸红"], ["key4", "4. 爱心眼"], ["key11", "11. 黑框眼镜"], ["key5", "5. > <眼"],
  ["Movement2", "2. 抚胸"], ["Clothes4", "4. 鞋子"], ["EyeSmile", "微笑"], ["ParamAngleX", "AngleX"],
]);

describe("a model's switches, by plain names", () => {
  test("a switch named in the maker's language answers to English names too, and to its own", () => {
    const sw = switchesOf({ expressions: [], motionGroups: [], params });
    expect(switchNamed(sw, "expression", "blush")?.how).toEqual({ type: "param", id: "key7" });
    expect(switchNamed(sw, "expression", "脸红")?.how).toEqual({ type: "param", id: "key7" });
    expect(switchNamed(sw, "expression", "sad")?.how).toEqual({ type: "param", id: "key2" });
    expect(switchNamed(sw, "expression", "love")?.how).toEqual({ type: "param", id: "key4" });
    expect(switchNamed(sw, "expression", "smile")?.how).toEqual({ type: "param", id: "EyeSmile" });
    expect(switchNamed(sw, "motion", "hand-on-chest")?.how).toEqual({ type: "param", id: "Movement2" });
    expect(switchNamed(sw, "outfit", "shoes")?.how).toEqual({ type: "param", id: "Clothes4" });
    // A parameter that is not a switch (a head angle) is never offered.
    expect(sw.some((s) => s.how.type === "param" && s.how.id === "ParamAngleX")).toBe(false);
  });

  test("a name the word list cannot place keeps its own, and a name with symbols is left out", () => {
    const sw = switchesOf({ expressions: [], motionGroups: [], params });
    expect(switchNamed(sw, "expression", "黑框眼镜")).toBeDefined();
    const names = catalogOf(sw).expressions;
    expect(names.every((n) => /^[\p{L}\p{N}_.-]{1,32}$/u.test(n))).toBe(true);
    expect(cleanName("7. 脸红")).toBe("脸红");
    expect(cleanName("4.　鞋子")).toBe("鞋子");
  });

  test("a model's settings expressions and motion groups are offered by their own names (idle is not a gesture)", () => {
    const sw = switchesOf({ expressions: ["smile", "angry_2"], motionGroups: ["Idle", "wave"], params: new Map() });
    expect(switchNamed(sw, "expression", "smile")?.how).toEqual({ type: "expression", name: "smile" });
    expect(switchNamed(sw, "motion", "wave")?.how).toEqual({ type: "motion", group: "wave" });
    expect(switchNamed(sw, "motion", "Idle")).toBeUndefined();
  });

  test("the avatar folder's table wins for the names it lists, and only plain names to plain ids", () => {
    const table = readTable({ expressions: { blush: "key2", "../x": "key7", cool: 3 }, motions: { bow: "Movement2" } });
    expect(table.expressions).toEqual({ blush: "key2" });
    const sw = switchesOf({ expressions: [], motionGroups: [], params }, table);
    expect(switchNamed(sw, "expression", "blush")?.how).toEqual({ type: "param", id: "key2" });
    expect(switchNamed(sw, "expression", "脸红")?.how).toEqual({ type: "param", id: "key7" });
    expect(switchNamed(sw, "motion", "bow")?.how).toEqual({ type: "param", id: "Movement2" });
  });

  test("display info is read as ids to names", () => {
    expect(paramNames({ Parameters: [{ Id: "key1", Name: "1. x" }, { Id: 3 }, "no"] })).toEqual(new Map([["key1", "1. x"]]));
    expect(paramNames(null).size).toBe(0);
  });
});

describe("the driver", () => {
  test("fades a parameter in, holds a gesture and lets it go, and goes quiet", () => {
    const seen: [string, number][] = [];
    const d = new SwitchDriver((id, v) => seen.push([id, v]), 0.3);
    d.turn("a", true, 1);
    for (let i = 0; i < 4; i++) d.update(0.1);
    expect(d.level("a")).toBeCloseTo(1, 5);
    for (let i = 0; i < 30; i++) d.update(0.1);
    expect(d.level("a")).toBe(0);
    expect(d.busy).toBe(false);
  });
});

describe("the bridge", () => {
  function fake() {
    const sets: [string, number][] = [];
    const started: string[] = [];
    const listeners: ((e: MessageEvent) => void)[] = [];
    const win = { document: { querySelectorAll: () => [] }, addEventListener: (_: string, f: (e: MessageEvent) => void) => listeners.push(f), removeEventListener: () => {} } as unknown as Window;
    const model = { setParameter: (id: string, v: number) => (sets.push([id, v]), true), startMotion: (g: string) => { started.push(g); return true; }, setExpression: () => true };
    const sw = switchesOf({ expressions: [], motionGroups: ["wave"], params });
    const b = new StageBridge({ botId: "alpha", win, switches: sw, model });
    b.start();
    return { b, sets, started, listeners };
  }

  test("a cue turns the switch its name belongs to on, and the one before it off", () => {
    const { b, sets } = fake();
    b.cue({ type: "clover.avatar.cue", nonce: 1, expression: "blush" });
    b.driver.update(0.5);
    expect(sets.some(([id, v]) => id === "key7" && v === 1)).toBe(true);
    b.cue({ type: "clover.avatar.cue", nonce: 2, expression: "sad" });
    for (let i = 0; i < 10; i++) b.driver.update(0.1);
    expect(b.driver.level("key7")).toBe(0);
    expect(b.driver.level("key2")).toBe(1);
  });

  test("the same nonce plays once; a settings motion group starts; an outfit follows its flag", () => {
    const { b, started } = fake();
    b.cue({ type: "clover.avatar.cue", nonce: 5, motion: "wave" });
    b.cue({ type: "clover.avatar.cue", nonce: 5, motion: "wave" });
    expect(started).toEqual(["wave"]);
    b.cue({ type: "clover.avatar.cue", outfit: { shoes: true } });
    b.driver.update(1);
    expect(b.driver.level("Clothes4")).toBe(1);
  });

  test("only a frame of the bot's own plugin is heard", () => {
    const { b, sets, listeners } = fake();
    const send = (origin: string) => listeners.forEach((f) => f({ origin, data: { type: "clover.avatar.cue", nonce: 9, expression: "blush" }, source: null } as unknown as MessageEvent));
    send("clover-plugin://mallory");
    b.driver.update(1);
    expect(sets).toEqual([]);
    send("clover-plugin://alpha");
    b.driver.update(1);
    expect(sets.length).toBeGreaterThan(0);
  });
});
