import { describe, expect, test } from "bun:test";
import { LiveView } from "../client/live-view";
import { tabView } from "../gallery/fixtures";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A browser whose `show` and `hide` take `delay` ms to answer, writing down when each call started and ended. */
function slowBrowser(delay = 0) {
  const log: string[] = [];
  const api = {
    async show(id: string, view: string, size: { width: number; height: number }) {
      log.push(`show ${id} ${view} ${size.width}x${size.height}`);
      await sleep(delay);
      log.push(`shown ${id}`);
      return tabView(id, { place: "shown" });
    },
    async hide(id: string) {
      log.push(`hide ${id}`);
      await sleep(delay);
      log.push(`hidden ${id}`);
      return tabView(id);
    },
  };
  return { api, log };
}

const make = (delay = 0, debounceMs = 20) => {
  const { api, log } = slowBrowser(delay);
  const errors: unknown[] = [];
  const tabs: string[] = [];
  const view = new LiveView(api, "browser", { onError: (e) => errors.push(e), onTab: (t) => tabs.push(`${t.id}:${t.place}`) }, debounceMs);
  return { view, log, errors, tabs };
};

describe("LiveView", () => {
  test("the first tab is shown at once, and the browser's answer is passed on", async () => {
    const { view, log, tabs } = make();
    view.set({ id: "a", size: { width: 400, height: 300 } });
    await view.settled();
    expect(log).toEqual(["show a browser 400x300", "shown a"]);
    expect(tabs).toEqual(["a:shown"]);
    expect(view.current).toBe("a");
  });

  test("another tab: the old one goes back before the new one goes in, even when the calls are slow", async () => {
    const { view, log } = make(10);
    view.set({ id: "a", size: { width: 400, height: 300 } });
    view.set({ id: "b", size: { width: 400, height: 300 } });
    await view.settled();
    expect(log).toEqual(["show a browser 400x300", "shown a", "hide a", "hidden a", "show b browser 400x300", "shown b"]);
  });

  test("the same tab at another size waits for the resize to settle, then shows once at the last size", async () => {
    const { view, log } = make(0, 30);
    view.set({ id: "a", size: { width: 400, height: 300 } });
    await view.settled();
    view.set({ id: "a", size: { width: 410, height: 300 } });
    view.set({ id: "a", size: { width: 420, height: 300 } });
    await sleep(10);
    view.set({ id: "a", size: { width: 430, height: 300 } });
    await sleep(15);
    expect(log).toEqual(["show a browser 400x300", "shown a"]);
    await sleep(60);
    await view.settled();
    expect(log.slice(2)).toEqual(["show a browser 430x300", "shown a"]);
  });

  test("a new tab while a resize waits drops the wait", async () => {
    const { view, log } = make(0, 30);
    view.set({ id: "a", size: { width: 400, height: 300 } });
    view.set({ id: "a", size: { width: 500, height: 300 } });
    view.set({ id: "b", size: { width: 500, height: 300 } });
    await sleep(60);
    await view.settled();
    expect(log.filter((l) => l.startsWith("show "))).toEqual(["show a browser 400x300", "show b browser 500x300"]);
  });

  test("nothing wanted puts the tab back; the same size twice sends nothing", async () => {
    const { view, log } = make();
    view.set({ id: "a", size: { width: 400, height: 300 } });
    view.set({ id: "a", size: { width: 400, height: 300 } });
    view.set(null);
    view.set(null);
    await view.settled();
    expect(log).toEqual(["show a browser 400x300", "shown a", "hide a", "hidden a"]);
    expect(view.current).toBeNull();
  });

  test("dispose puts the tab back, drops a waiting resize, and sends nothing after", async () => {
    const { view, log } = make(0, 20);
    view.set({ id: "a", size: { width: 400, height: 300 } });
    view.set({ id: "a", size: { width: 500, height: 300 } });
    view.dispose();
    view.set({ id: "b", size: { width: 500, height: 300 } });
    await sleep(50);
    await view.settled();
    expect(log).toEqual(["show a browser 400x300", "shown a", "hide a", "hidden a"]);
  });

  test("a show that fails is reported; a hide that fails is not", async () => {
    const errors: unknown[] = [];
    const view = new LiveView(
      {
        show: async () => {
          throw new Error("no such tab");
        },
        hide: async () => {
          throw new Error("no such tab");
        },
      },
      "browser",
      { onError: (e) => errors.push((e as Error).message), onTab: () => undefined },
      10,
    );
    view.set({ id: "a", size: { width: 400, height: 300 } });
    view.set(null);
    await view.settled();
    expect(errors).toEqual(["no such tab"]);
  });

  test("claim shows the wanted tab again at once, after another panel took the view (R8); with nothing wanted, nothing", async () => {
    const { view, log } = make();
    view.claim();
    await view.settled();
    expect(log).toEqual([]);
    view.set({ id: "a", size: { width: 400, height: 300 } });
    await view.settled();
    view.claim();
    await view.settled();
    expect(log).toEqual(["show a browser 400x300", "shown a", "show a browser 400x300", "shown a"]);
    view.dispose();
    view.claim();
    await view.settled();
    expect(log.filter((l) => l.startsWith("show ")).length).toBe(2);
  });
});
