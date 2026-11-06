// Settings on the runtime: Clover's own settings from the core and the plugin API, every change through them.
import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { computerView, deviceView, fakeApi, fakeCore, pluginDetail, pluginSummary, settle, uiPluginView } from "../../shell/runtime/testkit";
import type { EntryComponent, PluginDetail, PluginSummary } from "../../shell/runtime/types";
import { runtimeWith } from "../../shell/runtime/ui";
import { okWords, SettingsEntry } from "../client/entry";
import { UiRuntimeProvider } from "../client/sdk";

afterEach(cleanup);

const summary = (id: string, name: string, extra: Partial<PluginSummary> = {}): PluginSummary => pluginSummary(id, name, extra);
const PLUGINS = [
  summary("clover", "Clover"),
  summary("clover/notifications", "Desktop notifications"),
  summary("weather-routine", "Weather routine", { state: "found", enabled: false, source: "index" }),
  summary("story-mode", "Story mode", { state: "stopped", reason: "Stopped after three crashes in two minutes", source: "local" }),
  summary("night-tales", "Night tales", { state: "found", enabled: false, source: "local", adult: true }),
  summary("dusk", "Dusk", { state: "off", enabled: false, source: "local", adult: true }),
];
const detail = (p: PluginSummary, capabilities: string[], networkHosts: string[] = []): PluginDetail => pluginDetail(p, { capabilities, networkHosts });

async function mount(params: { section?: string; item?: string } = {}, extra: { component?: EntryComponent } = {}) {
  const core = fakeCore({
    "plugin.list": () => ({ plugins: PLUGINS }),
    "plugin.get": ({ id }) => {
      const d = detail(PLUGINS.find((p) => p.id === id)!, id === "weather-routine" ? ["notify", "network:api.weather.example"] : ["conversation.read", "call:clover"], id === "weather-routine" ? ["api.weather.example"] : []);
      if (id === "clover/notifications") d.manifest = { contributes: { notifiers: [{ id: "desktop" }] }, settings: { sounds: { type: "boolean", title: "Sounds" } } };
      if (id === "weather-routine") d.manifest = { settings: { units: { type: "enum", title: "Units", options: [{ value: "metric", title: "Celsius" }, "imperial"] }, hour: { type: "number", title: "Hour", min: 0, max: 23 }, apiKey: { type: "secret", title: "API key" } } };
      return { plugin: d };
    },
    "plugin.settings.get": ({ id }) => ({
      settings:
        id === "clover/notifications"
          ? [{ key: "sounds", type: "boolean" as const, title: "Sounds", scope: "account" as const, required: false, value: false, set: false }]
          : [
              { key: "units", type: "enum" as const, title: "Units", scope: "account" as const, required: false, value: "metric", set: false },
              { key: "hour", type: "number" as const, title: "Hour", scope: "account" as const, required: false, value: 7, set: false },
              { key: "apiKey", type: "secret" as const, title: "API key", scope: "account" as const, required: true, set: true },
              { key: "perBot", type: "string" as const, title: "Per bot", scope: "bot" as const, required: false, set: false },
            ],
    }),
    "plugin.settings.set": () => ({ applied: true }),
    "plugin.confirmAdult": () => ({ ok: true }),
    "plugin.setEnabled": () => ({ applied: true }),
    "plugin.logs": () => ({ lines: ["14:05 started", "14:06 TypeError: scene"] }),
    "plugin.ui": () => ({ plugins: [uiPluginView("clover/base-theme", [{ id: "base", file: "base.css" }], []), uiPluginView("midnight", [{ id: "night", file: "night.css" }], [{ lang: "de", file: "de.json" }])] }),
    "account.status": () => ({ signedIn: true, provider: "email", user: { id: "u1", name: "Sam" } }),
    "ui.settings": () => ({ picks: [], lists: [], language: "en-US", globalTheme: "midnight#night" }),
    "ui.set": () => ({ applied: true }),
    "computer.setLevel": () => ({ applied: false, card: "card-1" }),
    "device.revoke": () => ({ applied: false, card: "card-2" }),
    "main.set": () => ({ applied: false, card: "card-3" }),
    "device.pair.begin": () => ({ pairingId: "p1", code: "KQ7-M2P", expiresAt: 0 }),
    "device.pair.join": () => ({ pairingId: "p2", words: ["amber", "river", "lantern", "moss"], expiresAt: 0 }),
    "device.pair.confirm": () => ({ applied: false, card: "card-4" }),
    "device.pair.cancel": () => ({ ok: true }),
  });
  const api = fakeApi({
    computers: { list: async () => [computerView("Studio", { device: "d1", level: "ask-risky", link: "self", isMain: true }), computerView("Laptop", { device: "d2", level: "ask", link: "lan" })] },
    devices: { list: async () => [deviceView("d1", "Studio", { kind: "desktop", runsCore: true, isThis: true, isMain: true }), deviceView("d2", "Laptop", { kind: "desktop", runsCore: true }), deviceView("d3", "iPhone", { kind: "phone", runsCore: false })], watch: () => () => undefined },
    bots: { list: async () => [{ id: "alpha", name: "Alpha", model: "m", userLayer: [], state: "idle", mainSession: "s" }], get: async () => { throw new Error("x"); }, watch: () => () => undefined },
  });
  const routes: unknown[] = [];
  let closed = 0;
  const runtime = runtimeWith({
    api: () => api,
    core: () => core,
    spot: (name) => (name === "settings.section" ? { shape: "list" } : undefined),
    entries: extra.component ? [{ pluginId: "tarot-panel", id: "settings", spot: "settings.section", component: "Section", fields: { title: "Tarot" }, source: "installed", enabledAt: 1 }] : [],
    component: () => extra.component,
  });
  const tree = (at: typeof params) => (
    <UiRuntimeProvider runtime={runtime}>
      <SettingsEntry props={{ route: "settings", params: at, navigate: (r) => routes.push(r), close: () => closed++ }} />
    </UiRuntimeProvider>
  );
  const { rerender } = render(tree(params));
  await act(() => settle());
  /** A place opens Settings again while it is open (lane E's `useOpen`). */
  const reopen = async (at: typeof params) => {
    rerender(tree(at));
    await act(() => settle());
  };
  return { core, api, routes, closed: () => closed, reopen };
}

describe("settings on the runtime", () => {
  test("a plugin's OKs read in plain words", () => {
    expect(okWords({ capabilities: ["conversation.read", "call:tarot", "network:x.example", "something.new"], networkHosts: ["x.example"] })).toEqual([
      "Reads your bots' conversations", "Runs tarot's commands", "something.new", "Reaches x.example",
    ]);
  });

  test("the plugins page: each plugin's state, reason and OKs; the switch, the logs and the plugin index", async () => {
    const { core, routes } = await mount({ section: "plugins" });
    const weather = screen.getByText("Weather routine").closest(".cl-settings__row") as HTMLElement;
    expect(weather.textContent).toContain("Waits for your OK");
    expect(weather.textContent).toContain("Sends you notifications");
    expect(weather.textContent).toContain("Reaches api.weather.example");
    expect(screen.getByText("Story mode").closest(".cl-settings__row")!.textContent).toContain("Stopped after three crashes in two minutes");
    // A found plugin has no switch: its OK is reviewed on a card (S2).
    expect(within(weather).queryByRole("switch")).toBeNull();
    fireEvent.click(within(screen.getByText("Story mode").closest(".cl-settings__row") as HTMLElement).getByRole("switch"));
    await act(() => settle());
    expect(core.calls.filter((c) => c.method === "plugin.setEnabled").map((c) => c.params)).toEqual([{ id: "story-mode", enabled: false }]);
    fireEvent.click(screen.getByRole("button", { name: "Story mode's logs" }));
    await act(() => settle());
    expect(screen.getByText(/TypeError: scene/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByText("Weather routine")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open the plugin manager" }));
    expect(routes).toEqual([{ route: "plugins", params: {} }]);
  });

  test("levels: each computer's, and a change asks the core (a card)", async () => {
    const { core } = await mount({ section: "levels" });
    const select = screen.getAllByRole("combobox")[0] as HTMLSelectElement;
    expect(select.value).toBe("ask-risky");
    fireEvent.change(select, { target: { value: "automatic" } });
    await act(() => settle());
    expect(core.calls.filter((c) => c.method === "computer.setLevel").map((c) => c.params)).toEqual([{ name: "Studio", level: "automatic" }]);
  });

  test("devices: removing one asks the core; this device can't be removed", async () => {
    const { core } = await mount({ section: "devices" });
    expect(screen.queryByRole("button", { name: "Remove Studio" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Remove iPhone" }));
    await act(() => settle());
    expect(core.calls.filter((c) => c.method === "device.revoke").map((c) => c.params)).toEqual([{ id: "d3" }]);
  });

  test("appearance: the theme plugin, light or dark and the text size through `ui.set` (the user's UI choices); the language", async () => {
    const { core } = await mount({ section: "appearance" });
    const theme = screen.getByRole("combobox", { name: /theme/i }) as HTMLSelectElement;
    expect([...theme.options].map((o) => o.textContent)).toEqual(["Plain", "midnight"]);
    expect(theme.value).toBe("midnight#night");
    fireEvent.change(theme, { target: { value: "clover/base-theme#base" } });
    fireEvent.click(screen.getByRole("radio", { name: "Dark" }));
    fireEvent.click(screen.getByRole("radio", { name: "Large" }));
    await act(() => settle());
    expect(core.calls.filter((c) => c.method === "ui.set").map((c) => c.params)).toEqual([{ patch: { globalTheme: "clover/base-theme#base" } }, { patch: { appearance: "dark" } }, { patch: { textSize: "large" } }]);
    expect(screen.getByText("English (United States)")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    const chooser = screen.getByRole("dialog", { name: "Language" });
    fireEvent.click(within(chooser).getByRole("radio", { name: /Deutsch/ }));
    await act(() => settle());
    expect(core.calls.filter((c) => c.method === "ui.set").map((c) => c.params)).toContainEqual({ patch: { language: "de" } });
  });

  test("notifications are each notifier plugin's own declared settings; a change goes through `plugin.settings.set`", async () => {
    const { core } = await mount({ section: "notifications" });
    const group = screen.getByRole("group", { name: "Desktop notifications's settings" });
    fireEvent.click(within(group).getByRole("switch", { name: "Sounds" }));
    await act(() => settle());
    expect(core.calls.filter((c) => c.method === "plugin.settings.set").map((c) => c.params)).toEqual([{ id: "clover/notifications", key: "sounds", value: true }]);
  });

  test("a plugin's declared settings open under its row: choices and limits from its manifest, a secret never read back, a bot's own left to the bot", async () => {
    const { core } = await mount({ section: "plugins" });
    fireEvent.click(screen.getByRole("button", { name: "Weather routine's settings" }));
    const units = screen.getByRole("combobox", { name: "Units" }) as HTMLSelectElement;
    expect([...units.options].map((o) => [o.value, o.textContent])).toEqual([["metric", "Celsius"], ["imperial", "imperial"]]);
    fireEvent.change(units, { target: { value: "imperial" } });
    const hour = screen.getByRole("spinbutton", { name: "Hour" });
    fireEvent.change(hour, { target: { value: "30" } });
    fireEvent.blur(hour);
    expect(screen.getByRole("alert").textContent).toBe("At most 23.");
    fireEvent.change(hour, { target: { value: "6" } });
    fireEvent.blur(hour);
    const key = screen.getByRole("group", { name: "API key" }).querySelector("input")!;
    expect([key.type, key.value, key.placeholder]).toEqual(["password", "", "Stored"]);
    fireEvent.change(key, { target: { value: "sk-new" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.queryByText("Per bot")).toBeNull();
    await act(() => settle());
    expect(core.calls.filter((c) => c.method === "plugin.settings.set").map((c) => c.params)).toEqual([
      { id: "weather-routine", key: "units", value: "imperial" },
      { id: "weather-routine", key: "hour", value: 6 },
      { id: "weather-routine", key: "apiKey", value: "sk-new" },
    ]);
  });

  test("the 18+ gate: an adult plugin is switched on, or its OK asked for, only after the user confirms their age; off never asks", async () => {
    const { core } = await mount({ section: "plugins" });
    const asked = () => core.calls.filter((c) => c.method === "plugin.confirmAdult" || c.method === "plugin.setEnabled").map((c) => [c.method, c.params]);
    expect(screen.getByRole("group", { name: "Night tales" }).textContent).toContain("18+");
    fireEvent.click(screen.getByRole("button", { name: "Review Night tales's OK" }));
    const gate = screen.getByRole("alertdialog", { name: "Adult content" });
    expect(gate.textContent).toContain("Night tales says it may contain adult content");
    fireEvent.click(within(gate).getByRole("button", { name: "Cancel" }));
    expect(asked()).toEqual([]);
    fireEvent.click(screen.getByRole("switch", { name: "Dusk" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "I'm 18 or older" }));
    await act(() => settle());
    expect(asked()).toEqual([["plugin.confirmAdult", {}], ["plugin.setEnabled", { id: "dusk", enabled: true }]]);
    // Confirmed: the next one goes straight on.
    fireEvent.click(screen.getByRole("button", { name: "Review Night tales's OK" }));
    await act(() => settle());
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(asked().at(-1)).toEqual(["plugin.setEnabled", { id: "night-tales", enabled: true }]);
  });

  test("devices: choosing the main computer and pairing go through the core", async () => {
    const { core } = await mount({ section: "devices" });
    fireEvent.click(screen.getByRole("button", { name: "Make Laptop the main computer" }));
    fireEvent.click(screen.getByRole("button", { name: "Show a code" }));
    await act(() => settle());
    expect(screen.getByText("KQ7-M2P")).toBeTruthy();
    // The other device joins: this side hears the words.
    act(() => core.emit("pairing_changed", { pairingId: "p1", step: "words", words: ["amber", "river", "lantern", "moss"] }));
    fireEvent.click(screen.getByRole("button", { name: "They match" }));
    await act(() => settle());
    expect(screen.getByRole("button", { name: "Waiting for your OK" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Code from another device" }), { target: { value: "ZZ9" } });
    fireEvent.click(screen.getByRole("button", { name: "Join" }));
    await act(() => settle());
    expect(core.calls.filter((c) => c.method.startsWith("device.pair") || c.method === "main.set").map((c) => [c.method, c.params])).toEqual([
      ["main.set", { device: "d2" }],
      ["device.pair.begin", {}],
      ["device.pair.confirm", { pairingId: "p1", words: ["amber", "river", "lantern", "moss"] }],
      ["device.pair.cancel", { pairingId: "p1" }],
      ["device.pair.join", { code: "ZZ9" }],
    ]);
    expect(screen.getByRole("status").textContent).toContain("amber · river · lantern · moss");
  });

  test("reviewing a found plugin's OK asks the core to switch it on, which answers with the OK card", async () => {
    const { core } = await mount({ section: "plugins" });
    fireEvent.click(screen.getByRole("button", { name: "Review Weather routine's OK" }));
    await act(() => settle());
    expect(core.calls.filter((c) => c.method === "plugin.setEnabled").map((c) => c.params)).toEqual([{ id: "weather-routine", enabled: true }]);
  });

  test("opened at an item (lane E's useOpen): the row is brought into view and marked, until the user moves on", async () => {
    const shown: string[] = [];
    const scroll = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
      shown.push(this.dataset.item ?? "");
    };
    try {
      const { reopen } = await mount({ section: "devices", item: "d2" });
      const marked = () => [...document.querySelectorAll<HTMLElement>("[data-marked]")].map((el) => [el.dataset.item, el.getAttribute("aria-current")]);
      // The devices arrive after the page: the row is shown once it is there, and only once.
      expect(marked()).toEqual([["d2", "true"]]);
      expect(shown).toEqual(["d2"]);
      await reopen({ section: "devices", item: "d3" });
      expect(marked()).toEqual([["d3", "true"]]);
      await reopen({ section: "levels", item: "Laptop" });
      expect(screen.getByRole("region", { name: "Levels" })).toBeTruthy();
      expect(marked()).toEqual([["Laptop", "true"]]);
      expect(shown).toEqual(["d2", "d3", "Laptop"]);
      fireEvent.click(within(screen.getByRole("navigation", { name: "Sections" })).getByRole("button", { name: "Plugins" }));
      expect(marked()).toEqual([]);
    } finally {
      HTMLElement.prototype.scrollIntoView = scroll;
    }
  });

  test("pairing follows lane H's pairing_changed: a card waits, then the device is added, or it ends with why", async () => {
    const { core } = await mount({ section: "devices" });
    const begin = async () => {
      fireEvent.click(screen.getByRole("button", { name: "Show a code" }));
      await act(() => settle());
    };
    await begin();
    act(() => core.emit("pairing_changed", { pairingId: "other", step: "words", words: ["a", "b", "c", "d"] }));
    expect(screen.queryByText("a · b · c · d")).toBeNull();
    act(() => core.emit("pairing_changed", { pairingId: "p1", step: "words", words: ["amber", "river", "lantern", "moss"] }));
    act(() => core.emit("pairing_changed", { pairingId: "p1", step: "card" }));
    expect(screen.getByRole("button", { name: "Waiting for your OK" })).toBeTruthy();
    act(() => core.emit("pairing_changed", { pairingId: "p1", step: "done" }));
    expect(screen.queryByRole("status")).toBeNull();

    await begin();
    act(() => core.emit("pairing_changed", { pairingId: "p1", step: "expired" }));
    expect(screen.getByRole("status").textContent).toContain("The code expired.");
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(screen.queryByRole("status")).toBeNull();

    await begin();
    act(() => core.emit("pairing_changed", { pairingId: "p1", step: "failed", reason: { en: "the other device left" } }));
    expect(screen.getByRole("status").textContent).toContain("The pairing didn't finish: the other device left");
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    // An ended pairing has nothing to cancel.
    expect(core.calls.filter((c) => c.method === "device.pair.cancel")).toEqual([]);
  });

  test("the account and the bots, each opening in the bot editor", async () => {
    const { routes } = await mount({ section: "bots" });
    fireEvent.click(screen.getByRole("button", { name: "Edit Alpha" }));
    expect(routes).toEqual([{ route: "bot-editor", params: { bot: "alpha" } }]);
  });

  test("a section a plugin adds shows after Clover's own and draws its page", async () => {
    const Section: EntryComponent = () => <p>Tarot settings</p>;
    await mount({}, { component: Section });
    fireEvent.click(screen.getByRole("button", { name: "Tarot" }));
    expect(screen.getByText("Tarot settings")).toBeTruthy();
  });

  test("Close closes", async () => {
    const { closed } = await mount();
    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    expect(closed()).toBe(1);
  });
});
