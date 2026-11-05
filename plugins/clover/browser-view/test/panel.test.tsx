import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { BrowserPanel } from "../client/BrowserPanel";
import { PluginApiProvider } from "../client/sdk";
import type { BrowserSpotProps } from "../client/types";
import { fakeBrowser, type FakeBrowser } from "../gallery/fake-api";
import { tabView } from "../gallery/fixtures";
import { installResizeObserver, observing, resize } from "./resize";

beforeEach(installResizeObserver);
afterEach(cleanup);

const sleep = (ms: number) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
/** Lets the promises the panel is waiting on settle. */
const flush = () => sleep(0);
/** Longer than the panel's resize debounce (100 ms). */
const settle = () => sleep(150);

const A = tabView("a", { title: "Docs preview", url: "http://localhost:4321/docs/" });
const B = tabView("b", { title: "Plugin index", url: "https://plugins.clover.dev/" });

function tree(api: FakeBrowser | undefined, props: BrowserSpotProps) {
  return (
    <PluginApiProvider api={api ? { browser: api } : {}}>
      <BrowserPanel props={props} />
    </PluginApiProvider>
  );
}

async function mount(api: FakeBrowser | undefined, props: BrowserSpotProps = { app: "browser", bot: "alpha" }) {
  const view = render(tree(api, props));
  await flush();
  return view;
}

const frame = () => document.querySelector(".cl-browser__frame") as HTMLElement;
const address = () => screen.getByRole("textbox", { name: "Address" }) as HTMLInputElement;
const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;
const tab = (name: string) => screen.getByRole("tab", { name });

async function type(text: string) {
  await act(async () => {
    fireEvent.change(address(), { target: { value: text } });
  });
  await act(async () => {
    fireEvent.keyDown(address(), { key: "Enter" });
  });
}

describe("whose tabs", () => {
  test("a bot's tab lists that bot's tabs and no one else's", async () => {
    const api = fakeBrowser([A, B, tabView("u", { title: "My page", owner: { kind: "user" } }), tabView("o", { title: "Other bot", owner: { kind: "bot", bot: "beta" } })]);
    await mount(api, { bot: "alpha" });
    expect(api.of("tabs")).toEqual([[{ owner: { kind: "bot", bot: "alpha" } }]]);
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Docs preview", "Plugin index"]);
  });

  test("a code session, which names no bot, lists the user's tabs", async () => {
    const api = fakeBrowser([A, tabView("u", { title: "My page", owner: { kind: "user" } })]);
    await mount(api, { app: "browser", session: "s1" });
    expect(api.of("tabs")).toEqual([[{ owner: { kind: "user" } }]]);
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["My page"]);
  });

  test("in React's strict mode, which runs every effect twice, one watch stays and one show goes out", async () => {
    const api = fakeBrowser([A]);
    render(<StrictMode>{tree(api, { bot: "alpha" })}</StrictMode>);
    await flush();
    await resize(400, 300);
    await flush();
    expect(api.watchers).toBe(1);
    expect(screen.getAllByRole("tab")).toHaveLength(1);
    expect(api.of("show")).toEqual([["a", "browser", { width: 400, height: 300 }]]);
  });

  test("a tab with no title is named by its host, and a blank one is a new tab", async () => {
    const api = fakeBrowser([tabView("a", { url: "https://www.example.com/x" }), tabView("b", { url: "about:blank" })]);
    await mount(api);
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["www.example.com", "New tab"]);
  });
});

describe("watching", () => {
  test("a change the browser reports re-draws the row, and a new tab joins it", async () => {
    const api = fakeBrowser([A]);
    await mount(api);
    expect(api.watchers).toBe(1);
    await act(async () => api.emit({ ...A, title: "Docs, renamed", loading: true }));
    expect(tab("Docs, renamed").getAttribute("aria-busy")).toBe("true");
    await act(async () => api.emit(B));
    expect(screen.getAllByRole("tab")).toHaveLength(2);
  });

  test("another owner's tab never joins the row, and unmounting stops watching", async () => {
    const api = fakeBrowser([A]);
    const view = await mount(api);
    await act(async () => api.emit(tabView("o", { title: "Other bot", owner: { kind: "bot", bot: "beta" } })));
    await act(async () => api.emit(tabView("u", { title: "Mine", owner: { kind: "user" } })));
    expect(screen.getAllByRole("tab")).toHaveLength(1);
    view.unmount();
    expect(api.watchers).toBe(0);
  });

  test("a tab the user holds and a page that is loading say so", async () => {
    const api = fakeBrowser([{ ...A, loading: true }, { ...B, heldByUser: true }]);
    await mount(api);
    expect(tab("Docs preview").getAttribute("aria-busy")).toBe("true");
    expect(frame().getAttribute("aria-busy")).toBe("true");
    expect(tab("Plugin index").getAttribute("title")).toContain("You are using this tab. The bot waits until you let go.");
    expect(tab("Plugin index").parentElement?.hasAttribute("data-held")).toBe(true);
    expect(tab("Docs preview").parentElement?.hasAttribute("data-held")).toBe(false);
  });

  test("a different bot's tab reloads the list and puts the old tab back", async () => {
    const api = fakeBrowser([A, tabView("o", { title: "Other bot", owner: { kind: "bot", bot: "beta" } })]);
    const view = await mount(api, { bot: "alpha" });
    await resize(400, 300);
    await flush();
    view.rerender(tree(api, { bot: "beta" }));
    await flush();
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Other bot"]);
    expect(api.of("hide")).toEqual([["a"]]);
    expect(api.of("show").at(-1)).toEqual(["o", "browser", { width: 400, height: 300 }]);
  });
});

describe("the live view", () => {
  test("nothing is shown until the frame has a size; then the active tab is shown at it, in whole pixels", async () => {
    const api = fakeBrowser([A, B]);
    await mount(api);
    expect(api.of("show")).toEqual([]);
    await resize(400.6, 300.2);
    await flush();
    expect(api.of("show")).toEqual([["a", "browser", { width: 400, height: 300 }]]);
    expect(frame().children).toHaveLength(0);
  });

  test("resizes wait for the frame to settle, and then move the tab once, at the last size", async () => {
    const api = fakeBrowser([A]);
    await mount(api);
    await resize(400, 300);
    await flush();
    await resize(410, 300);
    await resize(420, 310);
    await resize(430, 320);
    await flush();
    expect(api.of("show")).toHaveLength(1);
    await settle();
    expect(api.of("show")).toEqual([
      ["a", "browser", { width: 400, height: 300 }],
      ["a", "browser", { width: 430, height: 320 }],
    ]);
  });

  test("a resize that ends where it began moves nothing", async () => {
    const api = fakeBrowser([A]);
    await mount(api);
    await resize(400, 300);
    await flush();
    await resize(500, 300);
    await resize(400, 300);
    await settle();
    expect(api.of("show")).toHaveLength(1);
  });

  test("choosing another tab puts the old one back and shows the new one, without waiting", async () => {
    const api = fakeBrowser([A, B]);
    await mount(api);
    await resize(400, 300);
    await flush();
    api.calls.length = 0;
    await act(async () => fireEvent.click(tab("Plugin index")));
    await flush();
    expect(api.calls.filter((c) => c.method === "hide" || c.method === "show").map((c) => [c.method, ...c.args])).toEqual([
      ["hide", "a"],
      ["show", "b", "browser", { width: 400, height: 300 }],
    ]);
    expect(tab("Plugin index").getAttribute("aria-selected")).toBe("true");
  });

  test("closing the panel puts the shown tab back", async () => {
    const api = fakeBrowser([A]);
    const view = await mount(api);
    await resize(400, 300);
    await flush();
    view.unmount();
    await flush();
    expect(api.of("hide")).toEqual([["a"]]);
    expect(observing()).toBe(0);
  });

  test("a frame with no area (a hidden panel) puts the tab back, and showing it again shows the tab again", async () => {
    const api = fakeBrowser([A]);
    await mount(api);
    await resize(400, 300);
    await flush();
    await resize(0, 0);
    await flush();
    expect(api.of("hide")).toEqual([["a"]]);
    await resize(400, 300);
    await flush();
    expect(api.of("show")).toHaveLength(2);
  });

  test("where the browser has the tab in the view, the frame is empty; before that it says what goes there", async () => {
    const api = fakeBrowser([A]);
    await mount(api);
    expect(frame().textContent).toContain("The live page shows here");
    await resize(400, 300);
    await flush();
    expect(frame().textContent).toBe("");
  });

  test("with no tab the frame says so, and nothing is shown", async () => {
    const api = fakeBrowser([]);
    await mount(api);
    await resize(400, 300);
    await flush();
    expect(frame().textContent).toContain("No tab open");
    expect(api.of("show")).toEqual([]);
  });

  test("nothing in the panel sits over the frame", async () => {
    const api = fakeBrowser([A]);
    await mount(api);
    await resize(400, 300);
    await flush();
    api.failNext("navigate", "Pages from files aren't allowed.");
    await type("file:///etc/hosts");
    const f = frame();
    // The frame is the last thing in the panel's flow (the annotate strip is not mounted), the failure notice is
    // above it, and nothing has an inline position or sits inside the frame.
    expect(f.nextElementSibling).toBeNull();
    expect(screen.getByRole("alert").compareDocumentPosition(f) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(f.children).toHaveLength(0);
    expect(document.querySelectorAll("[style]")).toHaveLength(0);
    expect(screen.queryByRole("toolbar")).toBeNull();
  });
});

describe("tabs", () => {
  test("a new tab opens for the owner, in the view, and takes over", async () => {
    const api = fakeBrowser([A]);
    await mount(api);
    await resize(400, 300);
    await flush();
    await act(async () => fireEvent.click(button("New tab")));
    await flush();
    expect(api.of("open")).toEqual([[{ owner: { kind: "bot", bot: "alpha" }, show: true }]]);
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    expect(tab("New tab").getAttribute("aria-selected")).toBe("true");
    expect(api.of("hide")).toEqual([["a"]]);
    expect(api.of("show").at(-1)).toEqual(["t1", "browser", { width: 400, height: 300 }]);
  });

  test("a code session's new tab is the user's", async () => {
    const api = fakeBrowser([]);
    await mount(api, { app: "browser", session: "s1" });
    await act(async () => fireEvent.click(button("New tab")));
    await flush();
    expect(api.of("open")).toEqual([[{ owner: { kind: "user" }, show: true }]]);
  });

  test("closing the tab shown hands the view to its neighbour; closing the last says there is none", async () => {
    const api = fakeBrowser([A, B]);
    await mount(api);
    await resize(400, 300);
    await flush();
    await act(async () => fireEvent.click(button("Close Docs preview")));
    await flush();
    expect(api.of("close")).toEqual([["a"]]);
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Plugin index"]);
    expect(api.of("show").at(-1)).toEqual(["b", "browser", { width: 400, height: 300 }]);
    await act(async () => fireEvent.click(button("Close Plugin index")));
    await flush();
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    expect(frame().textContent).toContain("No tab open");
    // A tab that is already closed is not asked to hide with an error on screen.
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("a close the browser refuses puts the tab back and says why", async () => {
    const api = fakeBrowser([A]);
    await mount(api);
    api.failNext("close", "The tab is busy.");
    await act(async () => fireEvent.click(button("Close Docs preview")));
    await flush();
    expect(screen.getByRole("alert").textContent).toBe("Couldn't close that tab. The tab is busy.");
    expect(screen.getAllByRole("tab")).toHaveLength(1);
  });

  test("a new tab the browser cannot open says so", async () => {
    const api = fakeBrowser([]);
    await mount(api);
    api.failNext("open", "No browser is running.");
    await act(async () => fireEvent.click(button("New tab")));
    await flush();
    expect(screen.getByRole("alert").textContent).toBe("Couldn't open a new tab. No browser is running.");
  });
});

describe("the address bar", () => {
  test("shows the page's address, and what is typed goes to the browser, with https:// added to a host", async () => {
    const api = fakeBrowser([A]);
    await mount(api);
    expect(address().value).toBe("http://localhost:4321/docs/");
    await type("  clover.dev/docs ");
    expect(api.of("navigate")).toEqual([["a", "https://clover.dev/docs"]]);
    // The browser's answer is the new address.
    expect(address().value).toBe("https://clover.dev/docs");
  });

  test("an address with a scheme, or that is no host, goes as typed", async () => {
    const api = fakeBrowser([A]);
    await mount(api);
    await type("http://example.org/x");
    await type("two words");
    expect(api.of("navigate")).toEqual([
      ["a", "http://example.org/x"],
      ["a", "two words"],
    ]);
  });

  test("what the browser refuses shows in plain words by the bar, and the typed address stays to be fixed", async () => {
    const api = fakeBrowser([A]);
    await mount(api);
    api.failNext("navigate", "Pages from files on this computer aren't allowed.");
    await type("file:///etc/hosts");
    expect(screen.getByRole("alert").textContent).toBe("Couldn't open that address. Pages from files on this computer aren't allowed.");
    expect(address().value).toBe("file:///etc/hosts");
    expect(address().getAttribute("aria-invalid")).toBe("true");
    // The next try clears it.
    await type("example.com");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(address().value).toBe("https://example.com");
  });

  test("with no tab there is nothing to type into", async () => {
    await mount(fakeBrowser([]));
    expect(address().disabled).toBe(true);
  });
});

describe("back, forward and reload", () => {
  test("follow the page's own history: off where there is nowhere to go", async () => {
    const api = fakeBrowser([A]);
    await mount(api);
    expect(button("Back").disabled).toBe(true);
    expect(button("Forward").disabled).toBe(true);
    expect(api.of("cdp")[0]).toEqual(["a", "Page.getNavigationHistory", undefined]);
  });

  test("back and forward go to the entry before and after the current one", async () => {
    const api = fakeBrowser([A]);
    api.history.a = {
      currentIndex: 1,
      entries: [
        { id: 11, url: "https://one.test/" },
        { id: 12, url: "https://two.test/" },
        { id: 13, url: "https://three.test/" },
      ],
    };
    await mount(api);
    expect(button("Back").disabled).toBe(false);
    expect(button("Forward").disabled).toBe(false);
    await act(async () => fireEvent.click(button("Back")));
    await act(async () => fireEvent.click(button("Forward")));
    expect(api.of("cdp").filter((c) => c[1] === "Page.navigateToHistoryEntry")).toEqual([
      ["a", "Page.navigateToHistoryEntry", { entryId: 11 }],
      ["a", "Page.navigateToHistoryEntry", { entryId: 13 }],
    ]);
  });

  test("the buttons follow the page as it moves", async () => {
    const api = fakeBrowser([A]);
    await mount(api);
    expect(button("Back").disabled).toBe(true);
    api.history.a = {
      currentIndex: 1,
      entries: [
        { id: 1, url: "http://localhost:4321/docs/" },
        { id: 2, url: "https://example.org/" },
      ],
    };
    await act(async () => api.emit({ ...A, url: "https://example.org/" }));
    await flush();
    expect(button("Back").disabled).toBe(false);
    expect(button("Forward").disabled).toBe(true);
  });

  test("reload reloads the page, and a failure is said", async () => {
    const api = fakeBrowser([A]);
    await mount(api);
    await act(async () => fireEvent.click(button("Reload")));
    expect(api.of("cdp").at(-1)).toEqual(["a", "Page.reload", undefined]);
    api.failNext("cdp:Page.reload", "The page is gone.");
    await act(async () => fireEvent.click(button("Reload")));
    await flush();
    expect(screen.getByRole("alert").textContent).toBe("Couldn't reload the page. The page is gone.");
  });

  test("with no tab, none of the three works", async () => {
    await mount(fakeBrowser([]));
    expect(button("Back").disabled).toBe(true);
    expect(button("Forward").disabled).toBe(true);
    expect(button("Reload").disabled).toBe(true);
  });
});

describe("failures", () => {
  test("a tab that cannot be shown says so, and the list is read again", async () => {
    const api = fakeBrowser([A]);
    await mount(api);
    api.failNext("show", "The tab has gone.");
    const before = api.of("tabs").length;
    await resize(400, 300);
    await flush();
    expect(screen.getByRole("alert").textContent).toBe("Couldn't show the page here. The tab has gone.");
    expect(api.of("tabs").length).toBe(before + 1);
  });

  test("a list that cannot be read says so", async () => {
    const api = fakeBrowser([A]);
    api.failNext("tabs", "The browser isn't running.");
    await mount(api);
    expect(screen.getByRole("alert").textContent).toBe("Couldn't load the tabs. The browser isn't running.");
  });

  test("without a browser in the plugin API, the panel says it isn't available and does nothing", async () => {
    await mount(undefined);
    expect(screen.getByRole("alert").textContent).toBe("The browser isn't available here.");
    expect(screen.queryByRole("button", { name: "New tab" })).toBeNull();
  });
});
