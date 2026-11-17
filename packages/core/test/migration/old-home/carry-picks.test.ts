// A carried one-at-a-time pick (ruling 5, `carry.ts`) is the user's old choice and nothing more: one naming a plugin
// that waits for its OK again does nothing until the user approves that plugin on its normal card. Until then the
// point's default is the active one; the pick is kept, and it takes effect on the yes.
import { afterEach, expect, test } from "bun:test";
import { catalogPointDecl } from "@waifucave/moss-plugin-sdk";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Manifest } from "../../../src/contracts/sdk-types";
import { applyCarry, type RegistryCarry } from "../../../src/migration/old-home/carry";
import { oldHomePaths } from "../../../src/migration/old-home/paths";
import { activeOne, refOf } from "../../../src/registry/active-one";
import { RegistryCore, type RegistryInput } from "../../../src/registry/core";
import { memoryRegistryStore } from "../../../src/registry/state";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const m = (over: Partial<Manifest> = {}): Manifest => ({ manifest: 1, name: "A plugin", ...over });
const DECK: RegistryInput = {
  id: "deck", approved: true, source: "bundled", treeHash: "sha256:d",
  manifest: m({
    name: "Deck",
    host: { entry: "host/index.js", declares: { "deck.mode": { shape: "list", oneAtATime: true, title: "Deck mode", fields: { type: "object", properties: { id: { type: "string" }, name: { type: "string" } } } } } },
    contributes: { "deck.mode": [{ id: "own", name: "Its own" }] } as Manifest["contributes"],
  }),
};
const theirs = (approved?: boolean): RegistryInput => ({
  id: "theirs", treeHash: "sha256:t", ...(approved === undefined ? {} : { approved }),
  manifest: m({ name: "Theirs", contributes: { "deck.mode": [{ id: "theirs", name: "Theirs" }] } as Manifest["contributes"] }),
});

test("a carried pick naming a plugin that waits for its OK does nothing until that plugin is approved", async () => {
  const home = mkdtempSync(join(tmpdir(), "moss-carry-picks-"));
  dirs.push(home);
  const p = oldHomePaths(home);
  mkdirSync(p.dir, { recursive: true });
  const carry: RegistryCarry = { v: 1, order: ["deck", "theirs"], plugins: { theirs: { enabled: true } }, active: { "deck.mode": { pluginId: "theirs", entryId: "theirs" } } };
  writeFileSync(p.carry, JSON.stringify(carry));
  const store = memoryRegistryStore();
  expect(applyCarry(home, store)).toBe(true);

  const reg = new RegistryCore({ catalog: catalogPointDecl, store });
  // The copied third-party plugin, its tree changed by the copy: found, waiting for its OK.
  reg.putAll([DECK, theirs()]);
  expect(reg.get("theirs")?.state).toBe("found");
  const before = activeOne(reg, "deck.mode");
  expect(before?.fillers.map((f) => f.pluginId)).toEqual(["deck"]);
  expect(before?.active && `${refOf(before.active).pluginId}/${refOf(before.active).entryId}`).toBe("deck/own");
  // The pick is kept, not dropped, while it does nothing.
  expect(reg.chosen("deck.mode")).toEqual({ pluginId: "theirs", entryId: "theirs" });

  // The user's yes on its card: the pick takes effect.
  expect(await reg.approve("theirs", "sha256:t")).toBe("approved");
  expect(reg.get("theirs")?.state).toBe("running");
  const after = activeOne(reg, "deck.mode");
  expect(after?.active && `${refOf(after.active).pluginId}/${refOf(after.active).entryId}`).toBe("theirs/theirs");
});
