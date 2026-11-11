// Settings on the runtime: Clover's own settings from the core and the plugin API, every change through them.
import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { computerView, deviceView, fakeApi, fakeCore, pluginDetail, pluginSummary, settle, uiPluginView } from "../../shell/runtime/testkit";
import type { EntryComponent, PluginDetail, PluginSummary } from "../../shell/runtime/types";
import { runtimeWith } from "../../shell/runtime/ui";
import { NOT_AVAILABLE_YET as PROTOCOL_REASON } from "../../../../../packages/protocol/src/plugins";
import { NOT_AVAILABLE_YET, okWords, SettingsEntry } from "../client/entry";
import { UiRuntimeProvider } from "../client/sdk";

afterEach(cleanup);

const summary = (id: string, name: string, extra: Partial<PluginSummary> = {}): PluginSummary => pluginSummary(id, name, extra);
const PLUGINS = [
  summary("clover", "Clover"),
  summary("weather-routine", "Weather routine", { state: "found", enabled: false, source: "index" }),
  summary("story-mode", "Story mode", { state: "stopped", reason: "Stopped after three crashes in two minutes", source: "local" }),
  // Clover's own plugin this build can't run yet: the registry keeps its switch on, and it is off with the reason.
  summary("clover/forwarder", "waifucave forwarder", { state: "off", enabled: true, reason: NOT_AVAILABLE_YET }),
];
const detail = (p: PluginSummary, capabilities: string[], networkHosts: string[] = []): PluginDetail => pluginDetail(p, { capabilities, networkHosts });

let uiSetFails = false;
let uiAppearance: "light" | "dark" | "system" | undefined;

async function mount(params: { section?: string; item?: string } = {}, extra: { component?: EntryComponent } = {}) {
  uiAppearance = undefined;
  const core = fakeCore({
    "plugin.list": () => ({ plugins: PLUGINS }),
    "plugin.get": ({ id }) => ({ plugin: detail(PLUGINS.find((p) => p.id === id)!, id === "weather-routine" ? ["notify", "network:api.weather.example"] : ["conversation.read", "call:clover"], id === "weather-routine" ? ["api.weather.example"] : []) }),
    "plugin.setEnabled": () => ({ applied: true }),
    "plugin.logs": () => ({ lines: ["14:05 started", "14:06 TypeError: scene"] }),
    "plugin.ui": () => ({ plugins: [uiPluginView("clover/base-theme", [{ id: "base", file: "base.css" }], []), uiPluginView("midnight", [{ id: "night", file: "night.css" }], [{ lang: "de", file: "de.json" }])] }),
    "account.status": () => ({ signedIn: true, provider: "email", user: { id: "u1", name: "Sam" } }),
    "ui.settings": () => ({ picks: [], lists: [], language: "en-US", globalTheme: "midnight#night", ...(uiAppearance === undefined ? {} : { appearance: uiAppearance }) }),
    "ui.set": (p) => { if (uiSetFails) throw new Error("refused"); const a = (p as { patch?: { appearance?: "light" | "dark" | "system" } }).patch?.appearance; if (a) uiAppearance = a; return { applied: true }; },
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

  test("the plugins page: each plugin's state and reason from one plugin.list; the switch, details, the logs and the plugin index", async () => {
    const { core, routes } = await mount({ section: "plugins" });
    // Never a call per plugin: what each may do is the Plugins page's, for the one opened.
    expect(core.calls.filter((c) => c.method === "plugin.get")).toEqual([]);
    const weather = screen.getByText("Weather routine").closest(".cl-settings__row") as HTMLElement;
    expect(weather.textContent).toContain("Waits for your OK");
    fireEvent.click(within(weather).getByRole("button", { name: "Weather routine's details" }));
    expect(routes).toEqual([{ route: "plugins", params: { id: "weather-routine" } }]);
    routes.length = 0;
    expect(screen.getByText("Story mode").closest(".cl-settings__row")!.textContent).toContain("Stopped after three crashes in two minutes");
    fireEvent.click(within(weather).getByRole("switch"));
    await act(() => settle());
    expect(core.calls.filter((c) => c.method === "plugin.setEnabled").map((c) => c.params)).toEqual([{ id: "weather-routine", enabled: true }]);
    // A plugin not available in this build yet: its reason, word for word the registry's, and nothing to switch, open
    // or read.
    expect(NOT_AVAILABLE_YET).toBe(PROTOCOL_REASON);
    const parked = screen.getByText("waifucave forwarder").closest(".cl-settings__row") as HTMLElement;
    expect(parked.textContent).toContain(NOT_AVAILABLE_YET);
    expect(within(parked).queryByRole("switch")).toBeNull();
    expect(within(parked).queryAllByRole("button")).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Story mode's logs" }));
    await act(() => settle());
    expect(screen.getByText(/TypeError: scene/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByText("Weather routine")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open the plugin manager" }));
    expect(routes).toEqual([{ route: "plugins", params: {} }]);
  });

  test("trust-changing controls (a computer's level, removing a device, the main computer, pairing) are not offered, and no bare call is made", async () => {
    const lv = await mount({ section: "levels" });
    const select = screen.getAllByRole("combobox")[0] as HTMLSelectElement;
    expect(select.value).toBe("ask-risky");
    expect(select.disabled).toBe(true);
    cleanup();
    const dv = await mount({ section: "devices" });
    expect(screen.queryByRole("button", { name: "Remove iPhone" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Make Laptop the main computer" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Show a code" })).toBeNull();
    for (const { core } of [lv, dv]) expect(core.calls.some((c) => /^(computer\.setLevel|device\.|main\.set)/.test(c.method))).toBe(false);
  });

  test("appearance: the theme plugin through `ui.set`; light or dark only as the core's `appearance` (the one main applies), the text size as this plugin's setting; the language", async () => {
    const { core, api } = await mount({ section: "appearance" });
    const theme = screen.getByRole("combobox", { name: /theme/i }) as HTMLSelectElement;
    expect([...theme.options].map((o) => o.textContent)).toEqual(["Plain", "midnight"]);
    expect(theme.value).toBe("midnight#night");
    fireEvent.change(theme, { target: { value: "clover/base-theme#base" } });
    fireEvent.click(screen.getByRole("radio", { name: "Dark" }));
    await act(() => settle());
    expect(core.calls.filter((c) => c.method === "ui.set").map((c) => c.params)).toEqual([{ patch: { globalTheme: "clover/base-theme#base" } }, { patch: { appearance: "dark" } }]);
    // One source: the core's `appearance`. The plugin keeps no copy of it.
    expect(api.stored.has("appearance.theme")).toBe(false);
    expect((screen.getByRole("radio", { name: "Dark" }) as HTMLElement).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("English (United States)")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    const chooser = screen.getByRole("dialog", { name: "Language" });
    fireEvent.click(within(chooser).getByRole("radio", { name: /Deutsch/ }));
    await act(() => settle());
    expect(core.calls.filter((c) => c.method === "ui.set").map((c) => c.params)).toContainEqual({ patch: { language: "de" } });
  });

  test("appearance: with no `appearance` in the core the theme shows System, whatever an old plugin-only copy says", async () => {
    await mount({ section: "appearance" });
    expect((screen.getByRole("radio", { name: "System" }) as HTMLElement).getAttribute("aria-checked")).toBe("true");
  });

  test("appearance: a ui.set that fails puts the theme control back and says so; a change made elsewhere shows after a pick", async () => {
    await mount({ section: "appearance" });
    const dark = screen.getByRole("radio", { name: "Dark" });
    uiSetFails = true;
    fireEvent.click(dark);
    await act(() => settle());
    expect(screen.getByRole("alert").textContent).toContain("wasn't changed");
    expect((screen.getByRole("radio", { name: "System" }) as HTMLElement).getAttribute("aria-checked")).toBe("true");
    uiSetFails = false;
  });

  test("Devices offers no pairing and the page listens for no pairing_changed (a part never hears that event: the app and the CLI do)", async () => {
    const { core } = await mount({ section: "devices" });
    const heard: string[] = [];
    const on = core.on.bind(core);
    core.on = ((event: string, fn: never) => { heard.push(event); return on(event as never, fn); }) as typeof core.on;
    fireEvent.click(screen.getByRole("button", { name: /Devices/ }));
    await act(() => settle());
    expect(screen.queryByRole("button", { name: /Show a code|Add a device|Join/ })).toBeNull();
    expect(core.calls.some((c) => c.method.startsWith("device.pair"))).toBe(false);
    expect(heard).not.toContain("pairing_changed");
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
