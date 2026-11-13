import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { fakeCore, settle } from "../../shell/runtime/testkit";
import { runtimeWith } from "../../shell/runtime/ui";
import { plain } from "../../shell/runtime/views";
import { iconUrl, PluginIndexEntry, toDetail, toInstalled, toResults } from "../client/entry";
import { UiRuntimeProvider } from "../client/sdk";
import { Detail, PluginIcon, stateText } from "../client/Installed";
import { ENTRIES, INDEXES, INSTALLED, INSTALLED_ICONS, INSTALLED_LOG, INSTALLED_SETTINGS, installedDetail, NOW } from "../gallery/fixtures";

afterEach(cleanup);

/** How the fake core answers a setting's change, by key (a card's ask, a refusal); applied otherwise. */
const settingAnswers: Record<string, () => unknown> = {};
/** The development folders the fake core lists. */
let devFolders: { path: string; pluginId?: string; addedAt: number; expiresAt: number; lastReloadAt?: number }[] = [];
afterEach(() => {
  for (const k of Object.keys(settingAnswers)) delete settingAnswers[k];
  devFolders = [];
});

async function mount(params: { spot?: string; key?: string; tab?: string; id?: string } = { tab: "find" }, installState: "found" | "running" = "found", kept?: Map<string, string>) {
  const core = fakeCore({
    "plugin.list": () => ({ plugins: INSTALLED, adultConfirmed: false }),
    "plugin.ui": () => ({ plugins: Object.entries(INSTALLED_ICONS).map(([pluginId, icon]) => ({ pluginId, icon })) as never }),
    "plugin.get": ({ id }) => ({ plugin: installedDetail(id) }),
    "plugin.settings.get": ({ id }) => ({ settings: (INSTALLED_SETTINGS[id] ?? []) as never }),
    "plugin.auth.list": () => ({ auth: [] }),
    "plugin.logs": () => ({ lines: INSTALLED_LOG }),
    "plugin.remove": () => ({ applied: false, card: "card_1" }),
    "plugin.setEnabled": () => ({ applied: true }),
    "plugin.settings.set": ({ key }) => (settingAnswers[key]?.() ?? { applied: true }) as never,
    "plugin.restart": () => ({ ok: true }),
    "plugin.dev.list": () => ({ folders: devFolders as never }),
    "plugin.dev.add": () => ({ applied: false, card: "card_dev" }),
    "plugin.dev.remove": () => ({ ok: true }),
    "plugin.dev.renew": () => ({ applied: false, card: "card_renew" }),
    "plugin.grant.list": () => ({ grants: [{ token: "g1", path: "/Users/me/clips/a.mov", kind: "file", access: "read", addedAt: NOW }, { token: "g2", path: "/Users/me/exports", kind: "folder", access: "write", addedAt: NOW }] as never }),
    "plugin.grant.remove": () => ({ removed: true }),
    "plugin.setScope": () => ({ applied: true }),
    "plugin.setComputers": () => ({ applied: true }),
    "plugin.confirmAdult": () => ({ ok: true }),
    "computer.list": () => ({ computers: [{ name: "Studio" }, { name: "Laptop" }] as never }),
    "ui.secret": () => ({ opened: true }),
    "ui.pick": () => ({ token: "pick-1", name: "tarot" }),
    "plugin.update": ({ id, list }) => (list
      ? { updated: [], offered: [{ id: "tarot-panel", from: "1.2.0", to: "1.3.0", why: "you can apply it" }, { id: "mcp-linear", from: "0.0.0", to: "0.1.0", why: "it's pinned to its version" }] }
      : { updated: [], offered: [{ id: id!, from: "1.2.0", to: "1.3.0", why: "waiting for your yes on its card" }] }),
    "plugin.pin": () => ({ applied: true }),
    "notify.mutes": () => ({ muted: ["tarot-panel"] }),
    "notify.setMuted": () => ({ ok: true }),
    "plugin.index.add": () => ({ applied: false, card: "card_2" }),
    "plugin.index.remove": () => ({ applied: false, card: "card_3" }),
    "plugin.index.list": () => ({ indexes: INDEXES }),
    "plugin.index.search": ({ query }) => ({ entries: ENTRIES.filter((e) => !query || e.id.includes(query) || plain(e.name).toLowerCase().includes(query.toLowerCase())) }),
    "plugin.install": ({ source }) => {
      if (source.from === "wrap" && source.kind === "mcp-config") return { id: "mcp-a", state: "found", more: [{ id: "mcp-b", state: "found" }] } as never;
      if (source.from === "npm" && source.name === "bad") return Promise.reject(new Error("invalid: no such package"));
      const id = source.from === "index" ? source.id : "local";
      return id === "terminal-plus" ? Promise.reject(new Error("hash mismatch")) : { id, state: installState };
    },
  });
  const routes: unknown[] = [];
  render(
    <UiRuntimeProvider runtime={runtimeWith({ core: () => core, ...(kept ? { kept } : {}) })}>
      <PluginIndexEntry props={{ route: "plugins", params, navigate: (r) => routes.push(r), now: NOW }} />
    </UiRuntimeProvider>,
  );
  await act(() => settle());
  return { core, routes };
}

const rows = () => within(screen.getByRole("list", { name: "Results" })).getAllByRole("listitem");

describe("the plugin index", () => {
  test("results name their index and their newest version", () => {
    const results = toResults(ENTRIES, INDEXES);
    expect(results.map((r) => [r.id, r.indexName, r.version])).toEqual([
      ["tarot-panel", "Community plugins", "1.2.0"],
      ["weather-routine", "Community plugins", "0.3.1"],
      ["chibi-pack", "Community plugins", "2.1.0"],
      ["terminal-plus", "Friends' plugins", "0.9.0"],
      ["story-mode", "Friends' plugins", "0.1.0"],
    ]);
  });

  test("lists every result, marks what is installed, newer or for adults (no review mark), and the indexes", async () => {
    await mount();
    expect(rows().map((r) => r.querySelector(".cl-plugin-index__name")?.textContent)).toEqual(["Tarot panel", "Weather routine", "Chibi pack", "Terminal plus", "Story mode18+"]);
    expect(rows()[0]!.textContent).toContain("Installed 1.2.0");
    expect(rows()[2]!.textContent).toContain("2.1.0 available");
    expect(within(rows()[1]!).getByRole("button", { name: "Install Weather routine" })).toBeTruthy();
    const indexes = within(screen.getByRole("list", { name: "Indexes" })).getAllByRole("listitem");
    expect(indexes.map((i) => i.textContent)).toEqual([
      "Community pluginshttps://plugins.example.org/index.json · Checked 12 min ago",
      "Friends' pluginshttps://plugins.example.net/index.json · Checked 3 h ago",
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
    expect(rows().map((r) => r.querySelector(".cl-plugin-index__name")?.textContent)).toEqual(["Terminal plus"]);
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
    expect(core.calls.map((c) => c.method)).toEqual(["plugin.list", "plugin.ui"]);
    expect(groupNames()).toEqual(["Needs you", "On", "Off"]);
    expect(names("Needs you")).toEqual(["My panelIn development", "Story mode", "Weather routine"]);
    expect(names("On")).toEqual(["Clover", "linear", "Tarot panel"]);
    expect(names("Off")).toEqual(["Terminal plus"]);
    const clover = screen.getByRole("button", { name: "Open Clover" }).closest("li")!;
    expect(clover.textContent).toContain("2 parts");
    const story = screen.getByRole("button", { name: "Open Story mode" }).closest("li")!;
    expect(story.textContent).toContain("Can't load: needs a newer Clover");
    expect(within(story).getAllByRole("button").map((b) => b.textContent)).toEqual(["Open"]);
  });

  test("each row: its own picture (an image of its files on the app's route), Clover's mark for the app, else the puzzle; one line of what it is; no 0.0.0 for a wrapper", async () => {
    await mount({});
    const row = (name: string) => screen.getByRole("button", { name: `Open ${name}` }).closest("li")!;
    expect(row("Tarot panel").querySelector("img")?.getAttribute("src")).toBe("/_t/tarot-panel/assets/tarot%20card.png");
    expect(row("Clover").querySelector(".cl-plugin-index__mark")).toBeTruthy();
    expect(row("Clover").querySelector("img")).toBeNull();
    expect(row("linear").querySelector("img")).toBeNull();
    expect(row("linear").querySelector(".cl-plugin-index__mark")).toBeNull();
    expect(row("linear").querySelector("svg")).toBeTruthy();
    expect(row("Tarot panel").querySelector(".cl-plugin-index__line")?.textContent).toBe("Draws a card each morning and keeps a reading journal beside the conversation.");
    expect(row("linear").querySelector(".cl-plugin-index__meta")?.textContent).toBe("mcp-linear · Wrapped by Clover");
    expect(row("Clover").querySelector(".cl-plugin-index__meta")?.textContent).toContain("0.4.0");
  });

  test("a plugin off, waiting for its OK or without UI shows its manifest icon on the app's picture-only route; one that doesn't load is the puzzle", async () => {
    expect(toInstalled(INSTALLED, "en", INSTALLED_ICONS).find((p) => p.id === "terminal-plus")?.icon).toEqual({ url: "/_icon/terminal-plus", mayFail: true });
    // One with a picture `plugin.ui` names keeps that; one with neither has none.
    expect(toInstalled(INSTALLED, "en", INSTALLED_ICONS).find((p) => p.id === "tarot-panel")?.icon).toEqual({ url: "/_t/tarot-panel/assets/tarot%20card.png" });
    expect(toInstalled(INSTALLED, "en", INSTALLED_ICONS).find((p) => p.id === "weather-routine")?.icon).toBeUndefined();
    await mount({});
    // This test's world serves no picture: it doesn't load, and the row shows the puzzle.
    const row = screen.getByRole("button", { name: "Open Terminal plus" }).closest("li")!;
    const img = row.querySelector("img");
    if (img !== null) fireEvent.error(img);
    await act(() => settle());
    expect(row.querySelector("img")).toBeNull();
    expect(row.querySelector("svg")).toBeTruthy();
  });

  test("the picture-only route's URL names the tree, so a load that failed for one tree is tried again for the next", async () => {
    const withTree = INSTALLED.map((p) => (p.id === "terminal-plus" ? { ...p, treeHash: "sha256:aa" } : p));
    expect(toInstalled(withTree as never, "en", INSTALLED_ICONS).find((p) => p.id === "terminal-plus")?.icon).toEqual({ url: "/_icon/terminal-plus?v=sha256%3Aaa", mayFail: true });
    // This test's world serves no picture: the first tree's load fails, and the puzzle shows.
    const view = render(<PluginIcon icon={{ url: "/_icon/x?v=sha256%3Aaa", mayFail: true }} />);
    const img = view.container.querySelector("img");
    if (img !== null) fireEvent.error(img);
    expect(view.container.querySelector("img")).toBeNull();
    expect(view.container.querySelector("svg")).toBeTruthy();
    // The same plugin, a new tree: a new URL, tried.
    // (Here that load fails too, at once; what counts is that it was tried.)
    const tried: string[] = [];
    const seen = new MutationObserver((records) => {
      for (const r of records) for (const n of r.addedNodes) if (n instanceof HTMLImageElement) tried.push(n.getAttribute("src") ?? "");
    });
    seen.observe(view.container, { childList: true, subtree: true });
    view.rerender(<PluginIcon icon={{ url: "/_icon/x?v=sha256%3Abb", mayFail: true }} />);
    await act(() => settle());
    seen.disconnect();
    expect(tried).toEqual(["/_icon/x?v=sha256%3Abb"]);
  });

  test("a plugin whose client didn't build says why in its row (the registry's reason, as the core made it plain)", () => {
    expect(stateText("invalid", "its client didn't build: client/index.tsx: Could not resolve \"left-pad\"")).toBe(`${stateText("invalid", undefined)}: its client didn't build: client/index.tsx: Could not resolve "left-pad"`);
  });

  test("a picture only from the plugin's own files: never a remote one, an absolute path or a step out", () => {
    expect(iconUrl("tarot", "a/b.png")).toBe("/_t/tarot/a/b.png");
    for (const bad of ["https://x.example/a.png", "data:image/png;base64,AA", "/etc/a.png", "../a.png", "a//b.png", "a/../../b.png", ""]) expect(iconUrl("tarot", bad)).toBeUndefined();
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
    expect(core.calls.map((c) => c.method).slice(2).sort()).toEqual(["command.list", "computer.list", "notify.mutes", "plugin.auth.list", "plugin.get", "plugin.grant.list", "plugin.logs", "plugin.settings.get"]);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Tarot panel");
    expect(screen.getByText("You added it in the app.")).toBeTruthy();
    const what = screen.getByRole("region", { name: "What it may do" }).textContent;
    expect(what).toContain("Reads your bots' conversations");
    expect(what).toContain("Reaches api.tarot.example");
    expect(within(screen.getByRole("list", { name: "Tools it gives your bots" })).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["DrawCard", "ReadJournal"]);
    const settings = screen.getByRole("region", { name: "Settings" });
    expect((within(settings).getByRole("textbox", { name: "Deck" }) as HTMLInputElement).value).toBe("Rider–Waite");
    expect(settings.textContent).toContain("Tarot API keySaved");
    expect(screen.getByRole("region", { name: "Its log" }).textContent).toContain("drew The Star");
    // The key: the app's own dialog, never a field here.
    expect(settings.querySelector("[data-setting='TAROT_KEY'] input")).toBeNull();
    fireEvent.click(within(settings).getByRole("button", { name: "Replace or remove…" }));
    await act(() => settle());
    expect(core.calls.find((c) => c.method === "ui.secret")?.params).toEqual({ id: "tarot-panel", key: "TAROT_KEY" });
  });

  test("its plain settings are edited in place: a switch and a choice on the click, text and a number on Save or Enter; one that asks says so; a bot's has no control", async () => {
    const { core } = await mount({ id: "tarot-panel" });
    const answers = settingAnswers;
    const settings = screen.getByRole("region", { name: "Settings" });
    const sets = () => core.calls.filter((c) => c.method === "plugin.settings.set").map((c) => c.params);
    // A switch: saved on the click.
    fireEvent.click(within(settings).getByRole("switch", { name: "Reversed cards" }));
    await act(() => settle());
    // A choice, by its title (a language map's English).
    const spread = within(settings).getByRole("combobox", { name: "Spread" }) as HTMLSelectElement;
    expect(spread.value).toBe("celtic");
    expect([...spread.options].map((o) => o.textContent)).toEqual(["three", "Celtic cross"]);
    fireEvent.change(spread, { target: { value: "three" } });
    await act(() => settle());
    // A number: nothing until Save; empty puts the default back (null).
    const cards = within(settings).getByRole("spinbutton", { name: "Cards a day" }) as HTMLInputElement;
    expect([cards.min, cards.max]).toEqual(["1", "10"]);
    const save = (key: string) => within(settings.querySelector(`[data-setting='${key}']`) as HTMLElement).getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save("cards").disabled).toBe(true);
    fireEvent.change(cards, { target: { value: "7" } });
    expect(sets()).toHaveLength(2);
    fireEvent.click(save("cards"));
    await act(() => settle());
    fireEvent.change(cards, { target: { value: "" } });
    fireEvent.submit(cards.closest("form")!);
    await act(() => settle());
    // Text, by Enter (the form's submit).
    const deck = within(settings).getByRole("textbox", { name: "Deck" });
    fireEvent.change(deck, { target: { value: "Thoth" } });
    fireEvent.submit(deck.closest("form")!);
    await act(() => settle());
    expect(sets()).toEqual([
      { id: "tarot-panel", key: "reversed", value: true },
      { id: "tarot-panel", key: "spread", value: "three" },
      { id: "tarot-panel", key: "cards", value: 7 },
      { id: "tarot-panel", key: "cards", value: null },
      { id: "tarot-panel", key: "deck", value: "Thoth" },
    ]);
    // One whose value feeds what the plugin runs: the row says so, and a card's ask is said on the status line.
    const region = settings.querySelector("[data-setting='region']")!;
    expect(region.textContent).toContain("Changing this asks you first.");
    answers.region = () => ({ applied: false, card: "card_9" });
    fireEvent.change(within(region as HTMLElement).getByRole("textbox", { name: "Region" }), { target: { value: "us" } });
    fireEvent.click(save("region"));
    await act(() => settle());
    expect(screen.getByRole("status").textContent).toBe("Answer the card to change it.");
    // A refused change: why, and the field shows what the core holds again (the page read it again).
    answers.deck = () => Promise.reject(new Error("invalid: deck: a string of up to 8,192 characters"));
    const deck2 = within(settings).getByRole("textbox", { name: "Deck" }) as HTMLInputElement;
    fireEvent.change(deck2, { target: { value: "Too long" } });
    fireEvent.click(save("deck"));
    await act(() => settle());
    expect(screen.getByRole("status").textContent).toBe("That didn't work: deck: a string of up to 8,192 characters");
    expect((within(settings).getByRole("textbox", { name: "Deck" }) as HTMLInputElement).value).toBe("Rider–Waite");
    // A bot's setting: its value and where it is set, no control.
    const voice = settings.querySelector("[data-setting='voice']")!;
    expect(voice.querySelector("input, select, button")).toBeNull();
    expect(voice.textContent).toContain("Set per bot, in that bot's settings.");
  });

  test("a plugin that holds notify: its notifications' mute switch reads notify.mutes and sets it on a click; its agent definitions", async () => {
    const { core } = await mount({ id: "tarot-panel" });
    const sw = screen.getByRole("switch", { name: "Tarot panel's notifications" });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByRole("region", { name: "Notifications" }).textContent).toContain("Muted");
    fireEvent.click(sw);
    await act(() => settle());
    expect(core.calls.find((c) => c.method === "notify.setMuted")?.params).toEqual({ pluginId: "tarot-panel", muted: false });
    expect(screen.getByRole("region", { name: "Agent definitions" }).textContent).toContain("It adds an agent definition Reader: instructions an agent follows when your bot hands it work.");
  });

  test("the detail: the state as a badge beside the title, in the list's words", async () => {
    await mount({ id: "tarot-panel" });
    const head = screen.getByRole("heading", { level: 1 }).parentElement!;
    expect(head.querySelector(".cl-plugin-index__badge")?.textContent).toBe("On");
    expect(head.querySelector("img")?.getAttribute("src")).toBe("/_t/tarot-panel/assets/tarot%20card.png");
  });

  test("Clover's own notices are never muted here: no switch for the app's tree or its parts; a bundled bot's, like any plugin's, has one", () => {
    for (const id of ["clover", "clover/shell"]) {
      const d = { ...installedDetail("tarot-panel"), id, capabilities: ["notify"] } as never;
      expect(toDetail(d, {}).notifies).toBe(false);
    }
    for (const id of ["alpha", "tarot-panel"]) {
      const d = { ...installedDetail("tarot-panel"), id, capabilities: ["notify"] } as never;
      expect(toDetail(d, {}).notifies).toBe(true);
    }
  });

  test("a plugin's detail lists its child plugins' tools after its own", () => {
    const d = { ...installedDetail("tarot-panel"), manifest: { ...installedDetail("tarot-panel").manifest, contributes: { mcpServers: { own: { tools: { own_tool: "preload" } } } } } } as never;
    expect(toDetail(d, { childTools: ["kid_tool"] }).tools).toEqual(["own_tool", "kid_tool"]);
    expect(toDetail(d, {}).tools).toEqual(["own_tool"]);
  });

  test("an agent definition given as a file shows its name, cut like a named one", () => {
    const long = "x".repeat(200);
    const d = { ...installedDetail("tarot-panel"), manifest: { ...installedDetail("tarot-panel").manifest, contributes: { agents: [`agents/${long}.md`, { id: "r", name: long }] } } } as never;
    expect(toDetail(d, {}).agents.map((a: string) => a.length)).toEqual([80, 80]);
  });

  test("a yes that couldn't do what its card asked says why where the card's result shows, and the page reads again", async () => {
    const { core } = await mount({ id: "tarot-panel" });
    fireEvent.click(screen.getByRole("button", { name: "Remove…" }));
    await act(() => settle());
    const reads = core.calls.filter((c) => c.method === "plugin.list").length;
    act(() => core.emit("plugin_card_note", { type: "plugin_card_note", card: "card_1", change: "plugin-remove", note: "It was already removed." }));
    await act(() => settle());
    expect(screen.getByText("It was already removed.")).toBeTruthy();
    expect(core.calls.filter((c) => c.method === "plugin.list").length).toBeGreaterThan(reads);
  });

  test("a renew answered after the folder's 24 hours ended says so", async () => {
    const { core } = await mount({ tab: "add" });
    act(() => core.emit("plugin_card_note", { type: "plugin_card_note", card: "card_9", change: "dev-folder", note: "This folder's 24 hours had already ended; add it again from Plugins › Add." }));
    await act(() => settle());
    expect(screen.getByText("This folder's 24 hours had already ended; add it again from Plugins › Add.")).toBeTruthy();
  });

  test("a plugin without notify has no mute switch", async () => {
    await mount({ id: "mcp-linear" });
    expect(screen.queryByRole("region", { name: "Notifications" })).toBeNull();
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

  test("remove and delete its data sends deleteData with the id and asks on the card", async () => {
    const { core } = await mount({ id: "tarot-panel" });
    fireEvent.click(screen.getByRole("button", { name: "Remove and delete its data…" }));
    await act(() => settle());
    expect(core.calls.find((c) => c.method === "plugin.remove")?.params).toEqual({ id: "tarot-panel", deleteData: true });
    expect(screen.getByText("Answer the card to remove it.")).toBeTruthy();
  });

  test("no plugin is revoked or run anyway: no such group, filter or button (the owner's ruling, 2026-11-13)", async () => {
    await mount({ id: "story-mode" });
    expect(screen.getByRole("status").textContent).toContain("needs a newer Clover");
    expect(screen.queryByRole("button", { name: /anyway/i })).toBeNull();
    expect(document.body.textContent).not.toMatch(/revoked|reviewed|official/i);
  });
});

describe("the Plugins page: adding one", () => {
  test("a folder from main's picker: the page holds a token and the name, installs with the token once, and says its card waits", async () => {
    const { core } = await mount({ tab: "add" });
    expect(screen.getByText("Got a .zip? Unzip it first, then choose the folder.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Choose a folder…" }));
    await act(() => settle());
    expect(core.calls.find((c) => c.method === "ui.pick")?.params).toEqual({ kind: "folder", use: "plugin.install" });
    expect(screen.getByText("Chosen: tarot")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Install tarot" }));
    await act(() => settle());
    expect(core.calls.filter((c) => c.method === "plugin.install").map((c) => c.params)).toEqual([{ source: { from: "folder", path: "pick-1" } }]);
    expect(screen.getByRole("status").textContent).toBe("Answer the card: it asks for the plugin's OK before it runs.");
    expect(screen.queryByRole("button", { name: "Install tarot" })).toBeNull();
  });

  test("a Claude Code plugin or an agent file goes as a wrap of its token; an agent file asks the picker for a file", async () => {
    const { core } = await mount({ tab: "add" });
    fireEvent.click(screen.getByRole("radio", { name: "An agent file" }));
    fireEvent.click(screen.getByRole("button", { name: "Choose a file…" }));
    await act(() => settle());
    expect(core.calls.find((c) => c.method === "ui.pick")?.params).toEqual({ kind: "file", use: "plugin.install", filters: [{ name: "Agent", extensions: ["md"] }] });
    fireEvent.click(screen.getByRole("button", { name: "Install tarot" }));
    await act(() => settle());
    expect(core.calls.find((c) => c.method === "plugin.install")?.params).toEqual({ source: { from: "wrap", kind: "agent-file", value: "pick-1" } });
  });

  test("npm, a pasted config (one card per server) and an address; a refusal says why", async () => {
    const { core } = await mount({ tab: "add" });
    fireEvent.change(screen.getByRole("textbox", { name: "Package name" }), { target: { value: "clover-tarot" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Version (optional)" }), { target: { value: "1.2.0" } });
    fireEvent.click(within(screen.getByRole("region", { name: "From npm" })).getByRole("button", { name: "Install" }));
    await act(() => settle());
    fireEvent.change(screen.getByRole("textbox", { name: "MCP config" }), { target: { value: '{"mcpServers":{"a":{"command":"x"},"b":{"command":"y"}}}' } });
    fireEvent.click(screen.getByRole("button", { name: "Add the servers" }));
    await act(() => settle());
    expect(screen.getByRole("status").textContent).toBe("Answer the 2 cards: each asks for one plugin's OK before it runs.");
    fireEvent.change(screen.getByRole("textbox", { name: "MCP server address" }), { target: { value: "https://mcp.example.com/mcp" } });
    fireEvent.click(screen.getByRole("button", { name: "Add the server" }));
    await act(() => settle());
    expect(core.calls.filter((c) => c.method === "plugin.install").map((c) => c.params)).toEqual([
      { source: { from: "npm", name: "clover-tarot", version: "1.2.0" } },
      { source: { from: "wrap", kind: "mcp-config", value: '{"mcpServers":{"a":{"command":"x"},"b":{"command":"y"}}}' } },
      { source: { from: "wrap", kind: "mcp-url", value: "https://mcp.example.com/mcp" } },
    ]);
    fireEvent.change(screen.getByRole("textbox", { name: "Package name" }), { target: { value: "bad" } });
    fireEvent.click(within(screen.getByRole("region", { name: "From npm" })).getByRole("button", { name: "Install" }));
    await act(() => settle());
    expect(screen.getByRole("status").textContent).toBe("That didn't work: no such package");
  });
});

describe("the Plugins page: updates and indexes", () => {
  test("updates: what is newer with why; Apply asks the core for that one and says its card waits; Hold back pins it", async () => {
    const { core } = await mount({ tab: "updates" });
    const list = within(screen.getByRole("list", { name: "Updates" })).getAllByRole("listitem");
    expect(list.map((li) => li.textContent)).toEqual([
      "Tarot panel1.2.0 → 1.3.0you can apply itHold backApply",
      "linear0.0.0 → 0.1.0it's pinned to its versionLet it update",
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Apply Tarot panel's update" }));
    await act(() => settle());
    expect(core.calls.filter((c) => c.method === "plugin.update").map((c) => c.params)).toContainEqual({ id: "tarot-panel" });
    expect(screen.getByRole("status").textContent).toBe("Its update waits for your yes on its card.");
    fireEvent.click(screen.getByRole("button", { name: "Let it update" }));
    await act(() => settle());
    expect(core.calls.find((c) => c.method === "plugin.pin")?.params).toEqual({ id: "mcp-linear", pinned: false });
  });

  test("indexes: each added one with its health; add by address alone, remove on its card", async () => {
    const { core } = await mount({ tab: "indexes" });
    expect(screen.queryByRole("region", { name: "Clover's index" })).toBeNull();
    const yours = within(screen.getByRole("list", { name: "Indexes you added" })).getAllByRole("listitem");
    expect(yours.map((y) => y.querySelector(".cl-plugin-index__name")?.textContent)).toEqual(["Community plugins", "Friends' plugins"]);
    expect(yours[1]!.textContent).toContain("Checked 3 h ago");
    fireEvent.click(screen.getByRole("button", { name: "Remove Friends' plugins" }));
    await act(() => settle());
    expect(core.calls.find((c) => c.method === "plugin.index.remove")?.params).toEqual({ url: INDEXES[1]!.url });
    expect(screen.getByRole("status").textContent).toBe("Answer the card to go on.");
    const add = screen.getByRole("button", { name: "Add index" }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: "Index address (https://…)" }), { target: { value: "https://plugins.example.com/index.json" } });
    expect(screen.queryByRole("textbox", { name: /key/i })).toBeNull();
    fireEvent.click(add);
    await act(() => settle());
    expect(core.calls.find((c) => c.method === "plugin.index.add")?.params).toEqual({ url: "https://plugins.example.com/index.json" });
  });

  test("the detail holds an index plugin's updates back, or lets them through", async () => {
    const { core } = await mount({ id: "tarot-panel" });
    fireEvent.click(screen.getByRole("button", { name: "Hold back" }));
    await act(() => settle());
    expect(core.calls.find((c) => c.method === "plugin.pin")?.params).toEqual({ id: "tarot-panel", pinned: true });
  });

  test("the tab the user is on outlives a reload of the window's document (installing a plugin with its own layer), per route", async () => {
    const kept = new Map<string, string>();
    await mount({}, "found", kept);
    expect(screen.getByRole("tab", { selected: true }).textContent).toContain("Installed");
    fireEvent.click(screen.getByRole("tab", { name: /Updates/ }));
    await act(() => settle());
    // The document goes with no unmount (a reload runs no cleanup): the window's storage as it was.
    const atReload = new Map(kept);
    cleanup();
    await mount({}, "found", atReload);
    expect(screen.getByRole("tab", { selected: true }).textContent).toContain("Updates");
    // Left and opened again (an unmount): the first tab, as before.
    cleanup();
    await mount({}, "found", atReload);
    expect(screen.getByRole("tab", { selected: true }).textContent).toContain("Installed");
    // A link that names its own tab starts there.
    cleanup();
    await mount({ tab: "find" }, "found", atReload);
    expect(screen.getByRole("tab", { selected: true }).textContent).toContain("Find");
  });

  test("development folders: listed with when they expire and reload; a folder from main's picker is added on a card; Renew asks on a card; Remove stops loading it", async () => {
    devFolders = [{ path: "/Users/me/dev/reel", pluginId: "reel", addedAt: NOW - 3_600_000, expiresAt: NOW + 3_600_000, lastReloadAt: NOW - 60_000 }];
    const { core } = await mount({ tab: "add" });
    const row = document.querySelector('[data-dev-folder="/Users/me/dev/reel"]')!;
    expect(row.textContent).toContain("Loads as reel");
    expect(row.textContent).toContain("Loaded again");
    fireEvent.click(screen.getByRole("button", { name: "Choose a development folder…" }));
    await act(() => settle());
    expect(core.calls.find((c) => c.method === "ui.pick" && (c.params as { use: string }).use === "plugin.dev.add")?.params).toEqual({ kind: "folder", use: "plugin.dev.add" });
    fireEvent.click(screen.getByRole("button", { name: "Add tarot as a development folder" }));
    await act(() => settle());
    expect(core.calls.find((c) => c.method === "plugin.dev.add")?.params).toEqual({ path: "pick-1" });
    expect(screen.getAllByRole("status").some((e) => e.textContent === "Answer the card to add the development folder.")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Keep /Users/me/dev/reel on for another 24 hours" }));
    await act(() => settle());
    expect(core.calls.find((c) => c.method === "plugin.dev.renew")?.params).toEqual({ path: "/Users/me/dev/reel" });
    fireEvent.click(screen.getByRole("button", { name: "Remove the development folder /Users/me/dev/reel" }));
    await act(() => settle());
    expect(core.calls.find((c) => c.method === "plugin.dev.remove")?.params).toEqual({ path: "/Users/me/dev/reel" });
  });

  test("a plugin's page: where it works, the files it may open (each can be taken back), and the adult confirm", async () => {
    const { core } = await mount({});
    fireEvent.click(screen.getByRole("button", { name: "Open Tarot panel" }));
    await act(() => settle());
    fireEvent.click(screen.getByRole("radio", { name: "Agents" }));
    await act(() => settle());
    expect(core.calls.find((c) => c.method === "plugin.setScope")?.params).toEqual({ id: "tarot-panel", scope: "agents" });
    expect(document.querySelector('[data-grant="g1"]')?.textContent).toContain("/Users/me/clips/a.mov");
    expect(document.querySelector('[data-grant="g2"]')?.textContent).toContain("folder, to save");
    fireEvent.click(screen.getByRole("button", { name: "Take back /Users/me/clips/a.mov" }));
    await act(() => settle());
    expect(core.calls.find((c) => c.method === "plugin.grant.remove")?.params).toEqual({ pluginId: "tarot-panel", token: "g1" });
  });

  test("an adult plugin says so until the user confirms; the computers a server runs on are ticked one by one", () => {
    const calls: unknown[] = [];
    const view = { ...toDetail(installedDetail("tarot-panel"), {}), adult: true, computerTargets: [{ target: "tarot", ticked: ["Studio"] }] };
    render(
      <Detail
        plugin={view} adultConfirmed={false} computers={["Studio", "Laptop"]}
        onBack={() => undefined} onSwitch={() => undefined} onRestart={() => undefined} onRemove={() => undefined} onKey={() => undefined} onSignIn={() => undefined} onSignOut={() => undefined}
        onConfirmAdult={() => calls.push(["adult"])} onComputers={(t, c) => calls.push([t, c])}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "I am 18 or older" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Run on Laptop" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Run on Studio" }));
    expect(calls).toEqual([["adult"], ["tarot", ["Studio", "Laptop"]], ["tarot", []]]);
    cleanup();
    render(<Detail plugin={view} adultConfirmed computers={["Studio"]} onBack={() => undefined} onSwitch={() => undefined} onRestart={() => undefined} onRemove={() => undefined} onKey={() => undefined} onSignIn={() => undefined} onSignOut={() => undefined} onConfirmAdult={() => undefined} />);
    expect(screen.queryByRole("button", { name: "I am 18 or older" })).toBeNull();
  });

  test("a plugin's command keys: each shows its key, and bound or why not (the app's, too bare, shared, or not running)", () => {
    const base = installedDetail("tarot-panel");
    const d = { ...base, manifest: { ...base.manifest, contributes: { commands: [
      { name: "draw", key: "mod+shift+k" }, { name: "quit", key: "mod+q" }, { name: "bare", key: "k" }, { name: "both", key: "mod+j" }, { name: "off", key: "mod+u" }, { name: "plain" },
    ] } } } as never;
    const listed = [
      { name: "tarot.draw", pluginId: base.id, keyState: { state: "bound" } },
      { name: "tarot.quit", pluginId: base.id, keyState: { state: "app", what: "Quit" } },
      { name: "tarot.bare", pluginId: base.id, keyState: { state: "bare" } },
      { name: "tarot.both", pluginId: base.id, keyState: { state: "clash", with: ["other.go"] } },
    ];
    const keys = toDetail(d, { commands: listed }).commandKeys!;
    expect(keys.map((k) => [k.name, k.key, k.bound])).toEqual([["draw", "mod+shift+k", true], ["quit", "mod+q", false], ["bare", "k", false], ["both", "mod+j", false], ["off", "mod+u", false]]);
    expect(keys[1]!.note).toBe("Not bound: Quit already uses it.");
    expect(keys[3]!.note).toBe("Not bound: other.go uses it too.");
    expect(keys[4]!.note).toBe("Not bound: it isn't running.");
    render(<Detail plugin={toDetail(d, { commands: listed })} onBack={() => undefined} onSwitch={() => undefined} onRestart={() => undefined} onRemove={() => undefined} onKey={() => undefined} onSignIn={() => undefined} onSignOut={() => undefined} />);
    const list = screen.getByRole("list", { name: "Keys for its commands" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(5);
    expect(list.textContent).toContain("mod+shift+k");
    expect(list.textContent).toContain("Not bound: other.go uses it too.");
    expect(list.querySelectorAll("[data-key-bound]")).toHaveLength(1);
  });
});


