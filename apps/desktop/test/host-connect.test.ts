// The host's own connect path (lane HS; lane M's fix): the background host connects through the same pair client as MOSS
// Code's window (main's one `onConnected`), so it subscribes to the cards' events BEFORE it lists the cards waiting
// (`subscribeThenListCards`): listed first, a card raised in between was told to no connection. Main is not loadable in a
// unit test (Electron), so this reads its source: one connect path, no program's branch before the subscription, and no
// other card listing anywhere in main.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { APP_EVENT_AREAS, subscribeThenListCards } from "../src/main/card-place";

const main = readFileSync(join(import.meta.dir, "..", "src", "main", "index.ts"), "utf8");

test("every program, the host included, subscribes before it lists the waiting cards on each connection", () => {
  expect(main.match(/onConnected: \(client, hello\) =>/g)?.length).toBe(1);
  const start = main.indexOf("onConnected: (client, hello) =>");
  const block = main.slice(start, main.indexOf("onState:", start));
  const at = block.indexOf("subscribeThenListCards(client, cardWaitingAtConnect)");
  expect(at).toBeGreaterThan(0);
  // Nothing before it in the connect path picks a program (the host would skip it).
  expect(/\bprogram\s*[!=]==/.test(block.slice(0, at))).toBe(false);
  // No other listing of the cards in main: the only `card.list` is subscribeThenListCards's own.
  expect(main.includes('"card.list"')).toBe(false);
});

test("subscribeThenListCards: events.subscribe with the approvals area goes out before card.list", async () => {
  const sent: { method: string; params?: unknown }[] = [];
  const seen: unknown[] = [];
  await subscribeThenListCards({ request: async <T,>(method: string, params?: unknown) => { sent.push({ method, params }); return (method === "card.list" ? { cards: [{ id: "card_1" }] } : { ok: true }) as T; } }, (c) => seen.push(c));
  expect(sent.map((s) => s.method)).toEqual(["events.subscribe", "card.list"]);
  expect((sent[0]!.params as { areas: string[] }).areas).toEqual([...APP_EVENT_AREAS]);
  expect(APP_EVENT_AREAS).toContain("approvals");
  expect(seen).toEqual([{ id: "card_1" }]);
});

test("subscribeThenListCards says which cards the engine holds (the caller drops the rest), and nothing when the list failed", async () => {
  const ok = await subscribeThenListCards({ request: async <T,>(method: string) => (method === "card.list" ? { cards: [{ id: "card_1" }, { id: "card_2" }] } : { ok: true }) as T }, () => {});
  expect(ok).toEqual(["card_1", "card_2"]);
  const failed = await subscribeThenListCards({ request: async <T,>(method: string): Promise<T> => { if (method === "card.list") throw new Error("gone"); return { ok: true } as T; } }, () => {});
  expect(failed).toBeUndefined();
});
