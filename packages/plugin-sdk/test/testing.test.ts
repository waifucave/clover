// The test layer's resolver (ui/testing): which entries a spot shows, by the app's rules (spec §5.5). It was the shell's
// stand-in runtime's, and moved with it into the SDK's testing kit (F2b).
import { describe, expect, test } from "bun:test";
import { applies, entryRef, keyFit, resolveSpot, type TestEntry as UiEntry } from "../src/ui/testing";

const e = (pluginId: string, spot: string, extra: Partial<UiEntry> = {}): UiEntry => ({ pluginId, id: extra.id ?? spot, spot, source: "bundled", enabledAt: 0, component: "C", ...extra });

describe("resolveSpot", () => {
  test("a list shows every entry that applies, by order then plugin id; the user's order and hidden win", () => {
    const all = [e("b", "status", { order: 10 }), e("a", "status"), e("c", "status", { order: 10 }), e("d", "status", { when: { bot: "luna" } })];
    expect(resolveSpot("status", { shape: "list" }, all, {}).entries.map(entryRef)).toEqual(["b#status", "c#status", "a#status"]);
    const settings = { picks: [], lists: [{ spot: "status", order: ["a#status"], hidden: ["c#status"] }] };
    expect(resolveSpot("status", { shape: "list" }, all, {}, undefined, settings).entries.map(entryRef)).toEqual(["a#status", "b#status"]);
    expect(resolveSpot("status", { shape: "list" }, all, { bot: "luna" }).entries.map(entryRef)).toEqual(["b#status", "c#status", "a#status", "d#status"]);
  });

  test("a keyed cell: an exact key over a `*` pattern over a keyless entry", () => {
    const all = [e("any", "panel"), e("star", "panel", { key: "term*" }), e("exact", "panel", { key: "terminal" })];
    expect(resolveSpot("panel", { shape: "keyed" }, all, {}, "terminal").entries.map((x) => x.pluginId)).toEqual(["exact"]);
    expect(resolveSpot("panel", { shape: "keyed" }, all, {}, "terms").entries.map((x) => x.pluginId)).toEqual(["star"]);
    expect(resolveSpot("panel", { shape: "keyed" }, all, {}, "files").entries.map((x) => x.pluginId)).toEqual(["any"]);
    expect(resolveSpot("panel", { shape: "keyed" }, all, {}).entries).toEqual([]);
    expect([keyFit(undefined, "x"), keyFit("x*", "xy"), keyFit("x", "x"), keyFit("y", "x")]).toEqual([1, 2, 3, 0]);
  });

  test("`when.session` keeps the code-only panels to coding sessions", () => {
    const terminal = e("moss/panel-terminal", "panel", { key: "terminal", when: { session: "coding" } });
    expect(applies(terminal, { sessionKind: "coding" })).toBe(true);
    expect(applies(terminal, { sessionKind: "bot" })).toBe(false);
    expect(applies(terminal, {})).toBe(false);
  });

  test("the user's pick wins, for this bot first; a pick of nothing hides, except where the spot keeps the key", () => {
    const all = [e("moss/conversation", "conversation.message", { key: "approval" }), e("fancy", "conversation.message", { key: "approval", source: "installed" })];
    const decl = { shape: "keyed" as const, keep: ["approval"] };
    expect(resolveSpot("conversation.message", decl, all, {}, "approval").entries.map((x) => x.pluginId)).toEqual(["fancy"]);
    const picks = { lists: [], picks: [{ spot: "conversation.message", key: "approval", entry: "moss/conversation#conversation.message" }, { spot: "conversation.message", key: "approval", bot: "luna", entry: "fancy#conversation.message" }] };
    expect(resolveSpot("conversation.message", decl, all, {}, "approval", picks).entries.map((x) => x.pluginId)).toEqual(["moss/conversation"]);
    expect(resolveSpot("conversation.message", decl, all, { bot: "luna" }, "approval", picks).entries.map((x) => x.pluginId)).toEqual(["fancy"]);
    const none = { lists: [], picks: [{ spot: "conversation.message", key: "approval", entry: null }] };
    expect(resolveSpot("conversation.message", decl, all, {}, "approval", none).entries).toHaveLength(1);
    expect(resolveSpot("conversation.message", { shape: "keyed" }, all, {}, "approval", none).entries).toEqual([]);
  });

  test("one bot beats some, some beat all; installed beats bundled; a tie of the same kind is a conflict", () => {
    const one = e("one", "bot.stage", { when: { bot: "alpha" } });
    const some = e("some", "bot.stage", { when: { bot: ["alpha", "luna"] } });
    const all = e("all", "bot.stage", { source: "installed" });
    expect(resolveSpot("bot.stage", { shape: "single" }, [all, some, one], { bot: "alpha" }).entries[0]!.pluginId).toBe("one");
    expect(resolveSpot("bot.stage", { shape: "single" }, [all, some], { bot: "alpha" }).entries[0]!.pluginId).toBe("some");
    const older = e("older", "bot.stage", { enabledAt: 1 });
    const newer = e("newer", "bot.stage", { enabledAt: 2 });
    expect(resolveSpot("bot.stage", { shape: "single" }, [older, newer], {})).toEqual({ entries: [newer], conflict: true });
    expect(resolveSpot("bot.stage", { shape: "single" }, [older, all], {})).toEqual({ entries: [all], conflict: false });
  });

  test("a bot plugin's entries count as limited to its bot; a winning `hide` shows nothing", () => {
    const own = e("alpha", "bot.stage", { botPlugin: "alpha" });
    expect(resolveSpot("bot.stage", { shape: "single" }, [own], { bot: "luna" }).entries).toEqual([]);
    expect(resolveSpot("bot.stage", { shape: "single" }, [own, e("x", "bot.stage")], { bot: "alpha" }).entries).toEqual([own]);
    expect(resolveSpot("bot.stage", { shape: "single" }, [e("x", "bot.stage", { hide: true, source: "installed" }), e("y", "bot.stage")], {}).entries).toEqual([]);
  });
});

