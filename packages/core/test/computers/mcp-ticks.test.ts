// Which computers run a local MCP server (spec §9.1; the controller's ruling on J-M2's default): each computer ticks
// its own, never synced. The install flow ticks a plugin's servers where its OK card was answered; a synced copy
// elsewhere isn't ticked; Mirror ticks one server on another computer after that computer's card; the user unticks
// one here. The hello names what's ticked, and the `computer` field's list follows.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Caller } from "@waifucave/clover-protocol";
import { FileMcpTicks, mcpTicksPath } from "../../src/computers/mcp-ticks";
import { placementFields, type McpResult, type McpServerPlacement } from "../../src/computers/mcp";
import { answersFor, makePhone } from "../tree/answer-support";
import { Cluster, until } from "../tree/cluster-support";

const temp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));
/** A Clover home whose ticks record exists already (an earlier run's). */
const ranBefore = (home: string) => {
  mkdirSync(join(home, "levels"), { recursive: true });
  writeFileSync(mcpTicksPath(home), JSON.stringify({ plugins: {}, servers: {} }));
};
const BOT: Caller = { kind: "session", sessionId: "s_alpha", sessionKind: "bot", bot: "alpha" };
const code = async (p: Promise<unknown>) => ((await p.then(() => undefined, (e: unknown) => e)) as { code?: string } | undefined)?.code ?? "ok";

describe("FileMcpTicks", () => {
  test("the run that creates the file ticks its first listing (the one-time migration's snapshot); nothing after it", () => {
    const path = mcpTicksPath(temp("lane-j-ticks-"));
    const first = new FileMcpTicks(path);
    expect(first.ticked("blender", "acme/blender")).toBe(false);
    first.adopt([{ server: "blender", plugin: "acme/blender" }]);
    expect(first.ticked("blender", "acme/blender")).toBe(true);
    // A plugin synced in later in the same run isn't adopted.
    first.adopt([{ server: "late", plugin: "acme/late" }]);
    expect(first.ticked("late", "acme/late")).toBe(false);
    const later = new FileMcpTicks(path);
    later.adopt([{ server: "figma-local", plugin: "acme/figma" }]);
    expect(later.ticked("blender", "acme/blender")).toBe(true);
    // A synced plugin's server arriving after the migration isn't ticked here.
    expect(later.ticked("figma-local", "acme/figma")).toBe(false);
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("the install flow ticks a plugin's servers; one server's untick wins; each change is told", () => {
    const home = temp("lane-j-ticks-");
    const path = mcpTicksPath(home);
    ranBefore(home);
    let changes = 0;
    const t = new FileMcpTicks(path, () => changes++);
    expect(t.ticked("render", "acme/tools")).toBe(false);
    t.installed("acme/tools");
    expect(t.ticked("render", "acme/tools")).toBe(true);
    expect(t.ticked("export", "acme/tools")).toBe(true);
    t.set("render", false);
    expect(t.ticked("render", "acme/tools")).toBe(false);
    expect(t.ticked("export", "acme/tools")).toBe(true);
    t.set("render", true);
    expect(changes).toBe(3);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ plugins: { "acme/tools": true }, servers: { render: true } });
    // The same again changes nothing.
    t.installed("acme/tools");
    t.set("render", true);
    expect(changes).toBe(3);
  });
});

describe("a bundled plugin's per-computer server (the controller's ruling, 2026-11-10)", () => {
  let cluster: Cluster | undefined;
  afterEach(() => cluster?.close());

  test("runs here by rule on every start, with no OK and no migration; the user's untick sticks across restarts", async () => {
    const home = temp("lane-j-ticks-bundled-");
    // A run before: the record exists (an install's tick wrote it), so no one-time migration ticks anything.
    new FileMcpTicks(mcpTicksPath(home)).installed("other/plugin");
    const place: McpServerPlacement = { name: "browser", kind: "local", computers: [] };
    let told = 0;
    const opts = (ticks: FileMcpTicks) => ({
      mcp: () => ({
        // The host lists its servers again on every tick change (daemon.ts: PluginMcp.refresh), so an untick stops one.
        onTicksChanged: () => { told++; },
        placement: (s: string) => (s === "browser" || s === "blender" ? place : undefined),
        fields: () => ({}),
        call: async (): Promise<McpResult> => ({ content: [] }),
        scratch: () => "home/Studio",
        localServers: () => [{ server: "browser", plugin: "clover/browser", bundled: true }, { server: "blender", plugin: "acme/blender" }],
        ticks,
      }),
    });
    cluster = new Cluster();
    const first = await cluster.add("Studio", opts(new FileMcpTicks(mcpTicksPath(home))));
    // The bundled one by rule; a third party's, never OK'd or ticked here, not (fail closed).
    expect(first.node.mcpComputers("browser")).toEqual(["Studio"]);
    expect(first.node.mcpComputers("blender")).toEqual([]);
    first.node.mcpTicks.set("browser", false);
    expect(first.node.mcpComputers("browser")).toEqual([]);
    expect(told).toBe(1);
    first.node.mcpTicks.installed("acme/blender");
    expect(told).toBe(2);
    expect(first.node.mcpComputers("blender")).toEqual(["Studio"]);
    cluster.close();
    // A restart (an upgrade reads the same file): the untick holds; ticked again, it runs again.
    cluster = new Cluster();
    const again = await cluster.add("Studio", opts(new FileMcpTicks(mcpTicksPath(home))));
    expect(again.node.mcpComputers("browser")).toEqual([]);
    again.node.mcpTicks.set("browser", true);
    expect(again.node.mcpComputers("browser")).toEqual(["Studio"]);
    expect(JSON.parse(readFileSync(mcpTicksPath(home), "utf8")).servers).toEqual({ browser: true });
  }, 30_000);
});

describe("the migration across runs", () => {
  test("a run that never lists a local server writes nothing, and the next run adopts", () => {
    const path = mcpTicksPath(temp("lane-j-ticks-mig-"));
    const loading = new FileMcpTicks(path);
    expect(loading.adopt([])).toBe(false);
    expect(existsSync(path)).toBe(false);
    const next = new FileMcpTicks(path);
    expect(next.adopt([{ server: "blender", plugin: "acme/blender" }])).toBe(true);
    expect(next.ticked("blender", "acme/blender")).toBe(true);
    expect(new FileMcpTicks(path).ticked("blender", "acme/blender")).toBe(true);
  });

  test("a tick before any listing is a record of its own: nothing is adopted after it", () => {
    const path = mcpTicksPath(temp("lane-j-ticks-mig-"));
    const t = new FileMcpTicks(path);
    t.installed("acme/tools");
    expect(t.adopt([{ server: "blender", plugin: "acme/blender" }])).toBe(false);
    expect(t.ticked("blender", "acme/blender")).toBe(false);
    expect(new FileMcpTicks(path).adopt([{ server: "blender", plugin: "acme/blender" }])).toBe(false);
  });
});

describe("the node's migration", () => {
  let cluster: Cluster | undefined;
  afterEach(() => cluster?.close());

  test("an install from before ticks keeps running: the first listing is ticked here, and the host is told", async () => {
    cluster = new Cluster();
    let refreshed = 0;
    const studio = await cluster.add("Studio", {
      mcp: () => ({
        placement: () => undefined, fields: () => ({}), call: async () => ({ content: [] }), scratch: () => "home/Studio",
        localServers: () => [{ server: "blender", plugin: "acme/blender" }],
        onTicksChanged: () => { refreshed++; },
      }),
    });
    expect(studio.node.mcpComputers("blender")).toEqual(["Studio"]);
    await until(() => refreshed === 1, 2000, "the host to hear of the migration's ticks");
    expect(existsSync(mcpTicksPath(studio.cloverHome))).toBe(true);
    // Once: later listings change nothing.
    studio.node.mcpComputers("blender");
    await new Promise((r) => setTimeout(r, 20));
    expect(refreshed).toBe(1);
  });

  test("the snapshot is the node's start, once: a plugin installed later in that run isn't adopted (the stage 1 review)", async () => {
    cluster = new Cluster();
    let installed = false;
    const studio = await cluster.add("Studio", {
      mcp: () => ({
        placement: () => undefined, fields: () => ({}), call: async () => ({ content: [] }), scratch: () => "home/Studio",
        // Nothing local at the start; a plugin installed and OK'd later in the same run.
        localServers: () => (installed ? [{ server: "blender", plugin: "acme/blender" }] : []),
      }),
    });
    expect(studio.node.mcpComputers("blender")).toEqual([]);
    installed = true;
    // Its install flow didn't tick it here (this test plays none): the migration doesn't either.
    expect(studio.node.mcpComputers("blender")).toEqual([]);
    expect(existsSync(mcpTicksPath(studio.cloverHome))).toBe(false);
    // Its install flow does.
    studio.node.mcpTicks.installed("acme/blender");
    expect(studio.node.mcpComputers("blender")).toEqual(["Studio"]);
  });
});

describe("a levels/ folder that can't be written", () => {
  test("the node's ticks don't throw at start: nothing is adopted, nothing is ticked, and a tick says it couldn't save", () => {
    const home = temp("lane-j-ticks-ro-");
    writeFileSync(join(home, "levels"), "a file, not a folder");
    const lines: string[] = [];
    const t = new FileMcpTicks(mcpTicksPath(home), () => {}, (l) => lines.push(l));
    expect(lines.some((l) => l.includes("can't be written"))).toBe(true);
    t.adopt([{ server: "blender", plugin: "acme/blender" }]);
    expect(t.ticked("blender", "acme/blender")).toBe(false);
    expect(() => t.set("blender", true)).toThrow();
  });
});

describe("a local server across two computers", () => {
  let cluster: Cluster | undefined;
  afterEach(() => cluster?.close());

  test("installed on Studio only; Mirror ticks it on Laptop1 with its card; the field's list follows; an untick takes it off", async () => {
    const phone = await makePhone();
    const homes = { Studio: temp("lane-j-ticks-studio-"), Laptop1: temp("lane-j-ticks-laptop-") };
    // Both computers ran before (no migration): the plugin is on both, synced, but installed only on Studio.
    // Each computer ran before (its record is there): no migration.
    for (const h of Object.values(homes)) ranBefore(h);
    const ticks = { Studio: new FileMcpTicks(mcpTicksPath(homes.Studio)), Laptop1: new FileMcpTicks(mcpTicksPath(homes.Laptop1)) };
    ticks.Studio.installed("acme/blender");
    const calls: string[] = [];
    const refreshed: string[] = [];
    const place: McpServerPlacement = { name: "blender", kind: "local", computers: [] };
    cluster = new Cluster();
    const opts = {
      answers: () => answersFor(phone),
      askUser: () => phone.ask,
      mcp: (name: string) => ({
        placement: (s: string) => (s === "blender" ? place : undefined),
        fields: () => placementFields({ ...place, computers: ["a", "b"] }, [{ name: "Render", inputSchema: { type: "object" as const } }]).fields,
        call: async (c: { server: string; tool: string }): Promise<McpResult> => { calls.push(`${name} ${c.server}.${c.tool}`); return { content: [{ type: "text", text: name }] }; },
        scratch: () => `home/${name}`,
        localServers: () => [{ server: "blender", plugin: "acme/blender" }],
        ticks: ticks[name as "Studio" | "Laptop1"],
        onTicksChanged: () => { refreshed.push(name); },
      }),
    };
    const studio = await cluster.add("Studio", opts);
    const laptop = await cluster.add("Laptop1", opts);
    await laptop.node.registry.setLevel("Laptop1", "automatic", { via: "terminal" });
    await cluster.join();
    expect(studio.node.mcpComputers("blender")).toEqual(["Studio"]);
    await until(() => laptop.node.mcpComputers("blender").join() === "Studio", 5000, "Laptop1 to hear Studio runs blender");
    const ctx = { session: "s_alpha", as: BOT, callId: "c1" };
    // Not on Laptop1 yet: the field's live list refuses it.
    expect(await code(studio.node.mcp!.run("blender", "Render", { computer: "Laptop1" }, ctx))).toBe("invalid");
    // Mirror: Laptop1's own card, the phone's yes, and Laptop1 ticks it; Studio hears at once.
    expect(await studio.node.mirror("blender", null, ["Laptop1"], "s_alpha")).toEqual({ installed: ["Laptop1"], failed: [] });
    expect(phone.shown.map((n) => [n.computer, n.method])).toEqual([["Laptop1", "mcp.mirror"]]);
    await until(() => studio.node.mcpComputers("blender").join() === "Studio,Laptop1", 5000, "Studio to hear Laptop1 runs blender");
    const r = await studio.node.mcp!.run("blender", "Render", { computer: "Laptop1" }, { ...ctx, callId: "c2" });
    expect(r.computer).toBe("Laptop1");
    expect(calls).toEqual(["Laptop1 blender.Render"]);
    // Mirror's tick told Laptop1's host to start it.
    expect(refreshed).toEqual(["Laptop1"]);
    // The user unticks it on Laptop1: it comes off the list everywhere, and Laptop1's host is told to close it.
    laptop.node.mcpTicks.set("blender", false);
    expect(refreshed).toEqual(["Laptop1", "Laptop1"]);
    await until(() => studio.node.mcpComputers("blender").join() === "Studio", 5000, "Studio to hear Laptop1 dropped blender");
    expect(await code(studio.node.mcp!.run("blender", "Render", { computer: "Laptop1" }, { ...ctx, callId: "c3" }))).toBe("invalid");
    // Mirror to a computer where the plugin hasn't synced: refused there, nothing ticked.
    const none = await studio.node.mirror("not-here", null, ["Laptop1"]);
    expect(none.failed[0]).toMatchObject({ computer: "Laptop1", code: "not_installed" });
  }, 30_000);
});
