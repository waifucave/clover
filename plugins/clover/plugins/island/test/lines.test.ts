import { describe, expect, test } from "bun:test";
import { arrange, cleanLine, LineBoard, lineSource, LINE_BACKOFF_MS, LINE_CALL_MS, LINE_ENTRIES_MAX, LINE_ICONS, LINE_QUIET_RECHECK_MS, LINE_TEXT_MAX, LINES_PER_PLUGIN, LINES_SHOWN, type LineEntry } from "../src/model/lines";

const e = (pluginId: string, entryId = "main"): LineEntry => ({ pluginId, entryId });

describe("what a sender's words become (cleanLine)", () => {
  test("plain text, one line, capped; markup is only text; control and bidi marks become spaces", () => {
    expect(cleanLine(e("p"), { text: "  Rendering\n frame   4 of 9 " })?.text).toBe("Rendering frame 4 of 9");
    expect(cleanLine(e("p"), { text: "<b>bold</b> <img src=x onerror=alert(1)>" })?.text).toBe("<b>bold</b> <img src=x onerror=alert(1)>");
    expect(cleanLine(e("p"), { text: "a‮b​c\u0000d" })?.text).toBe("a b c d");
    const long = cleanLine(e("p"), { text: "x".repeat(500) })!.text;
    expect([...long]).toHaveLength(LINE_TEXT_MAX);
    expect(long.endsWith("…")).toBe(true);
    expect(cleanLine(e("p"), { text: "   " })).toBeUndefined();
    expect(cleanLine(e("p"), { text: 7 })).toBeUndefined();
    expect(cleanLine(e("p"), "words")).toBeUndefined();
    expect(cleanLine(e("p"), null)).toBeUndefined();
    expect(cleanLine(e("p"), [{ text: "a" }])).toBeUndefined();
  });
  test("icon: the island's named set only; progress: clamped to 0..1, a non-number draws no bar; bot: an id or nothing", () => {
    for (const icon of LINE_ICONS) expect(cleanLine(e("p"), { text: "a", icon })?.icon).toBe(icon);
    expect(cleanLine(e("p"), { text: "a", icon: "../../x.svg" })?.icon).toBeUndefined();
    expect(cleanLine(e("p"), { text: "a", icon: "https://example.com/i.png" })?.icon).toBeUndefined();
    expect(cleanLine(e("p"), { text: "a", progress: 2 })?.progress).toBe(1);
    expect(cleanLine(e("p"), { text: "a", progress: -3 })?.progress).toBe(0);
    expect(cleanLine(e("p"), { text: "a", progress: 0.25 })?.progress).toBe(0.25);
    expect(cleanLine(e("p"), { text: "a", progress: Number.NaN })?.progress).toBeUndefined();
    expect(cleanLine(e("p"), { text: "a", progress: "0.5" })?.progress).toBeUndefined();
    // The bot's name stands only when the sender is that bot's own plugin (its id is the bot's id).
    expect(cleanLine(e("alpha"), { text: "a", bot: "alpha" })?.bot).toBe("alpha");
    expect(cleanLine(e("p"), { text: "a", bot: "alpha" })?.bot).toBeUndefined();
    expect(cleanLine(e("alpha"), { text: "a", bot: "Alpha <script>" })?.bot).toBeUndefined();
    expect(cleanLine(e("p"), { text: "a", bot: "x".repeat(65) })?.bot).toBeUndefined();
  });
  test("marks that draw nothing but pad or hide words become spaces: ALM, Mongolian separator, CGJ, Hangul fillers, braille blank, soft hyphen", () => {
    for (const code of ["061c", "180e", "034f", "115f", "3164", "2800", "00ad"]) {
      expect(cleanLine(e("p"), { text: `a${String.fromCharCode(parseInt(code, 16))}b` })?.text).toBe("a b");
    }
  });
  test("a sender sets nothing else: style, size, position and extra fields are dropped", () => {
    const line = cleanLine(e("p"), { text: "a", style: "position:fixed", className: "clv-card-shell", width: 9000, html: "<i>", onClick: "x" })!;
    expect(Object.keys(line).sort()).toEqual(["key", "pluginId", "text"]);
  });
  test("two plugins' lines never share a key, even with the same entry id", () => {
    expect(cleanLine(e("a", "main"), { text: "x" })!.key).not.toBe(cleanLine(e("b", "main"), { text: "x" })!.key);
  });
});

function board(over: { entries: LineEntry[]; answers: Record<string, unknown>; now?: () => number; hang?: Set<string> }) {
  let now = 0;
  const calls: string[] = [];
  const b = new LineBoard({
    entries: async () => over.entries,
    call: async (entry) => {
      const key = `${entry.pluginId}/${entry.entryId}`;
      calls.push(key);
      if (over.hang?.has(key)) return new Promise(() => undefined);
      const a = over.answers[key];
      if (a instanceof Error) throw a;
      return a;
    },
    now: over.now ?? (() => now),
    within: (p, ms) => Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out")), Math.min(ms, 20)))]),
  });
  return { b, calls, tick: (ms: number) => { now += ms; } };
}

describe("the board of lines (poll)", () => {
  test("lines come in the registry's order, a plugin's together, at most LINES_PER_PLUGIN each and LINES_SHOWN in all; the rest are counted", async () => {
    const entries = [e("a", "1"), e("b", "1"), e("a", "2"), e("a", "3"), e("c", "1"), e("d", "1"), e("e", "1")];
    const answers = Object.fromEntries(entries.map((x) => [`${x.pluginId}/${x.entryId}`, { text: `${x.pluginId}${x.entryId}` }]));
    const { b } = board({ entries, answers });
    const poll = await b.poll();
    expect(poll.lines.map((l) => l.text)).toEqual(["a1", "a2", "b1", "c1"]);
    expect(poll.more).toBe(2);
    expect(LINES_PER_PLUGIN).toBe(2);
    expect(LINES_SHOWN).toBe(4);
  });
  test("an entry that answers nothing draws nothing; a plugin gone from the entries has no line the next time", async () => {
    const answers: Record<string, unknown> = { "a/main": { text: "going" }, "b/main": { text: "stays" } };
    let entries = [e("a"), e("b")];
    const b = new LineBoard({ entries: async () => entries, call: async (x) => answers[`${x.pluginId}/${x.entryId}`], now: () => 0, within: (p) => p });
    expect((await b.poll()).lines.map((l) => l.text)).toEqual(["going", "stays"]);
    entries = [e("b")]; // a was turned off or removed
    expect((await b.poll()).lines.map((l) => l.text)).toEqual(["stays"]);
    answers["b/main"] = null; // the sender removes its line
    expect((await b.poll()).lines).toEqual([]);
  });
  test("a handler that throws or hangs shows nothing that time and does not hold the others; three in a row leave it alone for a while", async () => {
    let now = 0;
    const answers: Record<string, unknown> = { "bad/main": new Error("boom"), "slow/main": undefined, "good/main": { text: "fine" } };
    const { b, calls } = board({ entries: [e("bad"), e("slow"), e("good")], answers, hang: new Set(["slow/main"]), now: () => now });
    for (let i = 0; i < 3; i++) expect((await b.poll()).lines.map((l) => l.text)).toEqual(["fine"]);
    const before = calls.length;
    expect((await b.poll()).lines.map((l) => l.text)).toEqual(["fine"]);
    expect(calls.slice(before)).toEqual(["good/main"]); // bad and slow are left alone
    now += LINE_BACKOFF_MS + 1;
    await b.poll();
    expect(calls.slice(before + 1).sort()).toEqual(["bad/main", "good/main", "slow/main"]);
    expect(LINE_CALL_MS).toBeGreaterThan(0);
  });
  test("only the first LINE_ENTRIES_MAX entries are called", async () => {
    const entries = Array.from({ length: LINE_ENTRIES_MAX + 10 }, (_, i) => e(`p${i}`));
    const { b, calls } = board({ entries, answers: {} });
    await b.poll();
    expect(calls).toHaveLength(LINE_ENTRIES_MAX);
  });
  test("one plugin's entries are capped before the whole: a plugin with 40 entries cannot crowd another out of the 24", async () => {
    const entries = [...Array.from({ length: 40 }, (_, i) => e("greedy", `n${i}`)), e("modest", "one")];
    const { b, calls } = board({ entries, answers: {} });
    await b.poll();
    expect(calls.filter((c) => c.startsWith("greedy/"))).toHaveLength(LINES_PER_PLUGIN);
    expect(calls).toContain("modest/one");
  });
  test("a sender that answers nothing three asks in a row is left alone until woken (or the slow recheck); a line ends that", async () => {
    let now = 0;
    const answers: Record<string, unknown> = { "quiet/main": undefined, "busy/main": { text: "on" } };
    const { b, calls } = board({ entries: [e("quiet"), e("busy")], answers, now: () => now });
    for (let i = 0; i < 3; i++) await b.poll();
    const before = calls.length;
    await b.poll();
    expect(calls.slice(before)).toEqual(["busy/main"]);
    b.wake();
    for (let i = 0; i < 3; i++) await b.poll(); // asked afresh: three more empty answers before it is quiet again
    expect(calls.filter((c) => c === "quiet/main")).toHaveLength(6);
    await b.poll();
    expect(calls.filter((c) => c === "quiet/main")).toHaveLength(6);
    now += LINE_QUIET_RECHECK_MS + 1;
    await b.poll(); // the slow recheck: once, and quiet again straight after
    expect(calls.filter((c) => c === "quiet/main")).toHaveLength(7);
    await b.poll();
    expect(calls.filter((c) => c === "quiet/main")).toHaveLength(7);
    // It has a line now: asked every time.
    answers["quiet/main"] = { text: "hello" };
    b.wake();
    expect((await b.poll()).lines.map((l) => l.text)).toEqual(["hello", "on"]);
    const last = calls.length;
    await b.poll();
    expect(calls.slice(last).sort()).toEqual(["busy/main", "quiet/main"]);
    expect(b.entryCount).toBe(2);
  });
  test("one sender cannot touch another's line: each line is what its own entry's handler returned, under its own key", async () => {
    const { b } = board({ entries: [e("evil"), e("good")], answers: { "evil/main": { text: "I am good", pluginId: "good", key: "good\u0000main" }, "good/main": { text: "real" } } });
    const poll = await b.poll();
    expect(poll.lines.map((l) => [l.pluginId, l.text])).toEqual([["evil", "I am good"], ["good", "real"]]);
    expect(new Set(poll.lines.map((l) => l.key)).size).toBe(2);
    // The island words whose each is, from the registry's plugin id, never from the sender's fields.
    expect(poll.lines.map((l) => lineSource(l))).toEqual(["evil", "good"]);
  });
});

describe("whose a line is, in the island's words", () => {
  test("the plugin, and the bot when the line names one (its name when known)", () => {
    const own = cleanLine(e("alpha"), { text: "x", bot: "alpha" })!;
    expect(lineSource(own, (id) => (id === "alpha" ? "Alpha" : undefined))).toBe("alpha · Alpha");
    expect(lineSource(own)).toBe("alpha"); // no name known: the plugin alone
    // Another plugin naming a bot gets no name beside its line.
    const other = cleanLine(e("acme-render"), { text: "x", bot: "alpha" })!;
    expect(lineSource(other, () => "Alpha")).toBe("acme-render");
    expect(lineSource(cleanLine(e("acme-render"), { text: "x" })!)).toBe("acme-render");
  });
  test("arrange keeps the registry's order of plugins", () => {
    const l = (p: string, t: string) => cleanLine(e(p, t), { text: t })!;
    expect(arrange([l("a", "1"), l("b", "1"), l("a", "2")]).lines.map((x) => x.text)).toEqual(["1", "2", "1"]);
  });
});
