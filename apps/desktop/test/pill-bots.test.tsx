// The pill's bots: read once per API object and kept current from `bot_changed`. A key that changed on every
// render (a `list` bound afresh) re-ran the read after each update, which looped `bot.list` against the daemon.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, describe, expect, test } from "bun:test";

GlobalRegistrator.register();
const { act, cleanup, render } = await import("@testing-library/react");
const { createElement: h, useState } = await import("react");
const { usePillBots } = await import("../src/layer/clover/pill-bots");

afterAll(async () => {
  cleanup();
  await GlobalRegistrator.unregister();
});

const tick = () => act(async () => {
  await new Promise((r) => setTimeout(r, 10));
});

describe("the pill's bots", () => {
  test("one bot.list for the API object, however often the host renders; bot_changed updates the list", async () => {
    let lists = 0;
    let changed: ((b: unknown) => void) | undefined;
    const api = {
      bots: {
        list: async () => {
          lists++;
          return [{ id: "b_alpha", name: "Alpha" }];
        },
        watch: (listener: (b: unknown) => void) => {
          changed = listener;
          return () => { changed = undefined; };
        },
      },
    } as never;
    let rerender: (() => void) | undefined;
    let shown: readonly { id: string; name: string }[] = [];
    const Host = () => {
      const [, bump] = useState(0);
      rerender = () => bump((n) => n + 1);
      shown = usePillBots(api);
      return h("div", null, shown.map((b) => b.name).join(","));
    };
    render(h(Host));
    for (let i = 0; i < 5; i++) {
      await tick();
      await act(async () => rerender!());
    }
    expect(lists).toBe(1);
    expect(shown).toEqual([{ id: "b_alpha", name: "Alpha" }]);
    await act(async () => changed!({ id: "b_alpha", name: "Alpha 2" }));
    await act(async () => changed!({ id: "b_vega", name: "Vega" }));
    expect(shown).toEqual([{ id: "b_alpha", name: "Alpha 2" }, { id: "b_vega", name: "Vega" }]);
    expect(lists).toBe(1);
  });
});
