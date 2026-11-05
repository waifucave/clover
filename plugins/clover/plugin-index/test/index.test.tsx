import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { fakeCore, settle } from "../../shell/runtime/testkit";
import { runtimeWith } from "../../shell/runtime/ui";
import { plain } from "../../shell/runtime/views";
import { PluginIndexEntry, toResults } from "../client/entry";
import { UiRuntimeProvider } from "../client/sdk";
import { ENTRIES, INDEXES, NOW } from "../gallery/fixtures";

afterEach(cleanup);

async function mount(params: { spot?: string; key?: string } = {}, installState: "found" | "running" = "found") {
  const core = fakeCore({
    "plugin.index.list": () => ({ indexes: INDEXES }),
    "plugin.index.search": ({ query }) => ({ entries: ENTRIES.filter((e) => !query || e.id.includes(query) || plain(e.name).toLowerCase().includes(query.toLowerCase())) }),
    "plugin.install": ({ source }) => (source.id === "terminal-plus" ? Promise.reject(new Error("hash mismatch")) : { id: source.id, state: installState }),
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

  test("Installed plugins opens Settings' Plugins page", async () => {
    const { routes } = await mount();
    fireEvent.click(screen.getByRole("button", { name: "Installed plugins" }));
    expect(routes).toEqual([{ route: "settings", params: { section: "plugins" } }]);
  });
});
