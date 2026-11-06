// The stand-in for lane E's runtime: which entries a spot shows (spec §5.5), and how <Spot> mounts them.
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { applies, entryRef, keyFit, resolveSpot, type UiEntry } from "../runtime/resolve";
import { fakeApi, fakeCore } from "../runtime/testkit";
import type { EntryComponent } from "../runtime/types";
import { runtimeWith, type UiRuntime } from "../runtime/ui";
import { Spot, useCore, useEntry, usePluginApi, useSpotEntries, UiRuntimeProvider, Card } from "../client/sdk";

afterEach(cleanup);

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
    const terminal = e("clover/panel-terminal", "panel", { key: "terminal", when: { session: "coding" } });
    expect(applies(terminal, { sessionKind: "coding" })).toBe(true);
    expect(applies(terminal, { sessionKind: "bot" })).toBe(false);
    expect(applies(terminal, {})).toBe(false);
  });

  test("the user's pick wins, for this bot first; a pick of nothing hides, except where the spot keeps the key", () => {
    const all = [e("clover/conversation", "conversation.message", { key: "approval" }), e("fancy", "conversation.message", { key: "approval", source: "installed" })];
    const decl = { shape: "keyed" as const, keep: ["approval"] };
    expect(resolveSpot("conversation.message", decl, all, {}, "approval").entries.map((x) => x.pluginId)).toEqual(["fancy"]);
    const picks = { lists: [], picks: [{ spot: "conversation.message", key: "approval", entry: "clover/conversation#conversation.message" }, { spot: "conversation.message", key: "approval", bot: "luna", entry: "fancy#conversation.message" }] };
    expect(resolveSpot("conversation.message", decl, all, {}, "approval", picks).entries.map((x) => x.pluginId)).toEqual(["clover/conversation"]);
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

describe("<Spot> and the hooks", () => {
  const Who: EntryComponent = ({ props, entry }) => {
    const api = usePluginApi();
    const core = useCore();
    const me = useEntry();
    return <p data-testid={`${entry.pluginId}`}>{`${api.plugin.id} ${core ? "core" : "no-core"} ${me?.spot}:${me?.key ?? ""} ${JSON.stringify(props)}`}</p>;
  };
  const Nested: EntryComponent = () => <Spot name="panel" spotKey="terminal" props={{ app: "terminal" }} fallback={<p data-testid="fallback">placeholder</p>} />;

  function runtime(entries: UiEntry[], extra: Partial<UiRuntime> = {}): UiRuntime {
    const core = fakeCore();
    return runtimeWith({
      spot: (name) => ({ "main": { shape: "keyed" as const }, panel: { shape: "keyed" as const }, status: { shape: "list" as const } })[name],
      entries,
      component: (_, name) => ({ Who, Nested })[name],
      api: (pluginId) => fakeApi({ pluginId }),
      core: () => core,
      sessionKind: (s) => (s === "s-code" ? "coding" : s === "s-bot" ? "bot" : undefined),
      ...extra,
    });
  }

  test("mounts each entry with its props and which entry it is; the API is the entry's own plugin's, the core only the clover tree's", () => {
    render(
      <UiRuntimeProvider runtime={runtime([e("clover/x", "status", { component: "Who" }), e("someone", "status", { component: "Who" })])}>
        <Spot name="status" props={{ n: 1 }} />
      </UiRuntimeProvider>,
    );
    expect(screen.getByTestId("clover/x").textContent).toBe('clover/x core status: {"n":1}');
    expect(screen.getByTestId("someone").textContent).toBe('someone no-core status: {"n":1}');
  });

  test("a spot with nothing in it shows its fallback; `only` picks one list entry; an undeclared spot shows nothing", () => {
    const rt = runtime([e("a", "status", { component: "Who" }), e("b", "status", { component: "Who" })]);
    const { rerender } = render(
      <UiRuntimeProvider runtime={rt}>
        <Spot name="status" only="b#status" />
        <Spot name="nowhere" fallback={<p>fallback</p>} />
      </UiRuntimeProvider>,
    );
    expect(screen.queryByTestId("a")).toBeNull();
    expect(screen.getByTestId("b")).toBeTruthy();
    expect(screen.getByText("fallback")).toBeTruthy();
    rerender(
      <UiRuntimeProvider runtime={runtimeWith({})}>
        <Spot name="status" fallback={<p>empty</p>} />
      </UiRuntimeProvider>,
    );
    expect(screen.getByText("empty")).toBeTruthy();
  });

  test("the session's kind flows down to the spots inside an entry, for `when.session`", () => {
    const entries = [
      e("clover/shell", "main", { key: "agent", component: "Nested" }),
      e("clover/panel-terminal", "panel", { key: "terminal", component: "Who", when: { session: "coding" } }),
    ];
    const { rerender } = render(
      <UiRuntimeProvider runtime={runtime(entries)}>
        <Spot name="main" spotKey="agent" props={{ session: "s-code" }} />
      </UiRuntimeProvider>,
    );
    expect(screen.getByTestId("clover/panel-terminal").textContent).toBe('clover/panel-terminal core panel:terminal {"app":"terminal"}');
    rerender(
      <UiRuntimeProvider runtime={runtime(entries)}>
        <Spot name="main" spotKey="agent" props={{ session: "s-bot" }} />
      </UiRuntimeProvider>,
    );
    expect(screen.getByTestId("fallback")).toBeTruthy();
  });

  test("useSpotEntries says what a spot would show, for parts that lay entries out themselves", () => {
    const Lister = () => <p>{useSpotEntries("status").entries.map(entryRef).join(",")}</p>;
    render(
      <UiRuntimeProvider runtime={runtime([e("b", "status"), e("a", "status")])}>
        <Lister />
      </UiRuntimeProvider>,
    );
    expect(screen.getByText("a#status,b#status")).toBeTruthy();
  });

  test("a card with no sealed renderer around it says where it can show", () => {
    render(
      <UiRuntimeProvider runtime={runtimeWith({})}>
        <Card id="card-1">
          <Card.Field name="title" />
        </Card>
      </UiRuntimeProvider>,
    );
    expect(screen.getByText("This approval card can only show in Clover's own window.")).toBeTruthy();
  });
});
