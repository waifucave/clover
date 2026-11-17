// Lane MA2's three pages under happy-dom, against MA's fake engine through MOSS's own engine seam (MossEngine): the
// side panel shows the live picture's frames as inert pixels with the publisher's name, says so plainly when no tool
// publishes, lists the routines, and has no input path at all; the Plugins page's two settings call tool.setAvailability
// and tool.setPermission, show the declared default and are worded apart; a key typed in Settings reaches the engine
// once and is never drawn back; a bot's page edits its record; and a bot's plugin settings are drawn from schemas this
// file makes up (two plugins nobody ships), so nothing in the page knows a plugin.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { daemonEndpoint, dial } from "../src/main/client";
import { MossEngine } from "../src/main/engine";
import { SealedFrames } from "../src/main/sealed";
import { mossHello } from "../src/main/connection";
import { startFakeEngine, type FakeEngine } from "./fake-engine/engine";
import type { BotSetting, MossBridge } from "../src/shared/view";

GlobalRegistrator.register();
const noop = new Proxy({}, { get: () => () => undefined });
(HTMLCanvasElement.prototype as unknown as { getContext: () => unknown }).getContext = () => noop;
afterAll(async () => { await GlobalRegistrator.unregister(); });

const { act, render, fireEvent } = await import("@testing-library/react");
const { createElement: h } = await import("react");
const { SidePanel, inertFrame } = await import("../src/window/panel/SidePanel");
const { PluginsPage, WHAT_MOSS_SHOWS } = await import("../src/window/plugins/PluginsPage");
const { SettingsPage, PluginSettings } = await import("../src/window/settings/SettingsPage");

/** A 1x1 PNG, the fixture picture's frame. */
const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64"));

const homes: string[] = [];
const closers: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
  for (const d of homes.splice(0)) rmSync(d, { recursive: true, force: true });
});

const settle = async (ms = 60): Promise<void> => { await act(async () => { await new Promise((r) => setTimeout(r, ms)); }); };
async function until(what: () => boolean, ms = 3_000): Promise<void> {
  const end = Date.now() + ms;
  while (!what()) {
    if (Date.now() > end) throw new Error("timed out");
    await settle(20);
  }
}

/** MOSS's window bridge over the real engine seam, as main wires it (no press gate: there is no main here). Every call
 *  the page makes is recorded by name. */
async function setup(): Promise<{ e: FakeEngine; engine: MossEngine; bridge: MossBridge; used: string[] }> {
  const home = mkdtempSync(join(tmpdir(), "ma2-"));
  homes.push(home);
  const e = await startFakeEngine({ home, picturePng: PNG, frameMs: 100 });
  closers.push(() => e.close());
  const client = (await dial(daemonEndpoint(home)))!;
  closers.push(() => client.close());
  await client.request("protocol.prove", { nonce: "n" });
  await client.request("protocol.hello", mossHello(e.token, "0.124.0", 1));
  const engine = new MossEngine(new SealedFrames("moss"));
  client.onNotification((m, p) => engine.notification(m, p));
  engine.setConnection("connected");
  await engine.attach(client);
  const none = () => () => {};
  const real: MossBridge = {
    view: async () => engine.view(), onView: (fn) => engine.onView(fn), showing: () => {},
    conversation: (b, before) => engine.conversation(b, before), onMessage: none,
    send: async () => ({ ok: true }), pickImages: async () => [], createBot: async () => ({ ok: false, why: "no" }), markRead: () => {},
    routines: (b) => engine.routines(b), pictures: (b) => engine.pictures(b), openPicture: (id) => engine.openPicture(id),
    closePicture: (id) => engine.closePicture(id), onPictureFrame: (fn) => engine.onPictureFrame(fn),
    cardFrame: async () => undefined, onCardHeight: none, onCardSaid: none, talk: () => {},
    plugins: () => engine.plugins(), setAvailability: (s, t, a) => engine.setAvailability(s, t, a),
    addPlugin: (from) => engine.addPlugin("link" in from ? from : { folder: "/nowhere" }),
    settings: () => engine.settings(), botSettings: (b) => engine.botSettings(b), setBotSetting: (b, p, k, v) => engine.setBotSetting(b, p, k, v),
    botInstructions: (id) => engine.botInstructions(id),
    setLevel: (c, l) => engine.setLevel(c, l), setPermission: (s, t, p) => engine.setPermission(s, t, p),
    signIn: (p, i, k) => engine.signIn(p, i, k), signOut: (p, i) => engine.signOut(p, i),
    botRecord: (id) => engine.botRecord(id), editBot: (id, patch) => engine.editBot(id, patch), models: () => engine.models(),
    archiveBot: (id) => engine.archiveBot(id), archivedBots: () => engine.archivedBots(), restoreBot: (id) => engine.restoreBot(id), retry: (b) => engine.retry(b), pictureInput: () => {},
  };
  const used: string[] = [];
  const bridge = new Proxy(real, { get: (t, k: string) => { const f = t[k as keyof MossBridge] as unknown; return typeof f === "function" ? (...a: unknown[]) => { used.push(k); return (f as (...x: unknown[]) => unknown)(...a); } : f; } });
  (window as unknown as { moss: MossBridge }).moss = bridge;
  return { e, engine, bridge, used };
}

const callsOf = (e: FakeEngine, method: string) => e.calls().filter((c) => c.method === method).map((c) => c.params as Record<string, unknown>);

describe("the side panel", () => {
  test("the bot's screen: live frames as inert pixels, the publisher beside them, the routines under it", async () => {
    const { engine } = await setup();
    const bot = engine.view().bots.find((b) => b.id === "juniper")!;
    const r = render(h(SidePanel, { bot, onClose: () => {}, onSettings: () => {} }));
    await until(() => r.container.querySelector(".screen img") !== null);
    const img = r.container.querySelector(".screen img") as HTMLImageElement;
    expect(img.getAttribute("src")?.startsWith("data:image/png;base64,")).toBe(true);
    expect(img.getAttribute("draggable")).toBe("false");
    const from = r.container.querySelector("[data-publisher]");
    expect(from?.getAttribute("data-publisher")?.length).toBeGreaterThan(0);
    expect(from?.textContent).toContain(from?.getAttribute("data-publisher") ?? "-");
    expect(from?.textContent?.replace(/\u00a0/g, " ")).toContain("From MOSS Browser (moss/browser) · watch only");
    expect(from?.textContent).toContain("watch only");
    expect(r.container.textContent).toContain("Juniper's screen");
    // The routines: three, one of them paused, each with its schedule in words.
    await until(() => r.container.querySelectorAll("[data-routine]").length === 3);
    expect(r.container.querySelectorAll("[data-routine][data-paused=true]").length).toBe(1);
    expect(r.container.querySelector("[data-routine=juniper-visa]")?.textContent).toContain("Paused");
    expect(r.container.querySelector("[data-routine=juniper-prices]")?.textContent).toContain("Every day at 7:00");
    // No share button (item 126); settings and close are there.
    const labels = [...r.container.querySelectorAll(".panel__head button")].map((b) => b.getAttribute("aria-label"));
    expect(labels).toEqual(["Juniper's settings", "Close the side panel"]);
    expect(r.container.textContent?.toLowerCase()).not.toContain("share");
    r.unmount();
  });

  test("the screen has no input path: nothing to focus, and pointer and keys reach nothing", async () => {
    const { e, engine, used } = await setup();
    const bot = engine.view().bots.find((b) => b.id === "juniper")!;
    const r = render(h(SidePanel, { bot, onClose: () => {} }));
    await until(() => r.container.querySelector(".screen img") !== null);
    const screen = r.container.querySelector(".screen")!;
    expect(screen.querySelectorAll("button, input, textarea, select, a, iframe, webview, [tabindex], [contenteditable]").length).toBe(0);
    expect(screen.querySelectorAll("img").length).toBe(1);
    const before = { used: used.length, calls: e.calls().length };
    const img = screen.querySelector("img")!;
    for (const target of [screen, img, screen.querySelector(".screen__view")!]) {
      fireEvent.pointerDown(target); fireEvent.mouseDown(target); fireEvent.click(target); fireEvent.dblClick(target);
      fireEvent.pointerUp(target); fireEvent.contextMenu(target); fireEvent.wheel(target);
      fireEvent.keyDown(target, { key: "a" }); fireEvent.keyDown(target, { key: "Enter" });
    }
    await settle(150);
    // Only the picture's own frames kept arriving, and main was told of the tries (it says "watch only" and sends nothing
    // on): no other bridge call, and no engine call came from any of it.
    const said = used.slice(before.used).filter((n) => n !== "onPictureFrame");
    expect(said.length).toBeGreaterThan(0);
    expect(said.every((n) => n === "pictureInput")).toBe(true);
    expect(e.calls().slice(before.calls).map((c) => c.method)).toEqual([]);
    r.unmount();
  });

  test("a bot with no tool publishing gets a plain state, and the panel never draws a frame that isn't an image", async () => {
    const { engine } = await setup();
    const bot = engine.view().bots.find((b) => b.id === "kite")!;
    const r = render(h(SidePanel, { bot, onClose: () => {} }));
    await until(() => r.container.querySelector("[data-screen-state=none]") !== null);
    expect(r.container.querySelector(".screen")?.textContent).toContain("Nothing on Kite's screen");
    expect(r.container.querySelectorAll(".screen img").length).toBe(0);
    r.unmount();
    expect(inertFrame("data:image/webp;base64,AAAA")).toBe("data:image/webp;base64,AAAA");
    for (const bad of ["data:text/html;base64,PGI+", "javascript:alert(1)", "https://example.test/x.png", "data:image/svg+xml;base64,PHN2Zz4=", "data:image/png;base64,AA\"onerror=x"]) {
      expect(inertFrame(bad)).toBeUndefined();
    }
  });
});

describe("the Plugins page", () => {
  test("each tool's two settings: availability with its declared default, and permission, each calling its own method", async () => {
    const { e } = await setup();
    const r = render(h(PluginsPage, {}));
    await until(() => r.container.querySelector("[data-server=moss_browser][data-tool=Fill]") !== null);
    expect(r.container.querySelector("[data-what-moss-shows]")?.textContent).toBe(WHAT_MOSS_SHOWS);
    const fill = r.container.querySelector("[data-server=moss_browser][data-tool=Fill]")!;
    const fillAvail = fill.querySelector("[data-setting=availability]")!;
    // Off now, though the plugin declares on demand: the default is marked on its own choice.
    expect(fillAvail.querySelector("[aria-checked=true]")?.getAttribute("data-value")).toBe("off");
    expect([...fillAvail.querySelectorAll("[data-declared=true]")].map((b) => b.getAttribute("data-value"))).toEqual(["on-demand"]);
    expect(fillAvail.querySelector("[data-declared=true]")?.textContent).toContain("default");
    // A preloaded tool's default is "always on".
    expect(r.container.querySelector("[data-server=moss_browser][data-tool=Open] [data-setting=availability] [data-declared=true]")?.getAttribute("data-value")).toBe("always");
    // The two are worded apart: "Off" is only availability, "Always block" only permission.
    const words = (el: Element) => [...el.querySelectorAll("button")].map((b) => b.getAttribute("data-value"));
    expect(words(fillAvail)).toEqual(["off", "on-demand", "always"]);
    expect(words(fill.querySelector("[data-setting=permission]")!)).toEqual(["allow", "ask", "deny"]);
    expect(fillAvail.textContent).not.toContain("block");
    expect(fill.querySelector("[data-setting=permission]")?.textContent).not.toContain("Off");
    expect(fillAvail.getAttribute("aria-label")).toBe("Fill: bots get it");
    expect(fill.querySelector("[data-setting=permission]")?.getAttribute("aria-label")).toBe("Fill: when a bot uses it");
    expect(r.container.querySelector(".ma2-legend")?.textContent).toContain("Always block refuses every use while the tool stays in sight");

    await act(async () => { fireEvent.click(fillAvail.querySelector("[data-value=always]")!); });
    await until(() => callsOf(e, "tool.setAvailability").length === 1);
    expect(callsOf(e, "tool.setAvailability")[0]).toEqual({ server: "moss_browser", tool: "Fill", availability: "always" });
    const typeRow = () => r.container.querySelector("[data-server=opensky][data-tool=Type]")!;
    expect(typeRow().querySelector("[data-setting=permission] [aria-checked=true]")?.getAttribute("data-value")).toBe("deny");
    await act(async () => { fireEvent.click(typeRow().querySelector("[data-setting=permission] [data-value=ask]")!); });
    await until(() => callsOf(e, "tool.setPermission").length === 1);
    expect(callsOf(e, "tool.setPermission")[0]).toEqual({ server: "opensky", tool: "Type", permission: "ask" });
    // The page shows what the engine says now.
    await until(() => typeRow().querySelector("[data-setting=permission] [aria-checked=true]")?.getAttribute("data-value") === "ask");
    // Setting the same value again sends nothing.
    await act(async () => { fireEvent.click(typeRow().querySelector("[data-setting=permission] [data-value=ask]")!); });
    await settle();
    expect(callsOf(e, "tool.setPermission").length).toBe(1);
    expect(callsOf(e, "tool.setAvailability").length).toBe(1);
    r.unmount();
  });

  test("adding from a link only starts the install (the OK card is the engine's)", async () => {
    const { e } = await setup();
    const r = render(h(PluginsPage, {}));
    await settle();
    const input = r.container.querySelector("input[aria-label=\"A plugin's link\"]") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "npm:moss-weather" } });
    await act(async () => { fireEvent.keyDown(input, { key: "Enter" }); });
    await until(() => callsOf(e, "plugin.install").length === 1);
    expect(callsOf(e, "plugin.install")[0]).toEqual({ source: { from: "npm", name: "moss-weather" } });
    await until(() => (r.container.textContent ?? "").includes("Look for its card"));
    expect([...r.container.querySelectorAll("button")].some((b) => b.textContent === "From a file…")).toBe(true);
    r.unmount();
  });
});

describe("Settings", () => {
  test("a key typed into MOSS's field reaches the engine once and is never drawn back", async () => {
    const { e } = await setup();
    const KEY = "PROBE_SECRET_dummy123";
    const r = render(h(SettingsPage, { bots: [] }));
    await until(() => r.container.querySelector("[data-sign-in=\"fish-audio#0\"] [data-key-field]") !== null);
    const field = r.container.querySelector("[data-sign-in=\"fish-audio#0\"] [data-key-field]") as HTMLInputElement;
    expect(field.type).toBe("password");
    expect(field.getAttribute("autocomplete")).toBe("off");
    fireEvent.change(field, { target: { value: KEY } });
    await act(async () => { fireEvent.keyDown(field, { key: "Enter" }); });
    await until(() => callsOf(e, "plugin.auth.signIn").length === 1);
    await settle(100);
    expect(callsOf(e, "plugin.auth.signIn")).toEqual([{ id: "fish-audio", index: 0, key: KEY }]);
    const visible = (): boolean => r.container.innerHTML.includes(KEY) || [...r.container.querySelectorAll("input, textarea")].some((i) => (i as HTMLInputElement).value.includes(KEY));
    expect(visible()).toBe(false);
    // Nor when the person opens the field again to replace it.
    const replace = [...r.container.querySelectorAll("[data-sign-in=\"fish-audio#0\"] button")].find((b) => b.textContent === "Replace key");
    if (replace !== undefined) { await act(async () => { fireEvent.click(replace); }); }
    expect(visible()).toBe(false);
    // The signed-in model provider offers sign-out, which the engine asks about on a card.
    const out = [...r.container.querySelectorAll("[data-sign-in=\"moss/model-anthropic#0\"] button")].find((b) => b.textContent === "Sign out")!;
    await act(async () => { fireEvent.click(out); });
    await until(() => callsOf(e, "plugin.auth.signOut").length === 1);
    expect(callsOf(e, "plugin.auth.signOut")[0]).toEqual({ id: "moss/model-anthropic", index: 0, card: true });
    r.unmount();
  });

  test("the account, each computer's approval level as a choice, and the devices", async () => {
    const { e } = await setup();
    const r = render(h(SettingsPage, { bots: [] }));
    await until(() => r.container.querySelector("[data-computer=Laptop] select") !== null);
    expect(r.container.querySelector("[data-settings=account]")?.textContent).toContain("Sam");
    expect(r.container.querySelector("[data-settings=devices]")?.textContent).toContain("Phone");
    const laptop = r.container.querySelector("[data-computer=Laptop] select") as HTMLSelectElement;
    expect(laptop.value).toBe("ask");
    await act(async () => { fireEvent.change(laptop, { target: { value: "automatic" } }); });
    // Choosing alone sends nothing (a native menu outlasts main's press); the button sends it.
    await settle();
    expect(callsOf(e, "computer.setLevel").length).toBe(0);
    await act(async () => { fireEvent.click([...r.container.querySelectorAll("[data-computer=Laptop] button")].find((b) => b.textContent === "Change")!); });
    await until(() => callsOf(e, "computer.setLevel").length === 1);
    expect(callsOf(e, "computer.setLevel")[0]).toEqual({ name: "Laptop", level: "automatic" });
    r.unmount();
  });

  test("one bot's page: its name, model, instructions size and face pins, each change a bot.edit", async () => {
    const { e, engine } = await setup();
    const bots = engine.view().bots;
    const r = render(h(SettingsPage, { bots, bot: "juniper" }));
    await until(() => r.container.querySelector("[data-bot-page=juniper] [data-model-picker]") !== null);
    const page = r.container.querySelector("[data-bot-page=juniper]")!;
    expect((page.querySelector("input[aria-label=\"The bot's name\"]") as HTMLInputElement).value).toBe("Juniper");
    const model = page.querySelector("[data-model-picker]") as HTMLSelectElement;
    expect(model.value).toBe("anthropic/claude-sonnet");
    expect([...model.options].map((o) => o.textContent)).toContain("GPT-5.4 mini · OpenAI (not signed in)");
    // The instructions as they are now (`bot.instructions.get`), edited in place.
    await until(() => page.querySelector("[data-instructions-text]") !== null);
    expect((page.querySelector("[data-instructions-text]") as HTMLTextAreaElement).value).toBe("You plan trips. Book nothing without asking, keep receipts in the Travel folder, prefer window seats.");
    expect(page.querySelectorAll("[data-shape]").length).toBe(10);
    expect(page.querySelectorAll("[data-color]").length).toBe(10);
    expect(page.querySelectorAll("[data-eyes]").length).toBe(4);
    expect(page.querySelectorAll("[data-temper]").length).toBe(4);
    expect(page.querySelector("[data-face-traits]")?.textContent).toMatch(/^Now: \w+, \w+, \w+ eyes, \w+\.$/);

    await act(async () => { fireEvent.click(page.querySelector("[data-shape=gem]")!); });
    await until(() => callsOf(e, "bot.edit").length === 1);
    expect(callsOf(e, "bot.edit")[0]).toEqual({ id: "juniper", patch: { face: { shape: "gem" } } });
    await settle();
    await act(async () => { fireEvent.click(r.container.querySelector("[data-bot-page=juniper] [data-temper=bright]")!); });
    await until(() => callsOf(e, "bot.edit").length === 2);
    expect(callsOf(e, "bot.edit")[1]).toEqual({ id: "juniper", patch: { face: { shape: "gem", temper: "bright" } } });
    await act(async () => { fireEvent.change(r.container.querySelector("[data-model-picker]")!, { target: { value: "" } }); });
    await settle();
    expect(callsOf(e, "bot.edit").length).toBe(2);
    await act(async () => { fireEvent.click([...r.container.querySelectorAll("[data-settings=model] button")].find((b) => b.textContent === "Save")!); });
    await until(() => callsOf(e, "bot.edit").length === 3);
    expect(callsOf(e, "bot.edit")[2]).toEqual({ id: "juniper", patch: { model: null } });
    // Unchanged instructions are never sent; a change is saved whole.
    const save = () => [...r.container.querySelectorAll("[data-settings=instructions] button")].find((b) => b.textContent === "Save instructions") as HTMLButtonElement;
    expect(save().disabled).toBe(true);
    await act(async () => { fireEvent.change(r.container.querySelector("[data-instructions-text]")!, { target: { value: "You plan trips. Ask first." } }); });
    await act(async () => { fireEvent.click(save()); });
    await until(() => callsOf(e, "bot.edit").length === 4);
    expect(callsOf(e, "bot.edit")[3]).toEqual({ id: "juniper", patch: { instructions: "You plan trips. Ask first." } });
    // The bot's settings from plugins: the fake's voice plugin, drawn from its schema.
    await until(() => r.container.querySelector("[data-plugin-settings=\"moss/voice\"] [data-bot-setting=voice] select") !== null);
    r.unmount();
  });

  test("a bot's plugin settings are drawn from any plugin's declared schema", async () => {
    const SECRET = "PROBE_SECRET_dummy456";
    const rows: BotSetting[] = [
      { pluginId: "acme/tides", pluginName: "Acme Tides", key: "current", type: "enum", title: "Current", description: "Which way it flows.", options: [{ value: "in", title: "Inward" }, { value: "out", title: "Outward" }, { value: "still", title: "Still" }], value: "out", set: true },
      { pluginId: "acme/tides", pluginName: "Acme Tides", key: "depth", type: "number", title: "Depth", min: 1, max: 9, value: 4, set: false },
      { pluginId: "acme/tides", pluginName: "Acme Tides", key: "night", type: "boolean", title: "Night tides", value: false, set: false },
      { pluginId: "zeta/lamp", pluginName: "Zeta Lamp", key: "motto", type: "string", title: "Motto", value: "glow on", set: true },
      { pluginId: "zeta/lamp", pluginName: "Zeta Lamp", key: "hue", type: "color", title: "Hue", value: "#3366ff", set: true },
      { pluginId: "zeta/lamp", pluginName: "Zeta Lamp", key: "token", type: "secret", title: "Lamp token", set: true },
    ];
    const set: { bot: string; pluginId: string; key: string; value: unknown }[] = [];
    (window as unknown as { moss: Partial<MossBridge> }).moss = {
      botSettings: async () => rows,
      setBotSetting: async (bot, pluginId, key, value) => { set.push({ bot, pluginId, key, value }); return true; },
    };
    const r = render(h(PluginSettings, { bot: "kite" }));
    await until(() => r.container.querySelectorAll("[data-plugin-settings]").length === 2);
    const group = (id: string) => r.container.querySelector(`[data-plugin-settings="${id}"]`)!;
    expect(group("acme/tides").querySelector("h2")?.textContent).toContain("Acme Tides");
    expect(group("zeta/lamp").querySelector("h2")?.textContent).toContain("Zeta Lamp");
    const current = group("acme/tides").querySelector("[data-bot-setting=current] select") as HTMLSelectElement;
    expect([...current.options].map((o) => o.textContent)).toEqual(["Inward", "Outward", "Still"]);
    expect(current.value).toBe("out");
    expect(group("acme/tides").querySelector("[data-bot-setting=current]")?.textContent).toContain("Which way it flows.");
    const depth = group("acme/tides").querySelector("[data-bot-setting=depth] input") as HTMLInputElement;
    expect([depth.type, depth.getAttribute("min"), depth.getAttribute("max")]).toEqual(["number", "1", "9"]);
    expect(group("acme/tides").querySelector("[data-bot-setting=depth]")?.textContent).toContain("default");
    expect((group("acme/tides").querySelector("[data-bot-setting=night] input") as HTMLInputElement).type).toBe("checkbox");
    expect((group("zeta/lamp").querySelector("[data-bot-setting=motto] input") as HTMLInputElement).value).toBe("glow on");
    expect((group("zeta/lamp").querySelector("[data-bot-setting=hue] input") as HTMLInputElement).type).toBe("color");
    const token = group("zeta/lamp").querySelector("[data-bot-setting=token] input") as HTMLInputElement;
    expect([token.type, token.value]).toEqual(["password", ""]);

    await act(async () => { fireEvent.change(current, { target: { value: "still" } }); });
    expect(set.length).toBe(0);
    await act(async () => { fireEvent.click([...group("acme/tides").querySelectorAll("[data-bot-setting=current] button")].find((b) => b.textContent === "Save")!); });
    // Out of range: not sent; in range, with Enter: sent as a number.
    fireEvent.change(depth, { target: { value: "12" } });
    await act(async () => { fireEvent.keyDown(depth, { key: "Enter" }); });
    fireEvent.change(depth, { target: { value: "7" } });
    await act(async () => { fireEvent.keyDown(depth, { key: "Enter" }); });
    await act(async () => { fireEvent.click(group("acme/tides").querySelector("[data-bot-setting=night] input")!); });
    fireEvent.change(token, { target: { value: SECRET } });
    await act(async () => { fireEvent.keyDown(token, { key: "Enter" }); });
    await settle();
    expect(set).toEqual([
      { bot: "kite", pluginId: "acme/tides", key: "current", value: "still" },
      { bot: "kite", pluginId: "acme/tides", key: "depth", value: 7 },
      { bot: "kite", pluginId: "acme/tides", key: "night", value: true },
      { bot: "kite", pluginId: "zeta/lamp", key: "token", value: SECRET },
    ]);
    // The secret's field was emptied as it was sent, and its value is drawn nowhere.
    expect(r.container.innerHTML.includes(SECRET)).toBe(false);
    expect([...r.container.querySelectorAll("input")].some((i) => i.value.includes(SECRET))).toBe(false);
    r.unmount();
  });
});
