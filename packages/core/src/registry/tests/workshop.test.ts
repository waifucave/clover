// The plugin workshop (spec §5.6, the workshop rule): a bot builds a plugin in its scratch and installs it for the
// user's OK, which names it as the builder; after the OK its edits apply without a card while they ask for nothing the
// last OK didn't list, and the ceiling only goes down. Its three tools read and act only for its own plugins.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PLUGIN_API_VERSION, catalogPointDecl } from "@waifucave/clover-plugin-sdk";
import { botPaths } from "../../bots/paths";
import { workshopAdds } from "../changes";
import { RegistryCore, type OkCardRaiser } from "../core";
import { PluginFolders, builtByText, readPluginFolder } from "../folders";
import { fileRegistryStore } from "../state";
import { PluginWorkshop, workshopToolDefs } from "../workshop";

const temps: string[] = [];
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

const manifest = (id: string, over: Record<string, unknown> = {}) => JSON.stringify({
  manifest: 1, id, name: id, version: "1.0.0", engines: { clover: `^${PLUGIN_API_VERSION}` },
  contributes: { mcpServers: { srv: { type: "stdio", command: "bin/srv" } } }, ...over,
});

function write(dir: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
    if (path.startsWith("bin/")) chmodSync(join(dir, path), 0o755);
  }
}

/** The OK cards the registry raised: each request, its answer, and whether it was withdrawn. */
interface Raised { id: string; treeHash: string; card: string; answered: (a: { approved: boolean }) => void; signal?: AbortSignal }

function world(o: { cards?: OkCardRaiser } = {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "clover-b-workshop-")));
  temps.push(home);
  const pluginsDir = join(home, "plugins");
  mkdirSync(pluginsDir, { recursive: true });
  const store = fileRegistryStore(join(home, "plugins-state"));
  let folders: PluginFolders;
  const core = new RegistryCore({ catalog: catalogPointDecl, store, ...(o.cards ? { cards: o.cards } : {}), onOk: (id, hash) => folders.okGiven(id, hash) });
  folders = new PluginFolders({ core, store, pluginsDir, settleMs: 2_000 });
  folders.setBotNames((id) => (id === "luna" ? "Luna" : undefined));
  const workshop = new PluginWorkshop({ home, os: "macos", registry: core, folders });
  const scratch = (bot: string) => {
    const dir = botPaths(home, bot).scratch;
    mkdirSync(dir, { recursive: true });
    return dir;
  };
  const approve = async (id: string) => expect(await core.approve(id, core.get(id)!.treeHash!)).toBe("approved");
  return { home, pluginsDir, store, core, folders, workshop, scratch, approve };
}

const LUNA = { bot: "luna", sessionId: "s_luna" };
const ALPHA = { bot: "alpha", sessionId: "s_alpha" };

describe("workshopAdds", () => {
  async function snap(m: string, files: Record<string, string> = {}) {
    const dir = join(realpathSync(mkdtempSync(join(tmpdir(), "clover-b-ws-snap-"))), "tarot");
    temps.push(dirname(dir));
    write(dir, { "bin/srv": "#!/bin/sh\necho 1\n", "bin/other": "#!/bin/sh\necho 2\n", ...files, "clover.json": m });
    const r = await readPluginFolder(dir, { source: "local", provenance: { by: "bot", bot: "luna", at: 0 } });
    expect(r.snapshot).toBeDefined();
    return r.snapshot!;
  }

  test("a code change alone adds nothing; a program, a tool that runs without asking or a default it runs with asks", async () => {
    const base = await snap(manifest("tarot"));
    expect(workshopAdds(base, await snap(manifest("tarot"), { "bin/srv": "#!/bin/sh\necho changed\n" }))).toBeUndefined();
    // Its arguments are code like any other.
    expect(workshopAdds(base, await snap(manifest("tarot", { contributes: { mcpServers: { srv: { type: "stdio", command: "bin/srv", args: ["--fast"] } } } })))).toBeUndefined();
    expect(workshopAdds(base, await snap(manifest("tarot", { contributes: { mcpServers: { srv: { type: "stdio", command: "bin/other" } } } })))).toBe("it runs a program it didn't");
    expect(workshopAdds(base, await snap(manifest("tarot", { contributes: { mcpServers: { srv: { type: "stdio", command: "bin/srv", contained: ["show"] } } } })))).toMatch(/without asking/);
    expect(workshopAdds(base, await snap(manifest("tarot", { capabilities: ["network:api.example.com"] })))).toBe("it asks for more capabilities");
    const withSetting = (d: string) => manifest("tarot", {
      settings: { mode: { type: "string", title: "Mode", default: d } },
      contributes: { mcpServers: { srv: { type: "stdio", command: "bin/srv", args: ["${setting:mode}"] } } },
    });
    const s1 = await snap(withSetting("a"));
    expect(workshopAdds(s1, await snap(withSetting("b")))).toBe("it changes a setting's default that it runs with");
    // A default nothing it runs reads is data.
    const plain = (d: string) => manifest("tarot", { settings: { mode: { type: "string", title: "Mode", default: d } } });
    expect(workshopAdds(await snap(plain("a")), await snap(plain("b")))).toBeUndefined();
  });

  test("a bot's plugin whose own host starts running programs (`host.programs`) pauses for the OK; an edit of that host's code doesn't", async () => {
    const host = (over: Record<string, unknown> = {}) => manifest("tarot", { host: { entry: "host/index.ts", process: "own", ...over } });
    const code = (text: string) => ({ "host/index.ts": text, "package.json": "{\"type\":\"module\"}" });
    const base = await snap(host(), code("export const a = 1;\n"));
    expect(workshopAdds(base, await snap(host(), code("export const a = 2;\n")))).toBeUndefined();
    expect(workshopAdds(base, await snap(host({ programs: true }), code("export const a = 1;\n")))).toBe("its host code now runs programs");
    // Once OK'd with it, editing that host's code asks nothing new.
    const withPrograms = await snap(host({ programs: true }), code("export const a = 1;\n"));
    expect(workshopAdds(withPrograms, await snap(host({ programs: true }), code("export const a = 3;\n")))).toBeUndefined();
  });
});

describe("the workshop rule in the registry", () => {
  test("after the OK, the builder's code edit applies; a host added asks; dropped then re-added asks again", async () => {
    const w = world();
    const tarot = join(w.pluginsDir, "tarot");
    write(tarot, { "clover.json": manifest("tarot"), "bin/srv": "#!/bin/sh\necho 1\n" });
    await w.folders.installed("tarot", "bot", { bot: "luna" });
    expect(w.core.get("tarot")).toMatchObject({ state: "found", provenance: { by: "bot", bot: "luna" } });
    expect(w.folders.okText("tarot", "macos").source).toBe(builtByText("Luna"));
    expect(builtByText("Luna")).toBe("Built by Luna. Luna can change its code later without asking, within what this card lists.");
    await w.approve("tarot");
    expect(w.core.get("tarot")?.state).toBe("running");
    // A code edit by its builder: no card, and the OK moves to the new tree.
    write(tarot, { "bin/srv": "#!/bin/sh\necho 2\n" });
    await w.folders.refresh(tarot);
    expect(w.core.get("tarot")).toMatchObject({ state: "running" });
    expect(w.core.get("tarot")!.okHash).toBe(w.core.get("tarot")!.treeHash);
    // A host the card didn't list: asks again.
    write(tarot, { "clover.json": manifest("tarot", { capabilities: ["network:api.example.com"] }) });
    await w.folders.refresh(tarot);
    expect(w.core.get("tarot")?.state).toBe("found");
    await w.approve("tarot");
    // Dropped: applies (the ceiling goes down) …
    write(tarot, { "clover.json": manifest("tarot") });
    await w.folders.refresh(tarot);
    expect(w.core.get("tarot")?.state).toBe("running");
    // … and asked for again: a card, since the last OK no longer lists it.
    write(tarot, { "clover.json": manifest("tarot", { capabilities: ["network:api.example.com"] }) });
    await w.folders.refresh(tarot);
    expect(w.core.get("tarot")?.state).toBe("found");
  });

  test("a workshop tree the user OK'd with approvals: a code change is held as card styling, never applied", async () => {
    const w = world();
    const tarot = join(w.pluginsDir, "tarot");
    write(tarot, { "clover.json": manifest("tarot", { capabilities: ["approvals"] }), "bin/srv": "#!/bin/sh\necho 1\n" });
    await w.folders.installed("tarot", "bot", { bot: "luna" });
    await w.approve("tarot");
    const okd = w.core.get("tarot")!.okHash;
    write(tarot, { "bin/srv": "#!/bin/sh\necho 2\n" });
    await w.folders.refresh(tarot);
    const r = w.core.get("tarot")!;
    // Held for its OK: the OK stays the old tree's, and its card styling waits.
    expect([r.okHash, r.cardStylingHeld]).toEqual([okd, true]);
    expect(r.treeHash).not.toBe(okd);
  });

  test("a plugin the user installed keeps asking on every code change", async () => {
    const w = world();
    const tarot = join(w.pluginsDir, "tarot");
    write(tarot, { "clover.json": manifest("tarot"), "bin/srv": "#!/bin/sh\necho 1\n" });
    await w.folders.installed("tarot", "user-app");
    await w.approve("tarot");
    write(tarot, { "bin/srv": "#!/bin/sh\necho 2\n" });
    await w.folders.refresh(tarot);
    expect(w.core.get("tarot")?.state).toBe("found");
  });
});

describe("the workshop's tools", () => {
  test("PluginInstall from the bot's scratch: found, built by the bot; refused from anywhere else and over another's plugin", async () => {
    const w = world();
    const src = join(w.scratch("luna"), "tarot");
    write(src, { "clover.json": manifest("tarot"), "bin/srv": "#!/bin/sh\necho 1\n" });
    const r = await w.workshop.install(LUNA, "tarot");
    expect(r).toMatchObject({ id: "tarot", state: "found", updated: false });
    expect(w.core.get("tarot")?.provenance).toMatchObject({ by: "bot", bot: "luna" });
    expect(existsSync(join(w.pluginsDir, "tarot", "bin", "srv"))).toBe(true);
    // Outside its scratch and outputs.
    const elsewhere = join(w.home, "elsewhere", "dice");
    write(elsewhere, { "clover.json": manifest("dice"), "bin/srv": "#!/bin/sh\n" });
    await expect(w.workshop.install(LUNA, elsewhere)).rejects.toThrow(/own scratch folder/);
    // Another bot's scratch isn't its own either.
    await expect(w.workshop.install(ALPHA, src)).rejects.toThrow(/own scratch folder/);
    // Over a plugin it didn't build.
    const alphaTarot = join(w.scratch("alpha"), "tarot");
    write(alphaTarot, { "clover.json": manifest("tarot"), "bin/srv": "#!/bin/sh\n" });
    await expect(w.workshop.install(ALPHA, "tarot")).rejects.toThrow(/isn't a plugin you built/);
  });

  test("an update from scratch of its own plugin applies within the last OK, and asks when it adds a host", async () => {
    const w = world();
    const src = join(w.scratch("luna"), "tarot");
    write(src, { "clover.json": manifest("tarot"), "bin/srv": "#!/bin/sh\necho 1\n" });
    await w.workshop.install(LUNA, "tarot");
    await w.approve("tarot");
    write(src, { "bin/srv": "#!/bin/sh\necho 2\n" });
    expect(await w.workshop.validate(LUNA, "tarot")).toContain("updates your plugin tarot at once, with no card");
    expect(await w.workshop.install(LUNA, "tarot")).toMatchObject({ id: "tarot", state: "running", updated: true });
    write(src, { "clover.json": manifest("tarot", { capabilities: ["network:api.example.com"] }) });
    expect(await w.workshop.validate(LUNA, "tarot")).toContain("the user is asked again first: it asks for more capabilities");
    expect(await w.workshop.install(LUNA, "tarot")).toMatchObject({ id: "tarot", state: "found", updated: true, asks: "it asks for more capabilities" });
  });

  test("PluginStatus reads only the bot's own plugins, with its log's last lines", async () => {
    const w = world();
    write(join(w.scratch("luna"), "tarot"), { "clover.json": manifest("tarot"), "bin/srv": "#!/bin/sh\n" });
    await w.workshop.install(LUNA, "tarot");
    mkdirSync(join(w.home, "logs", "plugins"), { recursive: true });
    writeFileSync(join(w.home, "logs", "plugins", "tarot.log"), "line one\nline two\n");
    const tools = new Map(workshopToolDefs(w.workshop, LUNA).map((t) => [t.name, t]));
    expect([...tools.keys()]).toEqual(["PluginValidate", "PluginInstall", "PluginStatus"]);
    const mine = await tools.get("PluginStatus")!.run({ id: "tarot" });
    expect(mine.isError).toBe(false);
    expect(mine.text).toContain("tarot: waiting for the user's OK on its card");
    expect(mine.text).toContain("line two");
    const theirs = await workshopToolDefs(w.workshop, ALPHA).find((t) => t.name === "PluginStatus")!.run({ id: "tarot" });
    expect(theirs.isError).toBe(true);
    expect(theirs.text).toContain("isn't a plugin you built");
  });

  test("PluginValidate prints what the OK card will say, and installs nothing", async () => {
    const w = world();
    write(join(w.scratch("luna"), "tarot"), { "clover.json": manifest("tarot"), "bin/srv": "#!/bin/sh\n" });
    const out = await workshopToolDefs(w.workshop, LUNA).find((t) => t.name === "PluginValidate")!.run({ folder: "tarot" });
    expect(out.isError).toBe(false);
    expect(out.text).toContain("The OK will say:");
    expect(out.text).toContain("valid");
    expect(w.core.get("tarot")).toBeUndefined();
  });
});

describe("a workshop change that asks for more (the controller's ruling)", () => {
  const tick = () => new Promise((r) => setTimeout(r, 0));
  function cardsWorld() {
    const raised: Raised[] = [];
    const cards: OkCardRaiser = {
      raise: (req, answered, opts) => {
        const card = `card_${raised.length + 1}`;
        raised.push({ id: req.id, treeHash: req.treeHash, card, answered, ...(opts?.signal ? { signal: opts.signal } : {}) });
        return card;
      },
    };
    const w = world({ cards });
    const live = () => raised.filter((r) => r.signal?.aborted !== true && w.core.okCards().some((c) => c.card === r.card));
    return { ...w, raised, live };
  }
  async function okd(w: ReturnType<typeof cardsWorld>) {
    const tarot = join(w.pluginsDir, "tarot");
    write(tarot, { "clover.json": manifest("tarot"), "bin/srv": "#!/bin/sh\necho 1\n" });
    await w.folders.installed("tarot", "bot", { bot: "luna" });
    await w.core.installed("tarot", "bot");
    w.raised.at(-1)!.answered({ approved: true });
    await tick();
    expect(w.core.get("tarot")?.state).toBe("running");
    return tarot;
  }

  test("the edit stops the plugin and raises its OK card at once; PluginStatus says a card waits and why", async () => {
    const w = cardsWorld();
    const tarot = await okd(w);
    const before = w.raised.length;
    write(tarot, { "clover.json": manifest("tarot", { capabilities: ["notify"] }) });
    await w.folders.refresh(tarot);
    await tick();
    expect(w.core.get("tarot")?.state).toBe("found");
    expect(w.raised.length).toBe(before + 1);
    expect(w.raised.at(-1)).toMatchObject({ id: "tarot", treeHash: w.core.get("tarot")!.treeHash });
    const status = await workshopToolDefs(w.workshop, LUNA).find((t) => t.name === "PluginStatus")!.run({ id: "tarot" });
    expect(status.text).toContain("Your last change asks for more than the user OK'd (it asks for more capabilities), so the plugin is stopped until they answer. Its OK card is waiting for the user.");
  });

  test("OK: it runs with the new grant, and the snapshot moves", async () => {
    const w = cardsWorld();
    const tarot = await okd(w);
    write(tarot, { "clover.json": manifest("tarot", { capabilities: ["notify"] }) });
    await w.folders.refresh(tarot);
    await tick();
    w.raised.at(-1)!.answered({ approved: true });
    await tick();
    expect(w.core.get("tarot")).toMatchObject({ state: "running", granted: ["notify"] });
    // The new grant is the ceiling now: a code edit under it applies with no card.
    const before = w.raised.length;
    write(tarot, { "bin/srv": "#!/bin/sh\necho 3\n" });
    await w.folders.refresh(tarot);
    await tick();
    expect([w.core.get("tarot")?.state, w.raised.length]).toEqual(["running", before]);
  });

  test("No: it stays off; a later edit that takes the request back out runs again with no card", async () => {
    const w = cardsWorld();
    const tarot = await okd(w);
    write(tarot, { "clover.json": manifest("tarot", { capabilities: ["notify"] }) });
    await w.folders.refresh(tarot);
    await tick();
    w.raised.at(-1)!.answered({ approved: false });
    await tick();
    expect(w.core.get("tarot")?.state).toBe("refused");
    const status = await workshopToolDefs(w.workshop, LUNA).find((t) => t.name === "PluginStatus")!.run({ id: "tarot" });
    expect(status.text).toContain("The user said no to your change (it asks for more capabilities). Take that request back out and it runs again with no card.");
    const before = w.raised.length;
    write(tarot, { "clover.json": manifest("tarot"), "bin/srv": "#!/bin/sh\necho 4\n" });
    await w.folders.refresh(tarot);
    await tick();
    expect([w.core.get("tarot")?.state, w.raised.length]).toEqual(["running", before]);
  });

  test("one card per pending change: a further edit while it waits replaces the card, and taking the request out withdraws it", async () => {
    const w = cardsWorld();
    const tarot = await okd(w);
    write(tarot, { "clover.json": manifest("tarot", { capabilities: ["notify"] }) });
    await w.folders.refresh(tarot);
    await tick();
    const first = w.raised.at(-1)!;
    write(tarot, { "clover.json": manifest("tarot", { capabilities: ["notify"] }), "bin/srv": "#!/bin/sh\necho 5\n" });
    await w.folders.refresh(tarot);
    await tick();
    const second = w.raised.at(-1)!;
    expect(second.card).not.toBe(first.card);
    expect(first.signal?.aborted).toBe(true);
    expect(w.live().map((r) => r.card)).toEqual([second.card]);
    // An answer on the withdrawn card does nothing.
    first.answered({ approved: true });
    await tick();
    expect(w.core.get("tarot")?.state).toBe("found");
    // The request taken back out: it runs under the last OK, and the waiting card goes.
    write(tarot, { "clover.json": manifest("tarot") });
    await w.folders.refresh(tarot);
    await tick();
    expect(w.core.get("tarot")?.state).toBe("running");
    expect(second.signal?.aborted).toBe(true);
    expect(w.live()).toEqual([]);
  });
});
