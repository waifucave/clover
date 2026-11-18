// MOSS's Settings: the Archived bots card is drawn only once the cards above it are in, and a read on its way is marked
// `data-loading` (lane BT, row 107's miss). The card's own read (`bot.archived`) answers in a moment, the settings read
// (a few hundred keys and sign-ins) later; drawn first, the card was pushed down under the person's pointer by the keys
// list arriving above it, and their Bring back landed on a key row instead.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, expect, test } from "bun:test";
import type { MossBridge, SettingsView } from "../src/shared/view";

GlobalRegistrator.register();
afterAll(async () => { await GlobalRegistrator.unregister(); });

const { act, render } = await import("@testing-library/react");
const { createElement: h } = await import("react");
const { SettingsPage } = await import("../src/window/settings/SettingsPage");

const settle = async (ms = 30): Promise<void> => { await act(async () => { await new Promise((r) => setTimeout(r, ms)); }); };

test("the Archived bots card waits for the settings read, so nothing above it arrives after it", async () => {
  let release: (v: SettingsView) => void = () => {};
  const settings = new Promise<SettingsView>((r) => { release = r; });
  const calls: string[] = [];
  const stub: Partial<MossBridge> = {
    settings: () => settings,
    archivedBots: async () => [{ id: "nova", name: "Nova Two" }],
    models: async () => ({ waiting: true }),
  };
  (window as unknown as { moss: unknown }).moss = new Proxy(stub, {
    get: (t, k: string) => {
      const f = (t as Record<string, unknown>)[k];
      return (...a: unknown[]) => { calls.push(k); return typeof f === "function" ? (f as (...x: unknown[]) => unknown)(...a) : Promise.resolve({ waiting: true }); };
    },
  });
  const r = render(h(SettingsPage, { bots: [] }));
  await settle();
  // The archive's own read has answered; the keys haven't: the card isn't drawn yet.
  expect(r.container.querySelector("[data-archived-bot=nova]")).toBeNull();
  // And the page says a read is on its way, so a press waits for its final shape.
  expect(r.container.querySelector("[data-loading]")).not.toBeNull();
  const rows = Array.from({ length: 300 }, (_, i) => ({ pluginId: `p${i}`, name: `Provider ${i}`, index: 0, method: "api-key" as const, state: "signed-out" }));
  await act(async () => { release({ account: { signedIn: false }, signIns: rows, computers: [], devices: [] }); });
  await settle();
  // Now it is, below the keys list.
  const item = r.container.querySelector("[data-archived-bot=nova]");
  expect(item).not.toBeNull();
  const keys = r.container.querySelector(".ma2-keys");
  expect(keys !== null && (keys.compareDocumentPosition(item!) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0).toBe(true);
  expect(r.container.querySelector("[data-loading]")).toBeNull();
  r.unmount();
});
