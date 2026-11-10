// The browser's protocol methods served to the app, layers and peers (`methods.ts`): the app's own `browser.*` calls
// reach the service as the caller the server gives them, refusals keep the browser's code, and `hold`, `stream` and
// `report` check who calls.
import { describe, expect, test } from "bun:test";
import { BROWSER_METHODS, ERR, CLOVER_ERR, type Caller } from "@waifucave/clover-protocol";
import type { MethodContext } from "../../src/rpc/handler";
import { browserMethodHandlers, BrowserService } from "../../src/browser";
import { FakeApp } from "./fakes";

const M = BROWSER_METHODS;
const as = (caller: Caller): MethodContext => ({ caller });
const user = as({ kind: "user", client: "app" });
const session = as({ kind: "session", sessionId: "sess_a", sessionKind: "bot", bot: "alpha" });

function setup() {
  const app = new FakeApp();
  let n = 0;
  const service = new BrowserService({ computer: "Studio", app: () => app, newId: () => `tab_${++n}` });
  return { app, service, h: browserMethodHandlers({ service }) };
}

async function failure(p: Promise<unknown>): Promise<{ code: number; data?: unknown } | undefined> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return e as { code: number; data?: unknown };
  }
}

describe("the browser's methods, served", () => {
  test("every method the app, a layer or a peer may call has a handler", () => {
    const names = Object.keys(browserMethodHandlers({ service: new BrowserService({ computer: "Studio", app: () => undefined }) })).sort();
    expect(names).toEqual([M.browserTabs, M.browserOpen, M.browserClose, M.browserNavigate, M.browserShow, M.browserHide, M.browserHold, M.browserScreenshot, M.browserCdp, M.browserStream, M.browserReport, M.browserStreamData].map((m) => m.name).sort());
  });

  test("open, tabs, navigate, show, hide, close: the person's own calls", async () => {
    const { h } = setup();
    const { tab } = (await h["browser.open"]!({ owner: { kind: "bot", bot: "alpha" }, url: "https://example.com/" }, user)) as { tab: { id: string; place: string } };
    expect(tab).toMatchObject({ id: "tab_1", place: "headless" });
    expect(((await h["browser.tabs"]!({}, user)) as { tabs: unknown[] }).tabs).toHaveLength(1);
    await h["browser.navigate"]!({ id: tab.id, url: "https://example.org/" }, user);
    const shown = (await h["browser.show"]!({ id: tab.id, view: "browser", viewport: { width: 800, height: 600 } }, user)) as { tab: { place: string; view: string } };
    expect(shown.tab).toMatchObject({ place: "shown", view: "browser" });
    expect(((await h["browser.hide"]!({ id: tab.id }, user)) as { tab: { place: string } }).tab.place).toBe("headless");
    expect(await h["browser.close"]!({ id: tab.id }, user)).toEqual({ ok: true });
    expect(((await h["browser.tabs"]!({}, user)) as { tabs: unknown[] }).tabs).toEqual([]);
  });

  test("a session acts as its own: another bot's tab is not there for it (no hint it exists), with the browser's code and a JSON-RPC one", async () => {
    const { h } = setup();
    await h["browser.open"]!({ owner: { kind: "bot", bot: "alpha" } }, user);
    const e = await failure(h["browser.close"]!({ id: "tab_1" }, as({ kind: "session", sessionId: "sess_l", sessionKind: "bot", bot: "luna" })));
    expect(e).toMatchObject({ code: ERR.NOT_FOUND, data: { code: "no_tab" } });
    expect(await failure(h["browser.close"]!({ id: "tab_1" }, session))).toBeUndefined();
  });

  test("a tab that isn't there is not found; bad params are invalid params", async () => {
    const { h } = setup();
    expect(await failure(h["browser.close"]!({ id: "tab_9" }, user))).toMatchObject({ code: ERR.NOT_FOUND, data: { code: "no_tab" } });
    expect(await failure(h["browser.open"]!({ owner: { kind: "nobody" } }, user))).toMatchObject({ code: ERR.INVALID_PARAMS });
  });

  test("a denied DevTools domain is refused; an allowed call's answer comes back as `result`", async () => {
    const { h, app } = setup();
    await h["browser.open"]!({ owner: { kind: "bot", bot: "alpha" } }, user);
    app.answers.cdp = { two: 2 };
    expect(await h["browser.cdp"]!({ id: "tab_1", method: "Runtime.evaluate", params: { expression: "1+1" } }, user)).toEqual({ result: { two: 2 } });
    expect(await failure(h["browser.cdp"]!({ id: "tab_1", method: "Target.getTargets" }, user))).toMatchObject({ data: { code: "method_refused" } });
  });

  test("hold is the person's alone; report takes the app's events", async () => {
    const { h, service } = setup();
    await h["browser.open"]!({ owner: { kind: "bot", bot: "alpha" } }, user);
    expect(await failure(h["browser.hold"]!({ id: "tab_1", held: true }, session))).toMatchObject({ code: CLOVER_ERR.NOT_THE_USER });
    expect(await h["browser.hold"]!({ id: "tab_1", held: true }, user)).toEqual({ ok: true });
    expect(service.tabs({ kind: "user" })[0]!.heldByUser).toBe(true);
    const events = { events: [{ kind: "closed", id: "tab_1", by: "user" }] };
    expect(await failure(h["browser.report"]!(events, session))).toMatchObject({ code: CLOVER_ERR.ROLE_REFUSED });
    expect(await failure(h["browser.report"]!(events, as({ kind: "user", client: "web" })))).toMatchObject({ code: CLOVER_ERR.ROLE_REFUSED });
    expect(service.tabs({ kind: "user" })).toHaveLength(1);
    expect(await h["browser.report"]!(events, user)).toEqual({ ok: true });
    expect(service.tabs({ kind: "user" })).toEqual([]);
  });

  test("streamData takes the app's chunks; anyone else is refused, and over-cap or bad base64 is invalid", async () => {
    const { h } = setup();
    const config = { stream: "st_1", chunk: { kind: "config", codec: "h264", width: 1280, height: 800, codecString: "avc1.42E01F" } };
    expect(await h["browser.streamData"]!(config, user)).toEqual({ ok: true });
    expect(await failure(h["browser.streamData"]!(config, session))).toMatchObject({ code: CLOVER_ERR.NOT_THE_USER });
    const frame = (data: string) => ({ stream: "st_1", chunk: { kind: "frame", key: true, timestamp: 1_000, data } });
    expect(await h["browser.streamData"]!(frame(Buffer.from([0, 1]).toString("base64")), user)).toEqual({ ok: true });
    expect(await failure(h["browser.streamData"]!(frame("!!!not-base64!!!"), user))).toMatchObject({ code: ERR.INVALID_PARAMS });
    expect(await failure(h["browser.streamData"]!(frame("A".repeat(8 * 1024 * 1024)), user))).toMatchObject({ code: ERR.INVALID_PARAMS });
  });

  test("report and streamData from a replaced app connection are ignored, never adopted", async () => {
    const { service } = setup();
    let current: number | undefined = 7;
    const h = browserMethodHandlers({ service, appConnId: () => current });
    await h["browser.open"]!({ owner: { kind: "bot", bot: "alpha" } }, { caller: user.caller, connId: 7 });
    expect(service.tabs({ kind: "user" })).toHaveLength(1);
    // The app reconnected on 8: 7's late close changes nothing, and its chunks land nowhere.
    current = 8;
    const stale = { caller: user.caller, connId: 7 };
    expect(await h["browser.report"]!({ events: [{ kind: "closed", id: "tab_1", by: "user" }] }, stale)).toEqual({ ok: true });
    expect(service.tabs({ kind: "user" })).toHaveLength(1);
    expect(await h["browser.streamData"]!({ stream: "st_1", chunk: { kind: "ended", reason: "failed" } }, stale)).toEqual({ ok: true });
    // The current connection still acts.
    expect(await h["browser.report"]!({ events: [{ kind: "closed", id: "tab_1", by: "user" }] }, { caller: user.caller, connId: 8 })).toEqual({ ok: true });
    expect(service.tabs({ kind: "user" })).toEqual([]);
  });

  test("a stream goes to the device its call came on: none, no stream", async () => {
    const { h } = setup();
    await h["browser.open"]!({ owner: { kind: "bot", bot: "alpha" } }, user);
    expect(await failure(h["browser.stream"]!({ id: "tab_1", on: true }, user))).toMatchObject({ code: CLOVER_ERR.ROLE_REFUSED });
  });
});
