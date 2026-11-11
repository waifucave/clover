import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { fakeCore, settle } from "../../shell/runtime/testkit";
import { runtimeWith } from "../../shell/runtime/ui";
import { plain } from "../../shell/runtime/views";
import { PluginIndexEntry, toResults } from "../client/entry";
import { UiRuntimeProvider } from "../client/sdk";
import { ENTRIES, INDEXES, INSTALLED, INSTALLED_LOG, INSTALLED_SETTINGS, installedDetail, NOW } from "../gallery/fixtures";

afterEach(cleanup);

async function mount(params: { spot?: string; key?: string; tab?: string; id?: string } = { tab: "find" }, installState: "found" | "running" = "found") {
  const core = fakeCore({
    "plugin.list": () => ({ plugins: INSTALLED, adultConfirmed: false }),
    "plugin.get": ({ id }) => ({ plugin: installedDetail(id) }),
    "plugin.settings.get": ({ id }) => ({ settings: (INSTALLED_SETTINGS[id] ?? []) as never }),
    "plugin.auth.list": () => ({ auth: [] }),
    "plugin.logs": () => ({ lines: INSTALLED_LOG }),
    "plugin.remove": () => ({ applied: false, card: "card_1" }),
    "plugin.setEnabled": () => ({ applied: true }),
    "plugin.restart": () => ({ ok: true }),
    "ui.secret": () => ({ opened: true }),
    "plugin.index.list": () => ({ indexes: INDEXES }),
    "plugin.index.search": ({ query }) => ({ entries: ENTRIES.filter((e) => !query || e.id.includes(query) || plain(e.name).toLowerCase().includes(query.toLowerCase())) }),
    "plugin.install": ({ source }) => {
      const id = source.from === "index" ? source.id : "local";
      return id === "terminal-plus" ? Promise.reject(new Error("hash mismatch")) : { id, state: installState };
    },
  });
  const routes: unknown[] = [];
  render(
    <UiRuntimeProvider runtime={runtimeWith({ core: () => core })}>
      <PluginIndexEntry props={{ route: "plugins", params, navigate: (r) => routes.push(r), now: NOW }} />
    </UiRuntimeProvider>,
  );
  await act(() => settle());
  return { core, routes };
}

const rows = () => within(screen.getByRole("list", { name: "Results" })).getAllByRole("listitem");

describe("the plugin index", () => {
  test("results name their index, their newest version and whether they are reviewed", () => {
    const results = toResults(ENTRIES, INDEXES);
    expect(results.map((r) => [r.id, r.indexName, r.version, r.official])).toEqual([
      ["tarot-panel", "Clover index", "1.2.0", true],
      ["weather-routine", "Clover index", "0.3.1", true],
      ["chibi-pack", "Clover index", "2.1.0", true],
      ["terminal-plus", "Friends' plugins", "0.9.0", false],
      ["story-mode", "Friends' plugins", "0.1.0", false],
    ]);
  });

  test("lists every result, marks what is installed, newer, unreviewed or for adults, and the indexes", async () => {
    await mount();
    expect(rows().map((r) => r.querySelector(".cl-plugin-index__name")?.textContent)).toEqual(["Tarot panel", "Weather routine", "Chibi pack", "Terminal plusNot reviewed", "Story mode18+Not reviewed"]);
    expect(rows()[0]!.textContent).toContain("Installed 1.2.0");
    expect(rows()[2]!.textContent).toContain("2.1.0 available");
    expect(within(rows()[1]!).getByRole("button", { name: "Install Weather routine" })).toBeTruthy();
    const indexes = within(screen.getByRole("list", { name: "Indexes" })).getAllByRole("listitem");
    expect(indexes.map((i) => i.textContent)).toEqual([
      "Clover indexOfficialhttps://github.com/waifucave/clover-index · Checked 12 min ago",
      "Friends' pluginsNot reviewedhttps://plugins.example.net/index.json · Checked 3 h ago",
    ]);
  });

  test("searching asks the core again", async () => {
    const { core } = await mount();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search the plugin index" }), { target: { value: "chibi" } });
    fireEvent.submit(screen.getByRole("search"));
    await act(() => settle());
    expect(core.calls.filter((c) => c.method === "plugin.index.search").map((c) => c.params)).toEqual([{ limit: 50 }, { query: "chibi", limit: 50 }]);
    expect(rows().map((r) => r.querySelector(".cl-plugin-index__name")?.textContent)).toEqual(["Chibi pack"]);
  });

  test("install asks the core; a plugin waiting for its OK says so, and a failed one can be tried again", async () => {
    const { core } = await mount();
    fireEvent.click(screen.getByRole("button", { name: "Install Weather routine" }));
    fireEvent.click(screen.getByRole("button", { name: "Install Terminal plus" }));
    await act(() => settle());
    expect(core.calls.filter((c) => c.method === "plugin.install").map((c) => c.params)).toEqual([
      { source: { from: "index", id: "weather-routine", index: INDEXES[0]!.url } },
      { source: { from: "index", id: "terminal-plus", index: INDEXES[1]!.url } },
    ]);
    expect(within(rows()[1]!).getByRole("status").textContent).toBe("Waiting for your OK");
    expect(within(rows()[3]!).getByRole("status").textContent).toBe("Couldn't install");
    expect(within(rows()[3]!).getByRole("button", { name: "Install Terminal plus" })).toBeTruthy();
  });

  test("from a placeholder: says what it is looking for, and searches for the key", async () => {
    const { core } = await mount({ spot: "panel", key: "terminal" });
    expect(screen.getByRole("note").textContent).toContain("Looking for a plugin for the terminal panel.");
    expect(core.calls.find((c) => c.method === "plugin.index.search")?.params).toEqual({ query: "terminal", limit: 50 });
    expect(rows().map((r) => r.querySelector(".cl-plugin-index__name")?.textContent)).toEqual(["Terminal plusNot reviewed"]);
  });

  test("the tabs: Installed and Find plugins", async () => {
    await mount();
    expect(screen.getByRole("tab", { name: "Find plugins" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: "Installed" }));
    expect(screen.getByRole("tab", { name: "Installed" }).getAttribute("aria-selected")).toBe("true");
  });
});

describe("the Plugins page: what is installed", () => {
  const groupNames = () => screen.getAllByRole("region").map((r) => r.getAttribute("aria-label"));
  const names = (group: string) => within(screen.getByRole("list", { name: group })).getAllByRole("listitem").map((li) => li.querySelector(".cl-plugin-index__name")?.textContent);

  test("one plugin.list, no call per plugin; grouped by what needs you, on and off; children under their parent", async () => {
    const { core } = await mount({});
    expect(core.calls.map((c) => c.method)).toEqual(["plugin.list"]);
    expect(groupNames()).toEqual(["Needs you", "On", "Off"]);
    expect(names("Needs you")).toEqual(["My panelIn development", "Story mode", "Weather routine"]);
    expect(names("On")).toEqual(["Clover", "linear", "Tarot panel"]);
    expect(names("Off")).toEqual(["Terminal plus"]);
    const clover = screen.getByRole("button", { name: "Open Clover" }).closest("li")!;
    expect(clover.textContent).toContain("2 parts");
    const story = screen.getByRole("button", { name: "Open Story mode" }).closest("li")!;
    expect(story.textContent).toContain("Blocked: revoked by Friends' plugins");
  });

  test("the search narrows by name, id or a part's name", async () => {
    await mount({});
    const search = screen.getByRole("searchbox", { name: "Search your plugins" });
    fireEvent.change(search, { target: { value: "tar" } });
    expect(groupNames()).toEqual(["On"]);
    expect(names("On")).toEqual(["Tarot panel"]);
    fireEvent.change(search, { target: { value: "terminal-" } });
    expect(names("Off")).toEqual(["Terminal plus"]);
    fireEvent.change(search, { target: { value: "settings" } });
    expect(names("On")).toEqual(["Clover"]);
    fireEvent.change(search, { target: { value: "spreadsheet" } });
    expect(screen.getByText("None of your plugins matches “spreadsheet”.")).toBeTruthy();
  });

  test("opened: what it is, where from, what it may do, its tools, its settings (a key only as saved), its log", async () => {
    const { core } = await mount({});
    fireEvent.click(screen.getByRole("button", { name: "Open Tarot panel" }));
    await act(() => settle());
    expect(core.calls.map((c) => c.method).slice(1).sort()).toEqual(["plugin.auth.list", "plugin.get", "plugin.logs", "plugin.settings.get"]);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Tarot panel");
    expect(screen.getByText("You added it in the app.")).toBeTruthy();
    const what = screen.getByRole("region", { name: "What it may do" }).textContent;
    expect(what).toContain("Reads your bots' conversations");
    expect(what).toContain("Reaches api.tarot.example");
    expect(within(screen.getByRole("list", { name: "Tools it gives your bots" })).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["DrawCard", "ReadJournal"]);
    const settings = screen.getByRole("region", { name: "Settings" });
    expect(settings.textContent).toContain("DeckRider–Waite");
    expect(settings.textContent).toContain("Tarot API keySaved");
    expect(screen.getByRole("region", { name: "Its log" }).textContent).toContain("drew The Star");
    // The key: the app's own dialog, never a field here.
    expect(settings.querySelector("input")).toBeNull();
    fireEvent.click(within(settings).getByRole("button", { name: "Replace or remove…" }));
    await act(() => settle());
    expect(core.calls.find((c) => c.method === "ui.secret")?.params).toEqual({ id: "tarot-panel", key: "TAROT_KEY" });
  });

  test("remove asks on the card and says so; back returns to the list", async () => {
    const { core } = await mount({ id: "tarot-panel" });
    fireEvent.click(screen.getByRole("button", { name: "Remove…" }));
    await act(() => settle());
    expect(core.calls.find((c) => c.method === "plugin.remove")?.params).toEqual({ id: "tarot-panel" });
    expect(screen.getByText("Answer the card to remove it.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /All plugins/ }));
    expect(screen.getByRole("tab", { name: "Installed" })).toBeTruthy();
  });

  test("a revoked plugin says it is blocked and offers to run it anyway, on its warning card", async () => {
    const { core } = await mount({ id: "story-mode" });
    expect(screen.getByRole("status").textContent).toContain("Blocked: revoked by Friends' plugins");
    expect(screen.queryByRole("button", { name: "Turn on" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Run it anyway…" }));
    await act(() => settle());
    expect(core.calls.find((c) => c.method === "plugin.setEnabled")?.params).toEqual({ id: "story-mode", enabled: true });
  });
});
