// A bot's tab layout is retired with the bot tab (G8): a new one is refused, clearing one still works, and one the person
// stored before stays in their user layer's file across an upgrade and another field's change (nothing of theirs is lost).
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseUserLayerPatch, UserLayerStore } from "../../src/bots/user-layer";

const temps: string[] = [];
afterAll(() => { for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true }); });

test("a new tab layout is refused; clearing it is taken", () => {
  expect(() => parseUserLayerPatch({ layout: JSON.stringify({ layout: 1, root: { spot: "conversation" } }) })).toThrow("retired with the bot tab");
  expect(parseUserLayerPatch({ layout: null })).toEqual({ layout: null });
  expect(parseUserLayerPatch({ name: "Luna" })).toEqual({ name: "Luna" });
});

test("a layout stored before stays in the file, unread, through another field's change", () => {
  const home = mkdtempSync(join(tmpdir(), "moss-ul-layout-"));
  temps.push(home);
  const stored = JSON.stringify({ layout: 1, extends: "default", changes: [] });
  mkdirSync(join(home, "user-layers"), { recursive: true });
  writeFileSync(join(home, "user-layers", "luna.json"), JSON.stringify({ userLayer: 1, fields: { name: "Luna", layout: stored } }));
  const store = new UserLayerStore(home);
  expect(store.get("luna").layout).toBe(stored);
  store.set("luna", { name: "Moon" });
  const file = JSON.parse(readFileSync(join(home, "user-layers", "luna.json"), "utf8")) as { fields: Record<string, unknown> };
  expect(file.fields).toMatchObject({ name: "Moon", layout: stored });
});
