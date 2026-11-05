// Pins the BrowserApi contract through FakeBrowser: partitions, the three places, the allow list, viewport-checked
// Points, the user's hold, scratch-only paths, resting tabs and stalled hosts.
import { describe, expect, test } from "bun:test";
import { AGENT_VIEWPORT, type Caller } from "@waifucave/clover-protocol";
import type { BrowserChange } from "../browser-api";
import { isContractError } from "../common";
import { FAKE_REST_AFTER_MS, FakeBrowser } from "../fakes/browser-api";
import { FakeClock } from "../fakes/clock";

const BOT: Caller = { kind: "session", sessionId: "s_alpha", sessionKind: "bot", bot: "alpha" };
const PLUGIN: Caller = { kind: "plugin", pluginId: "clover/browser-tool" };
const USER: Caller = { kind: "user", client: "app" };
const VIEW = { width: 900, height: 700 };
const rejection = async (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e);

function setup() {
  const clock = new FakeClock();
  const browser = new FakeBrowser({ clock, computer: "Studio", scratchOf: (bot) => `/Users/me/.clover/scratch/${bot}` });
  const changes: BrowserChange[] = [];
  browser.watch((c) => changes.push(c));
  return { clock, browser, changes };
}

describe("FakeBrowser", () => {
  test("a bot's tab opens headless at 1280×800 in the bot's own partition; the user's in theirs", async () => {
    const { browser } = setup();
    const tab = await browser.open({ owner: { kind: "bot", bot: "pack/luna" }, url: "https://example.com" }, PLUGIN);
    expect(tab).toMatchObject({ computer: "Studio", place: "headless", viewport: AGENT_VIEWPORT, partition: "persist:bot-pack--luna", heldByUser: false });
    const mine = await browser.open({ owner: { kind: "user" }, show: { view: "panel-1", viewport: VIEW } }, USER);
    expect(mine).toMatchObject({ place: "shown", viewport: VIEW, partition: "persist:user" });
    expect(browser.tabs({ owner: { kind: "user" } }).map((t) => t.id)).toEqual([mine.id]);
  });

  test("showing lays a tab out at the view's size; hiding brings back the agent's 1280×800, without reloading", async () => {
    const { browser } = setup();
    const tab = await browser.open({ owner: { kind: "bot", bot: "alpha" }, url: "https://a.example" }, PLUGIN);
    expect(await browser.show(tab.id, "panel-1", VIEW)).toMatchObject({ place: "shown", viewport: VIEW, url: "https://a.example" });
    expect(await browser.hide(tab.id)).toMatchObject({ place: "headless", viewport: AGENT_VIEWPORT, url: "https://a.example" });
  });

  test("DevTools calls pass the allow list", async () => {
    const { browser } = setup();
    const tab = await browser.open({ owner: { kind: "bot", bot: "alpha" } }, PLUGIN);
    browser.onCdp("Runtime.evaluate", (params) => ({ result: { value: (params as { expression: string }).expression.length } }));
    expect(await browser.cdp(tab.id, "Runtime.evaluate", { expression: "1+1" }, PLUGIN)).toEqual({ result: { value: 3 } });
    expect(await browser.cdp(tab.id, "Page.navigate", { url: "https://b.example" }, PLUGIN)).toEqual({});
    for (const denied of ["Target.createTarget", "Browser.close", "Storage.clearDataForOrigin", "SystemInfo.getInfo"]) {
      expect(isContractError(await rejection(browser.cdp(tab.id, denied, {}, PLUGIN)), "refused")).toBe(true);
    }
  });

  test("a Point from a picture of another size is refused", async () => {
    const { browser } = setup();
    const tab = await browser.open({ owner: { kind: "bot", bot: "alpha" } }, PLUGIN);
    const click = { type: "mousePressed", x: 10, y: 10, button: "left" };
    expect(await browser.cdp(tab.id, "Input.dispatchMouseEvent", click, PLUGIN, { viewport: AGENT_VIEWPORT })).toEqual({});
    await browser.show(tab.id, "panel-1", VIEW);
    expect(isContractError(await rejection(browser.cdp(tab.id, "Input.dispatchMouseEvent", click, PLUGIN, { viewport: AGENT_VIEWPORT })), "refused")).toBe(true);
  });

  test("while the user holds a tab, an agent's commands are refused and the user's are not", async () => {
    const { browser } = setup();
    const tab = await browser.open({ owner: { kind: "bot", bot: "alpha" } }, PLUGIN);
    browser.setHeld(tab.id, true);
    expect(isContractError(await rejection(browser.navigate(tab.id, "https://x.example", BOT)), "held")).toBe(true);
    expect(isContractError(await rejection(browser.cdp(tab.id, "Page.reload", {}, PLUGIN)), "held")).toBe(true);
    expect(isContractError(await rejection(browser.screenshot(tab.id, PLUGIN)), "held")).toBe(true);
    expect((await browser.navigate(tab.id, "https://mine.example", USER)).url).toBe("https://mine.example");
    browser.setHeld(tab.id, false);
    expect((await browser.navigate(tab.id, "https://x.example", BOT)).url).toBe("https://x.example");
  });

  test("a path in a DevTools call must sit in the bot's scratch folder", async () => {
    const { browser } = setup();
    const tab = await browser.open({ owner: { kind: "bot", bot: "alpha" } }, PLUGIN);
    expect(await browser.cdp(tab.id, "DOM.setFileInputFiles", { files: ["/Users/me/.clover/scratch/alpha/cv.pdf"], nodeId: 1 }, PLUGIN)).toEqual({});
    expect(isContractError(await rejection(browser.cdp(tab.id, "DOM.setFileInputFiles", { files: ["/Users/me/.ssh/id_ed25519"], nodeId: 1 }, PLUGIN)), "refused")).toBe(true);
    expect(isContractError(await rejection(browser.cdp(tab.id, "Page.setDownloadBehavior", { behavior: "allow", downloadPath: "/Users/me/.clover/scratch/alpha/../../settings" }, PLUGIN)), "refused")).toBe(true);
  });

  test("a tab no one uses rests, and goes back to the host before the next command", async () => {
    const { clock, browser, changes } = setup();
    const tab = await browser.open({ owner: { kind: "bot", bot: "alpha" } }, PLUGIN);
    clock.advance(FAKE_REST_AFTER_MS - 1);
    expect(browser.tabs()[0]!.place).toBe("headless");
    clock.advance(1);
    expect(browser.tabs()[0]!.place).toBe("resting");
    const shot = await browser.screenshot(tab.id, PLUGIN);
    expect(shot).toMatchObject({ width: 1280, height: 800, format: "png" });
    expect(changes.filter((c) => c.type === "changed").map((c) => (c.type === "changed" ? c.tab.place : ""))).toEqual(["headless", "resting", "headless"]);
  });

  test("a host that stopped drawing gives an error, never a stale picture", async () => {
    const { browser } = setup();
    const tab = await browser.open({ owner: { kind: "bot", bot: "alpha" } }, PLUGIN);
    browser.setStalled(tab.id, true);
    expect(isContractError(await rejection(browser.screenshot(tab.id, PLUGIN)), "failed")).toBe(true);
    browser.setStalled(tab.id, false);
    expect((await browser.screenshot(tab.id, PLUGIN)).width).toBe(1280);
  });

  test("DevTools events reach their listeners; closing says who closed", async () => {
    const { browser, changes } = setup();
    const tab = await browser.open({ owner: { kind: "bot", bot: "alpha" } }, PLUGIN);
    const got: [string, unknown][] = [];
    browser.onCdpEvent(tab.id, (m, p) => got.push([m, p]));
    browser.emitCdpEvent(tab.id, "Page.loadEventFired", { timestamp: 1 });
    expect(got).toEqual([["Page.loadEventFired", { timestamp: 1 }]]);
    await browser.close(tab.id, PLUGIN);
    expect(changes.at(-1)).toEqual({ type: "closed", id: tab.id, by: "api" });
    expect(isContractError(await rejection(browser.navigate(tab.id, "https://x.example", PLUGIN)), "not_found")).toBe(true);
  });
});
