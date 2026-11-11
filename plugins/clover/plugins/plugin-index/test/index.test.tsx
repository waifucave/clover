import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { fakeCore, settle } from "../../shell/runtime/testkit";
import { runtimeWith } from "../../shell/runtime/ui";
import { plain } from "../../shell/runtime/views";
import { iconUrl, PluginIndexEntry, toDetail, toResults } from "../client/entry";
import { UiRuntimeProvider } from "../client/sdk";
import { stateText } from "../client/Installed";
import { ENTRIES, INDEXES, INSTALLED, INSTALLED_ICONS, INSTALLED_LOG, INSTALLED_SETTINGS, installedDetail, NOW } from "../gallery/fixtures";

afterEach(cleanup);

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
    "plugin.restart": () => ({ ok: true }),
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
    expect(core.calls.map((c) => c.method)).toEqual(["plugin.list", "plugin.ui"]);
    expect(groupNames()).toEqual(["Revoked", "Needs you", "On", "Off"]);
    expect(names("Revoked")).toEqual(["Story modeRevoked"]);
    expect(names("Needs you")).toEqual(["My panelIn development", "Weather routine"]);
    expect(names("On")).toEqual(["Clover", "linear", "Tarot panel"]);
    expect(names("Off")).toEqual(["Terminal plus"]);
    const clover = screen.getByRole("button", { name: "Open Clover" }).closest("li")!;
    expect(clover.textContent).toContain("2 parts");
    const story = screen.getByRole("button", { name: "Open Story mode" }).closest("li")!;
    expect(story.textContent).toContain("Revoked: revoked by Friends' plugins");
    // The list never offers to turn it on: only Open (its detail's override card).
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

  test("a plugin whose client didn't build says why in its row (the registry's reason, as the core made it plain)", () => {
    expect(stateText("invalid", "its client didn't build: client/index.tsx: Could not resolve \"left-pad\"")).toBe(`${stateText("invalid", undefined)}: its client didn't build: client/index.tsx: Could not resolve "left-pad"`);
  });

  test("a picture only from the plugin's own files: never a remote one, an absolute path or a step out", () => {
    expect(iconUrl("tarot", "a/b.png")).toBe("/_t/tarot/a/b.png");
    for (const bad of ["https://x.example/a.png", "data:image/png;base64,AA", "/etc/a.png", "../a.png", "a//b.png", "a/../../b.png", ""]) expect(iconUrl("tarot", bad)).toBeUndefined();
  });

  test("a revoked filter: only the revoked ones, with their reason (one kept since its index was removed among them)", async () => {
    await mount({});
    fireEvent.click(screen.getByRole("radio", { name: "Revoked (1)" }));
    expect(groupNames()).toEqual(["Revoked"]);
    expect(screen.getByRole("list", { name: "Revoked" }).textContent).toContain("revoked by Friends' plugins");
    fireEvent.click(screen.getByRole("radio", { name: "All" }));
    expect(groupNames()).toEqual(["Revoked", "Needs you", "On", "Off"]);
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
    expect(core.calls.map((c) => c.method).slice(2).sort()).toEqual(["notify.mutes", "plugin.auth.list", "plugin.get", "plugin.logs", "plugin.settings.get"]);
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

  test("a revoked plugin says it is blocked and offers to run it anyway, on its warning card", async () => {
    const { core } = await mount({ id: "story-mode" });
    expect(screen.getByRole("status").textContent).toContain("Blocked: revoked by Friends' plugins");
    expect(screen.queryByRole("button", { name: "Turn on" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Run it anyway…" }));
    await act(() => settle());
    expect(core.calls.find((c) => c.method === "plugin.setEnabled")?.params).toEqual({ id: "story-mode", enabled: true });
  });
});

describe("the Plugins page: adding one", () => {
  test("a folder from main's picker: the page holds a token and the name, installs with the token once, and says its card waits", async () => {
    const { core } = await mount({ tab: "add" });
    expect(screen.getByText("Got a .zip? Unzip it first, then choose the folder.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Choose a folder…" }));
    await act(() => settle());
    expect(core.calls.find((c) => c.method === "ui.pick")?.params).toEqual({ kind: "folder" });
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
    expect(core.calls.find((c) => c.method === "ui.pick")?.params).toEqual({ kind: "file", filters: [{ name: "Agent", extensions: ["md"] }] });
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

  test("indexes: the official slot says this build has none; each added one with its health; add by address and key, remove on its card", async () => {
    const { core } = await mount({ tab: "indexes" });
    // The fixtures' first index is marked official: a build with none shows the plain sentence instead.
    expect(screen.getByRole("region", { name: "Clover's index" }).textContent).toContain("Clover index");
    const yours = within(screen.getByRole("list", { name: "Indexes you added" })).getAllByRole("listitem");
    expect(yours[0]!.textContent).toContain("Checked 3 h ago");
    fireEvent.click(screen.getByRole("button", { name: "Remove Friends' plugins" }));
    await act(() => settle());
    expect(core.calls.find((c) => c.method === "plugin.index.remove")?.params).toEqual({ url: INDEXES[1]!.url });
    expect(screen.getByRole("status").textContent).toBe("Answer the card to go on.");
    const add = screen.getByRole("button", { name: "Add index" }) as HTMLButtonElement;
    fireEvent.change(screen.getByRole("textbox", { name: "Index address (https://…)" }), { target: { value: "https://plugins.example.org/index.json" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Its signing key (64 hex characters)" }), { target: { value: "not a key" } });
    expect(add.disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: "Its signing key (64 hex characters)" }), { target: { value: "a".repeat(64) } });
    fireEvent.click(add);
    await act(() => settle());
    expect(core.calls.find((c) => c.method === "plugin.index.add")?.params).toEqual({ url: "https://plugins.example.org/index.json", keys: ["a".repeat(64)] });
  });

  test("a build with no official index says so", async () => {
    const core = fakeCore({ "plugin.list": () => ({ plugins: [], adultConfirmed: false }), "plugin.index.list": () => ({ indexes: [INDEXES[1]!] }) });
    render(
      <UiRuntimeProvider runtime={runtimeWith({ core: () => core })}>
        <PluginIndexEntry props={{ route: "plugins", params: { tab: "indexes" }, now: NOW }} />
      </UiRuntimeProvider>,
    );
    await act(() => settle());
    expect(screen.getByText("The official index isn't set up in this build.")).toBeTruthy();
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
});
