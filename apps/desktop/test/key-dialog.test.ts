// The app's own key dialog in the root (pages.ts showKey): its acting buttons take only a real press, a beat after it
// is drawn, re-drawn or back in view; Remove is two steps, its confirming button elsewhere; focus is on the field.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, describe, expect, test } from "bun:test";

GlobalRegistrator.register();
const { KEY_ARM_MS, PressGuard, showKey } = await import("../src/core/pages");
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

describe("the key dialog's press guard", () => {
  test("a real press only, KEY_ARM_MS after a draw, a re-draw and coming back into view", () => {
    let now = 1_000;
    const g = new PressGuard(() => now);
    expect(g.takes({ isTrusted: true })).toBe(false);
    now += KEY_ARM_MS;
    expect(g.takes({ isTrusted: true })).toBe(true);
    expect(g.takes({ isTrusted: false })).toBe(false);
    g.rearm();
    expect(g.takes({ isTrusted: true })).toBe(false);
    now += KEY_ARM_MS;
    g.seen(false);
    expect(g.takes({ isTrusted: true })).toBe(false);
    g.seen(true);
    now += KEY_ARM_MS - 1;
    expect(g.takes({ isTrusted: true })).toBe(false);
    now += 1;
    expect(g.takes({ isTrusted: true })).toBe(true);
  });
});

describe("the dialog", () => {
  test("focus starts in the field; a page-made click acts on nothing; Remove's confirming button is in another place", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const calls: string[] = [];
    const call = async (name: string) => {
      calls.push(name);
      return { session: "s1", plugin: "Tarot", label: "Deck key", set: true };
    };
    await showKey(host, (k) => k, call as never, () => undefined, () => 0);
    const field = host.querySelector("[data-clover-key-field]");
    expect(document.activeElement).toBe(field);
    const remove = host.querySelector<HTMLButtonElement>("[data-clover-key-remove]")!;
    const save = host.querySelector<HTMLButtonElement>("[data-clover-key-save]")!;
    remove.click();
    save.click();
    await Promise.resolve();
    expect(calls).toEqual(["key.view"]);
    expect(host.querySelector<HTMLElement>("[data-clover-key-confirm]")!.hidden).toBe(true);
    // The confirming button lives in the body, above the field, never in the actions row where Remove is.
    const confirm = host.querySelector("[data-clover-key-remove-confirm]")!;
    expect(confirm.closest(".clover-page__actions")).toBeNull();
    expect(remove.closest(".clover-page__actions")).not.toBeNull();
  });
});
