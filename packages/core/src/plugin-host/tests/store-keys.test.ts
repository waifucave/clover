// A plugin's synced store: one file per plugin (named from the id the host stamped, never from a key), and keys that
// are plain names. A key with `/`, `..`, a NUL, a leading dot, Clover's reserved `clover.` or an object's own name is
// refused at set, get and delete alike, so no key reaches another plugin's store or Clover's own keys.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileSyncedStores, STORE_KEY_RE, SyncedStores } from "../api/storage";

const temps: string[] = [];
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

test("one file per plugin; keys are plain names, refused otherwise at set, get and delete", () => {
  const home = mkdtempSync(join(tmpdir(), "clover-keys-"));
  temps.push(home);
  const stores = new SyncedStores(fileSyncedStores(home));
  stores.set("luna", "stage", { v: 1 });
  stores.set("luna", "stage.catalog", { v: 1 });
  stores.set("sol", "stage", { v: 2 });
  expect(readdirSync(join(home, "settings", "plugin-stores")).sort()).toEqual(["luna.json", "sol.json"]);
  expect(stores.get("luna", "stage")).toEqual({ v: 1 });
  expect(stores.get("sol", "stage")).toEqual({ v: 2 });
  const bad = ["../sol", "a/b", "a\\b", "x\u0000y", ".hidden", "a..b", "clover.addons", "__proto__", "constructor", "prototype", "", "k".repeat(129), "sp ace", "é"];
  for (const k of bad) {
    expect([k, STORE_KEY_RE.test(k) && !["__proto__", "constructor", "prototype"].includes(k)]).toEqual([k, false]);
    expect(() => stores.set("luna", k, 1)).toThrow("isn't a store key");
    expect(() => stores.get("luna", k)).toThrow("isn't a store key");
    expect(() => stores.delete("luna", k)).toThrow("isn't a store key");
  }
  expect(stores.keys("luna")).toEqual(["stage", "stage.catalog"]);
  expect(stores.get("sol", "stage")).toEqual({ v: 2 });
  expect(existsSync(join(home, "settings", "sol"))).toBe(false);
});
