// The drop (the owner's ask on try 14c: "the bot can also just move them to the plugins location and clover would index
// it automatically and ask the ok"). A folder that appears in the plugins folder while Clover runs is read once its tree
// has settled and asked about at once with the sealed OK card; a bot's session that made it is named as its builder (the
// same "Built by" card as `PluginInstall`, and the workshop's edit rights after the OK); one nobody claimed is an ordinary
// found plugin. A folder already there at start keeps its card on the user's switch. A card always shows the tree as last
// read: a folder that changes while its card waits gets a new card, so no OK covers a tree the user didn't see.
import { afterAll, afterEach, expect, setDefaultTimeout, test } from "bun:test";
setDefaultTimeout(20_000);
import { cpSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PLUGIN_API_VERSION, catalogPointDecl } from "@waifucave/clover-plugin-sdk";
import { RegistryCore, type OkCardRaiser } from "../core";
import { PluginFolders, builtByText } from "../folders";
import { fileRegistryStore } from "../state";

const temps: string[] = [];
const stops: (() => void)[] = [];
afterEach(() => { for (const s of stops.splice(0)) s(); });
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

const SETTLE = 200;
const manifest = (id: string) => JSON.stringify({ manifest: 1, id, name: id, version: "1.0.0", engines: { clover: `^${PLUGIN_API_VERSION}` } });
function write(dir: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}

interface Raised { id: string; treeHash: string; card: string; answered: (a: { approved: boolean }) => void; signal?: AbortSignal }

/** A Clover home whose registry runs and watches its plugins folder, with the cards it raises. */
function world(before: Record<string, Record<string, string>> = {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "clover-a-drop-")));
  temps.push(home);
  const pluginsDir = join(home, "plugins");
  mkdirSync(pluginsDir, { recursive: true });
  for (const [name, files] of Object.entries(before)) write(join(pluginsDir, name), files);
  const store = fileRegistryStore(join(home, "plugins-state"));
  const raised: Raised[] = [];
  const cards: OkCardRaiser = {
    raise: (req, answered, opts) => {
      const card = `card_${raised.length + 1}`;
      raised.push({ id: req.id, treeHash: req.treeHash, card, answered, ...(opts?.signal ? { signal: opts.signal } : {}) });
      return card;
    },
  };
  let folders: PluginFolders;
  const core = new RegistryCore({ catalog: catalogPointDecl, store, cards, onOk: (id, hash) => folders.okGiven(id, hash) });
  folders = new PluginFolders({ core, store, pluginsDir, settleMs: SETTLE });
  folders.setBotNames((id) => (id === "alpha" ? "Alpha" : undefined));
  return {
    home, pluginsDir, core, folders, raised,
    // The watch's own start takes a moment on macOS (FSEvents): a change right after it may be missed.
    async start() { await folders.scan(); folders.start(); stops.push(() => folders.stop()); await Bun.sleep(300); },
    /** The cards still waiting for the user. */
    live: () => raised.filter((r) => r.signal?.aborted !== true && core.okCards().some((c) => c.card === r.card)),
  };
}

/** Until `cond` holds, or fails after a few seconds. */
async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) { if (cond()) return; await Bun.sleep(20); }
  throw new Error(`never: ${what}`);
}

test("a bot's folder moved into the plugins folder: found, its OK card raised at once naming the bot, nothing runs; after the OK it runs as the bot's", async () => {
  const w = world();
  await w.start();
  const scratch = join(w.home, "scratch", "alpha", "xtool");
  write(scratch, { "clover.json": manifest("xtool"), "README.md": "xtool" });
  // The bot's session made it (the driver's before/after look at its shell call claims the name).
  renameSync(scratch, join(w.pluginsDir, "xtool"));
  expect(w.folders.dropped("xtool", "alpha")).toBe(true);
  expect(w.folders.pendingDrops("alpha")).toEqual(["xtool"]);
  await until(() => w.live().some((r) => r.id === "xtool"), "xtool's card");
  expect(w.core.get("xtool")).toMatchObject({ state: "found", provenance: { by: "bot", bot: "alpha" } });
  expect(w.folders.okText("xtool", "macos").source).toBe(builtByText("Alpha"));
  // Recorded: the claim is spent, and the store keeps who built it.
  expect(w.folders.pendingDrops()).toEqual([]);
  expect(w.folders.provenanceOf("xtool")).toMatchObject({ by: "bot", bot: "alpha" });
  w.live().find((r) => r.id === "xtool")!.answered({ approved: true });
  await until(() => w.core.get("xtool")?.state !== "found", "xtool approved");
  expect(w.core.get("xtool")!.state).not.toBe("found");
  expect(w.core.get("xtool")!.okHash).toBe(w.core.get("xtool")!.treeHash);
});

test("a folder the user drops while Clover runs: an ordinary found plugin with its card at once; one there at start waits for the switch", async () => {
  const w = world({ old: { "clover.json": manifest("old") } });
  await w.start();
  expect(w.core.get("old")).toMatchObject({ state: "found" });
  write(join(w.pluginsDir, "mine"), { "clover.json": manifest("mine") });
  await until(() => w.live().some((r) => r.id === "mine"), "mine's card");
  expect(w.core.get("mine")).toMatchObject({ state: "found", provenance: { by: "found" } });
  expect(w.folders.okText("mine", "macos").source).not.toBe(builtByText("Alpha"));
  await Bun.sleep(SETTLE * 3);
  expect(w.live().some((r) => r.id === "old")).toBe(false);
  // Loose files at the top are ignored.
  writeFileSync(join(w.pluginsDir, "notes.txt"), "hi");
  await Bun.sleep(SETTLE * 3);
  expect(w.core.list().map((p) => p.id).sort()).toEqual(["mine", "old"]);
});

test("a copy that takes longer than the settle time: no card before its manifest is there, and the card left waiting shows the whole tree", async () => {
  const w = world();
  await w.start();
  // Files first, the manifest last (a copy in progress): nothing is asked while it has none.
  const dest = join(w.pluginsDir, "slow");
  mkdirSync(dest, { recursive: true });
  w.folders.dropped("slow", "alpha");
  for (let i = 0; i < 4; i++) {
    write(dest, { [`part${i}.txt`]: "x".repeat(1000) });
    await Bun.sleep(SETTLE);
  }
  expect(w.raised.filter((r) => r.id === "slow")).toEqual([]);
  write(dest, { "clover.json": manifest("slow") });
  await until(() => w.live().some((r) => r.id === "slow"), "slow's card");
  expect(w.core.get("slow")!.provenance).toMatchObject({ by: "bot", bot: "alpha" });
  // The manifest first and the rest slowly: whatever was asked on the way, the one card left waiting is the whole tree.
  const later = join(w.pluginsDir, "later");
  mkdirSync(later, { recursive: true });
  write(later, { "clover.json": manifest("later") });
  for (let i = 0; i < 6; i++) {
    write(later, { [`part${i}.txt`]: "x".repeat(1000) });
    await Bun.sleep(SETTLE / 2);
  }
  await Bun.sleep(SETTLE * 3);
  const waiting = w.live().filter((r) => r.id === "later");
  expect(waiting).toHaveLength(1);
  expect(waiting[0]!.treeHash).toBe(w.core.get("later")!.treeHash!);
  for (const old of w.raised.filter((r) => r.id === "later" && r.card !== waiting[0]!.card)) expect(old.signal?.aborted).toBe(true);
});

test("a folder that changes while its card waits: the old card goes, a new one shows the new tree, and an OK of the old tree applies nothing", async () => {
  const w = world();
  await w.start();
  write(join(w.pluginsDir, "moving"), { "clover.json": manifest("moving"), "a.txt": "1" });
  await until(() => w.live().some((r) => r.id === "moving"), "the first card");
  const first = w.live().find((r) => r.id === "moving")!;
  write(join(w.pluginsDir, "moving"), { "a.txt": "2" });
  await until(() => w.live().some((r) => r.id === "moving" && r.card !== first.card), "the new card");
  const second = w.live().find((r) => r.id === "moving")!;
  expect(second.treeHash).not.toBe(first.treeHash);
  expect(second.treeHash).toBe(w.core.get("moving")!.treeHash!);
  expect(first.signal?.aborted).toBe(true);
  expect(await w.core.approve("moving", first.treeHash)).toBe("changed");
  expect(w.core.get("moving")!.state).toBe("found");
});

test("a name another bot claimed too is nobody's; a name the records hold already isn't a drop", async () => {
  const w = world({ old: { "clover.json": manifest("old") } });
  await w.start();
  expect(w.folders.dropped("old", "alpha")).toBe(false);
  expect(w.folders.dropped("both", "alpha")).toBe(true);
  expect(w.folders.dropped("both", "luna")).toBe(false);
  expect(w.folders.dropped("both", "alpha")).toBe(false);
  write(join(w.pluginsDir, "both"), { "clover.json": manifest("both") });
  await until(() => w.live().some((r) => r.id === "both"), "both's card");
  expect(w.core.get("both")!.provenance).toMatchObject({ by: "found" });
  // A copy of a folder, `cp -R`, the same as a move.
  const src = join(w.home, "scratch", "alpha", "copied");
  write(src, { "clover.json": manifest("copied") });
  cpSync(src, join(w.pluginsDir, "copied"), { recursive: true });
  w.folders.dropped("copied", "alpha");
  await until(() => w.live().some((r) => r.id === "copied"), "copied's card");
  expect(w.core.get("copied")!.provenance).toMatchObject({ by: "bot", bot: "alpha" });
});
