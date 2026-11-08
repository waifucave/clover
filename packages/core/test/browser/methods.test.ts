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
    expect(names).toEqual([M.browserTabs, M.browserOpen, M.browserClose, M.browserNavigate, M.browserShow, M.browserHide, M.browserHold, M.browserScreenshot, M.browserCdp, M.browserStream, M.browserReport].map((m) => m.name).sort());
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
    expect(await h["browser.report"]!({ events: [{ kind: "closed", id: "tab_1", by: "user" }] }, user)).toEqual({ ok: true });
    expect(service.tabs({ kind: "user" })).toEqual([]);
  });

  test("a stream goes to the device its call came on: none, no stream", async () => {
    const { h } = setup();
    await h["browser.open"]!({ owner: { kind: "bot", bot: "alpha" } }, user);
    expect(await failure(h["browser.stream"]!({ id: "tab_1", on: true }, user))).toMatchObject({ code: CLOVER_ERR.ROLE_REFUSED });
  });
});
