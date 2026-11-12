// Every example in skills/plugin-examples/SKILL.md, built the way a bot would: the template ones equal the scaffold's
// files exactly, each folder passes Clover's own validator (`clover plugin validate`'s), and all of them load through
// the plugin registry in a temp home, OK'd, with none failed and the widget plugin filling the board's spot.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { API_CALLS, type ApiCallInfo, type HostModule, type HostPluginApi, type McpServerTransport } from "@waifucave/clover-plugin-sdk";
import { templateFiles } from "@waifucave/clover-plugin-sdk/templates";
import { FakeApprovalBroker } from "../../../../../packages/core/src/contracts/fakes/approval-broker";
import { FakeClock } from "../../../../../packages/core/src/contracts/fakes/clock";
import { MemorySecretStore } from "../../../../../packages/core/src/contracts/fakes/secret-store";
import { openPluginRegistry, type OpenedRegistry } from "../../../../../packages/core/src/registry/open";
import { startPluginHost } from "../../../../../packages/core/src/plugin-host/daemon-host";
import { buildPluginModule } from "../../../../../packages/core/src/registry/build";
import { pluginToolReadOnly } from "../../../../../packages/core/src/registry/read-only-tools";
import { validatePluginFolder } from "../../../../../packages/core/src/registry/validate";
import { handlerFields, visibleEntries } from "../../../../../packages/core/src/plugin-host/api/points";
import { readExamples, type Example } from "./examples";

const examples = readExamples();
const temps: string[] = [];
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

function writeExample(root: string, ex: Example): string {
  const dir = join(root, ex.folder);
  for (const [path, body] of Object.entries(ex.files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  return dir;
}

const nameOf = (ex: Example): string => (JSON.parse(ex.files["clover.json"]!) as { name: string }).name;

test("the skill holds every example the entry skill promises", () => {
  expect(examples.map((e) => e.folder)).toEqual([
    "ex-tool", "ex-settings", "ex-theme", "ex-bot", "ex-model", "ex-trigger", "ex-point",
    "ex-status", "ex-app", "ex-board", "ex-board-widget", "ex-buddy", "ex-timeline", "ex-fit", "ex-fit-tile",
  ]);
  for (const ex of examples) expect({ folder: ex.folder, manifest: "clover.json" in ex.files }).toEqual({ folder: ex.folder, manifest: true });
});

describe("a template example is exactly what the scaffold gives", () => {
  for (const ex of examples.filter((e) => e.template !== undefined)) {
    test(`${ex.folder} (${ex.template})`, () => {
      const made = templateFiles(ex.template!, { id: ex.folder, name: nameOf(ex) });
      if ("error" in made) throw new Error(made.error);
      expect(ex.files).toEqual(made.files);
    });
  }
});

describe("each example passes Clover's validator", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "clover-builder-examples-")));
  temps.push(root);
  for (const ex of examples) {
    test(ex.folder, async () => {
      const v = await validatePluginFolder(writeExample(root, ex), { os: "macos" });
      expect(v.issues.filter((i) => i.severity === "error")).toEqual([]);
      expect(v.ok).toBe(true);
      if (ex.folder === "ex-buddy") expect(v.children.map((c) => c.id)).toEqual(["ex-buddy/settings"]);
    });
  }
});

describe("each example's code builds the way the registry builds it", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "clover-builder-builds-")));
  temps.push(root);
  for (const ex of examples) {
    const entries: [string, "client" | "bun"][] = [];
    const walk = (prefix: string, manifestText: string | undefined) => {
      if (manifestText === undefined) return;
      const m = JSON.parse(manifestText) as { host?: { entry: string }; client?: { entry: string } };
      if (m.client) entries.push([prefix + m.client.entry, "client"]);
      if (m.host) entries.push([prefix + m.host.entry, "bun"]);
    };
    walk("", ex.files["clover.json"]);
    for (const f of Object.keys(ex.files)) {
      const child = /^plugins\/([^/]+)\/clover\.json$/.exec(f);
      if (child) walk(`plugins/${child[1]}/`, ex.files[f]);
    }
    for (const [entry, side] of entries) {
      test(`${ex.folder}: ${entry}`, async () => {
        const dir = writeExample(root, ex);
        const built = await buildPluginModule({ entry: join(dir, entry), outFile: join(root, "out", ex.folder, `${entry}.js`), side });
        if (side === "client") for (const i of built.imports) expect(["react", "react/jsx-runtime", "react-dom", "@waifucave/clover-plugin-sdk/ui"]).toContain(i);
        expect(built.source.length).toBeGreaterThan(0);
      });
    }
  }
});

describe("all of them load through the registry in a temp home", () => {
  let home = "";
  let opened: OpenedRegistry;
  beforeAll(async () => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "clover-builder-home-")));
    temps.push(home);
    for (const ex of examples) writeExample(join(home, "plugins"), ex);
    opened = await openPluginRegistry({ cloverHome: home, os: "macos", broker: new FakeApprovalBroker({ clock: new FakeClock() }), secrets: new MemorySecretStore(), settleMs: 50 });
  });
  afterAll(() => opened?.close());

  test("each is found and waits for the OK before anything runs", () => {
    for (const ex of examples) expect({ id: ex.folder, state: opened.registry.get(ex.folder)?.state }).toEqual({ id: ex.folder, state: "found" });
  });

  test("OK'd, none fails: each runs, or waits for the part of the app it draws in", async () => {
    for (const ex of examples) {
      const r = opened.registry.get(ex.folder)!;
      await opened.registry.approve(ex.folder, r.treeHash!);
    }
    for (const ex of examples) {
      const r = opened.registry.get(ex.folder)!;
      expect({ id: ex.folder, state: r.state, ok: ["running", "waiting"].includes(r.state) }).toEqual({ id: ex.folder, state: r.state, ok: true });
    }
    const child = opened.registry.get("ex-buddy/settings");
    expect(child === undefined ? "missing" : ["running", "waiting"].includes(child.state) ? "loads" : child.state).toBe("loads");
  });

  test("the widget waits on the board's own spot, the board on Settings: nothing else", () => {
    expect(opened.registry.get("ex-board-widget")!.reason).toBe("waiting for `ex-board.widgets`");
    expect(opened.registry.get("ex-board")!.reason).toBe("waiting for `settings.section`");
    for (const id of ["ex-tool", "ex-bot", "ex-buddy", "ex-model", "ex-theme", "ex-trigger", "ex-timeline"]) expect({ id, state: opened.registry.get(id)!.state }).toEqual({ id, state: "running" });
  });

  test("the timeline's read tool is read-only as its OK showed it (no card); its writes are not", () => {
    expect(pluginToolReadOnly(opened.registry, "ex-timeline", "timeline", "TimelineRead", { fenced: true })).toBe(true);
    for (const t of ["TimelineAdd", "TimelineMove", "TimelineRemove"]) expect([t, pluginToolReadOnly(opened.registry, "ex-timeline", "timeline", t, { fenced: true })]).toEqual([t, false]);
  });
});

// The timeline's host half, run as the plugin host runs it: a bot's tool calls change what the page reads back through
// its `ui.read`, and each change reaches the page as `changed`.
test("ex-timeline: the tools change what the page reads, and the page hears each change", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "clover-builder-timeline-")));
  temps.push(root);
  const dir = writeExample(root, examples.find((e) => e.folder === "ex-timeline")!);
  const host = (await import(join(dir, "host", "index.ts"))) as HostModule & { ui: { read: (a: unknown) => unknown; add: (a: unknown) => unknown } };
  const heard: { event: string; data: unknown }[] = [];
  const store = new Map<string, unknown>();
  const synced = { get: async (k: string) => store.get(k), set: async (k: string, v: unknown) => void store.set(k, structuredClone(v)) };
  await (host.start as (a: HostPluginApi) => Promise<void>)({ ui: { send: (event: string, data?: unknown) => heard.push({ event, data }) }, storage: { synced } } as unknown as HostPluginApi);
  const waiting = new Map<unknown, (m: Record<string, unknown>) => void>();
  const transport: McpServerTransport = { start: async () => {}, close: async () => {}, send: async (m) => { waiting.get(m.id)?.(m); } };
  await host.mcp!.timeline!(transport, {} as HostPluginApi);
  let n = 0;
  const tool = async (name: string, args: Record<string, unknown> = {}) => {
    const id = ++n;
    const m = await new Promise<Record<string, unknown>>((resolve) => { waiting.set(id, resolve); transport.onmessage!({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }); });
    return m.result as { content: { text: string }[]; isError?: boolean };
  };
  const read = () => (host.ui.read(undefined) as { items: { id: string; title: string; start: number }[] }).items;

  expect(read()).toEqual([]);
  expect((await tool("TimelineAdd", { title: "Intro", start: 0, length: 4 })).isError).toBeUndefined();
  await tool("TimelineAdd", { title: "Outro", start: 30 });
  expect(read().map((i) => [i.title, i.start])).toEqual([["Intro", 0], ["Outro", 30]]);
  await tool("TimelineMove", { id: read()[1]!.id, start: 2 });
  expect(read().map((i) => [i.title, i.start])).toEqual([["Intro", 0], ["Outro", 2]]);
  await tool("TimelineRemove", { id: read()[0]!.id });
  expect(read().map((i) => i.title)).toEqual(["Outro"]);
  expect(JSON.parse((await tool("TimelineRead")).content[0]!.text)).toEqual(read());
  expect((await tool("TimelineMove", { id: "nope", start: 1 })).isError).toBe(true);
  // The page's own button goes through the same host half, and a clip from a picked video keeps its token (a path or
  // anything else in its place is dropped).
  host.ui.add({ title: "From the page", start: 10 });
  host.ui.add({ title: "clip.mp4", start: 20, source: "grant:0b9f2a4e-3c1d-4e5f-8a6b-7c8d9e0f1a2b" });
  host.ui.add({ title: "sneaky", start: 25, source: "/Users/someone/secret.mp4" });
  expect(read().map((i) => [i.title, (i as { source?: string }).source ?? null])).toEqual([
    ["Outro", null], ["From the page", null], ["clip.mp4", "grant:0b9f2a4e-3c1d-4e5f-8a6b-7c8d9e0f1a2b"], ["sneaky", null],
  ]);
  // Seven changes (two adds, a move, a remove, the page's three adds), each sent to the page as the timeline then was.
  expect(heard.map((h) => h.event)).toEqual(Array(7).fill("changed"));
  expect((heard.at(-1)!.data as { items: unknown[] }).items).toEqual(read());
  // An effect's answer stays on its clip (a filter, nothing else), the edit list names each clip's time, token and
  // filters, and the page's Clear (after the user's yes) empties it.
  const ui = host.ui as unknown as { filter: (a: unknown) => unknown; editList: () => { text: string }; clear: () => unknown };
  const clip = read().find((i) => i.title === "clip.mp4")!;
  ui.filter({ id: clip.id, filter: "hue=s=0" });
  expect(() => ui.filter({ id: clip.id, filter: "x; rm -rf /" })).toThrow("an effect answered no filter");
  expect(ui.editList().text.split("\n")).toContain("20\t5\tclip.mp4\tgrant:0b9f2a4e-3c1d-4e5f-8a6b-7c8d9e0f1a2b\thue=s=0");
  // Kept in the synced store at each change, so a process started again (a pick restarts it) finds the timeline.
  expect((store.get("timeline") as { items: unknown[] }).items).toEqual(read());
  ui.clear();
  expect(read()).toEqual([]);
  expect(heard.length).toBe(9);
});

// The export, natively (`host.programs`): the host half runs ffmpeg on the picks' real paths. A stand-in ffmpeg on PATH
// records its arguments and writes the output it's given; the timeline comes back from the synced store first.
test("ex-timeline: render runs ffmpeg on the real paths of the picks, each clip trimmed with its filters", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "clover-builder-render-")));
  temps.push(root);
  const dir = writeExample(root, examples.find((e) => e.folder === "ex-timeline")!);
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "ffmpeg"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${join(root, "args.txt")}"\nfor last; do :; done\necho VIDEO > "$last"\n`, { mode: 0o755 });
  // In a process of its own, with the stand-in first on its PATH, as the host's own process runs it.
  const script = `
    const host = await import(${JSON.stringify(join(dir, "host", "index.ts"))});
    const paths = { "grant:aaaaaaaa-0000-4000-8000-000000000001": ${JSON.stringify(join(root, "a.mp4"))}, "grant:aaaaaaaa-0000-4000-8000-000000000002": ${JSON.stringify(join(root, "out.mp4"))} };
    const store = new Map([["timeline", { next: 3, items: [
      { id: "i1", title: "a.mp4", start: 0, length: 4, source: "grant:aaaaaaaa-0000-4000-8000-000000000001", filters: ["hue=s=0"] },
      { id: "i2", title: "Title card", start: 4, length: 2 },
    ] }]]);
    await host.start({ ui: { send() {} }, storage: { synced: { get: async (k) => store.get(k), set: async (k, v) => void store.set(k, v) } }, files: { path: async (t) => paths[t] ?? Promise.reject(new Error("refused")) } });
    const refused = await host.ui.render({ output: "/Users/someone/out.mp4" }).then(() => "ran", (e) => e.message);
    console.log(JSON.stringify({ refused, done: await host.ui.render({ output: "grant:aaaaaaaa-0000-4000-8000-000000000002" }) }));
  `;
  const r = spawnSync(process.execPath, ["-e", script], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: "utf8" });
  expect(r.stderr).toBe("");
  expect(JSON.parse(r.stdout)).toEqual({ refused: "render takes the save pick's token as `output`", done: { rendered: 1 } });
  expect(readFileSync(join(root, "args.txt"), "utf8").trim().split("\n")).toEqual([
    "-y", "-i", join(root, "a.mp4"), "-filter_complex", "[0:v]trim=duration=4,setpts=PTS-STARTPTS,hue=s=0[v0];[v0]concat=n=1:v=1:a=0[out]", "-map", "[out]", join(root, "out.mp4"),
  ]);
  expect(readFileSync(join(root, "out.mp4"), "utf8")).toBe("VIDEO\n");
});

// The page's own point: an effect plugin fills `ex-timeline.effects`, the timeline (its declarer) sees the entry with the
// declared fields only, and only once the effect plugin is OK'd and running; `apply` is a handler field, which
// `points.call` runs in the effect plugin's own host.
test("ex-timeline: an effect plugin fills its point; the timeline sees it once it runs, with the declared fields", async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "clover-builder-effects-")));
  temps.push(home);
  // The page's part up: `main` is the shell's, which a bare temp home doesn't have, so the page stands in on
  // `app.surface` (always up), as the board does below; its declaration is the example's, unchanged.
  const timeline = examples.find((e) => e.folder === "ex-timeline")!;
  const manifest = JSON.parse(timeline.files["clover.json"]!) as { contributes: { ui: { spot: string; key?: string }[] } };
  manifest.contributes.ui[0]!.spot = "app.surface";
  delete manifest.contributes.ui[0]!.key;
  writeExample(join(home, "plugins"), { ...timeline, files: { ...timeline.files, "clover.json": JSON.stringify(manifest) } });
  writeExample(join(home, "plugins"), { title: "an effect", folder: "ex-sepia", files: {
    "clover.json": JSON.stringify({ manifest: 1, id: "ex-sepia", name: "Ex sepia", engines: { clover: "^1.0.0" }, host: { entry: "host/index.ts", runtime: "bun" },
      contributes: { "ex-timeline.effects": [{ id: "sepia", title: "Sepia", apply: "sepia", secret: "not declared" }] } }),
    "host/index.ts": "export async function sepia() { return { filter: \"colorchannelmixer=.393:.769:.189\" }; }\n",
  } });
  const o = await openPluginRegistry({ cloverHome: home, os: "macos", broker: new FakeApprovalBroker({ clock: new FakeClock() }), secrets: new MemorySecretStore(), settleMs: 50 });
  try {
    const seen = () => {
      const point = o.registry.points().find((p) => p.name === "ex-timeline.effects" && p.active)!;
      return visibleEntries({ registry: o.registry, assetUrl: (id, path) => `asset://${id}/${path}` }, point);
    };
    await o.registry.approve("ex-timeline", o.registry.get("ex-timeline")!.treeHash!);
    const point = o.registry.points().find((p) => p.name === "ex-timeline.effects");
    expect(point?.declaredBy).toEqual(expect.objectContaining({ pluginId: "ex-timeline" }));
    expect(handlerFields(point!.decl!.fields as Record<string, unknown>)).toEqual(["apply"]);
    // Not OK'd yet: no entry.
    expect(seen()).toEqual([]);
    await o.registry.approve("ex-sepia", o.registry.get("ex-sepia")!.treeHash!);
    expect(seen()).toEqual([{ pluginId: "ex-sepia", entryId: "sepia", value: { id: "sepia", title: "Sepia", apply: "sepia" } }]);
  } finally {
    o.close();
  }
});

// The board's part up: Settings belongs to Clover's own tree, which a bare temp home doesn't have, so the board stands
// in on `app.surface` (always up); its own spot and the widget are the example's, unchanged.
test("once the board is up, the widget fills its spot, and the spot is listed with the board as its declarer", async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "clover-builder-board-")));
  temps.push(home);
  const board = examples.find((e) => e.folder === "ex-board")!;
  const manifest = JSON.parse(board.files["clover.json"]!) as { contributes: { ui: { spot: string }[] } };
  manifest.contributes.ui[0]!.spot = "app.surface";
  writeExample(join(home, "plugins"), { ...board, files: { ...board.files, "clover.json": JSON.stringify(manifest) } });
  writeExample(join(home, "plugins"), examples.find((e) => e.folder === "ex-board-widget")!);
  const o = await openPluginRegistry({ cloverHome: home, os: "macos", broker: new FakeApprovalBroker({ clock: new FakeClock() }), secrets: new MemorySecretStore(), settleMs: 50 });
  try {
    for (const id of ["ex-board", "ex-board-widget"]) await o.registry.approve(id, o.registry.get(id)!.treeHash!);
    expect(o.registry.get("ex-board-widget")!.state).toBe("running");
    const filled = o.registry.entries("ui").filter((c) => (c.value as { spot?: string }).spot === "ex-board.widgets");
    expect(filled.map((c) => [c.pluginId, c.state])).toEqual([["ex-board-widget", "active"]]);
    const spot = o.registry.points().find((p) => p.name === "ex-board.widgets");
    expect(spot?.declaredBy).toEqual(expect.objectContaining({ pluginId: "ex-board" }));
    expect(spot?.spot).toBe(true);
  } finally {
    o.close();
  }
});

// The examples' host halves in Clover's real plugin host (`startPluginHost`, the daemon's own, over a real registry,
// each plugin OK'd): its process, its plugin API, its MCP channel. A call an example promises that the host doesn't
// serve fails here, not in a bot's build (the owner's bot crashed on a call a skill named and no host served).
describe("the examples' host halves run in the real plugin host", () => {
  let home = "";
  let opened: OpenedRegistry;
  let ph: Awaited<ReturnType<typeof startPluginHost>>;
  const USER = { kind: "user", client: "app" } as const;
  const WITH_HOST = ["ex-tool", "ex-trigger", "ex-timeline"];
  beforeAll(async () => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "clover-builder-realhost-")));
    temps.push(home);
    for (const id of WITH_HOST) writeExample(join(home, "plugins"), examples.find((e) => e.folder === id)!);
    const secrets = new MemorySecretStore();
    opened = await openPluginRegistry({ cloverHome: home, os: "macos", broker: new FakeApprovalBroker({ clock: new FakeClock() }), secrets, settleMs: 50 });
    for (const id of WITH_HOST) await opened.registry.approve(id, opened.registry.get(id)!.treeHash!);
    ph = await startPluginHost({ home, computer: "Studio", registry: opened.registry, secrets, userHome: home });
  }, 120_000);
  afterAll(async () => {
    await ph?.close();
    opened?.close();
  });

  /** One MCP exchange on the real channel: its answer to `message`. */
  async function mcp(pluginId: string, server: string, messages: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
    const ch = await ph.host.openMcp(pluginId, server);
    const answers: Record<string, unknown>[] = [];
    const done = new Promise<void>((resolve) => {
      ch.onMessage((m) => { answers.push(m); if (answers.length === messages.length) resolve(); });
    });
    for (const m of messages) ch.send({ jsonrpc: "2.0", ...m }, USER);
    await Promise.race([done, Bun.sleep(30_000)]);
    ch.close();
    return answers;
  }

  test("each host example is listed as every example the skill gives that has a host half", () => {
    expect(examples.filter((e) => JSON.parse(e.files["clover.json"]!).host !== undefined).map((e) => e.folder)).toEqual(WITH_HOST);
  });

  test("ex-tool: its MCP server answers the list and a call", async () => {
    const [init, list, call] = await mcp("ex-tool", "tools", [
      { id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } },
      { id: 2, method: "tools/list", params: {} },
      { id: 3, method: "tools/call", params: { name: "hello", arguments: { name: "Ada" } } },
    ]);
    expect((init!.result as { serverInfo: { name: string } }).serverInfo.name).toBe("ex-tool");
    expect((list!.result as { tools: { name: string }[] }).tools.map((t) => t.name)).toEqual(["hello"]);
    expect(call!.result).toEqual({ content: [{ type: "text", text: "Hello, Ada!" }] });
  }, 60_000);

  test("ex-trigger: its handler object answers check, next and missed", async () => {
    const call = (method: string, args: unknown) => ph.host.invoke({ pluginId: "ex-trigger", handler: "exTrigger", method, args, caller: USER });
    expect(await call("check", { fields: { every: 30 } })).toEqual({ ok: true, summary: "every 30 minutes" });
    expect(await call("next", { fields: { every: 30 }, after: 0 })).toEqual({ at: 1_800_000 });
    expect(await call("missed", { fields: { every: 30 }, after: 0, until: 1 })).toEqual({ at: [] });
  }, 60_000);

  test("ex-timeline: its start reads the synced store, the page's calls and the bot's tools change one timeline, kept across a restart", async () => {
    const ui = (handler: string, args: unknown = null) => ph.host.invoke({ pluginId: "ex-timeline", handler, ui: true, args, caller: USER });
    expect(await ui("read")).toEqual({ items: [] });
    await ui("add", { title: "Intro", start: 0, length: 3 });
    const [, added] = await mcp("ex-timeline", "timeline", [
      { id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } },
      { id: 2, method: "tools/call", params: { name: "TimelineAdd", arguments: { title: "Outro", start: 9 } } },
    ]);
    expect((added!.result as { isError?: boolean }).isError).toBeUndefined();
    expect(((await ui("read")) as { items: { title: string }[] }).items.map((i) => i.title)).toEqual(["Intro", "Outro"]);
    // A pick starts its process again: the next one reads the timeline back from the synced store.
    await ph.host.restart("ex-timeline");
    expect(((await ui("read")) as { items: { title: string }[] }).items.map((i) => i.title)).toEqual(["Intro", "Outro"]);
    expect(((await ui("editList")) as { text: string }).text).toBe("0\t3\tIntro\t-\t-\n9\t5\tOutro\t-\t-\n");
    // Rendering asks the plugin API for the picks' real paths (`files.path`): this bare host serves no files area (the
    // daemon composes it), so the call is refused by name, and nothing runs.
    await expect(ui("render", { output: "grant:00000000-0000-4000-8000-000000000000" })).rejects.toThrow("no clip from a video to render");
    // (On a computer with no ffmpeg it stops one step earlier, and says so.)
    await ui("add", { title: "clip.mp4", start: 12, length: 2, source: "grant:00000000-0000-4000-8000-000000000001" });
    await expect(ui("render", { output: "grant:00000000-0000-4000-8000-000000000000" })).rejects.toThrow(Bun.which("ffmpeg") === null ? "ffmpeg isn't installed" : "files.path");
  }, 120_000);
});

// The examples' components have no plugin host to run in here (the layer is the app's), so each plugin-API call their
// code makes is held to the catalog: a component's call (`ui` or `both`), served (not marked not-yet), and one the
// example's capabilities open. Host code's calls are run for real above.
test("every plugin-API call an example's component makes is a served component call its capabilities open", () => {
  const calls = API_CALLS as Record<string, ApiCallInfo>;
  const seen: string[] = [];
  for (const ex of examples) {
    const manifest = JSON.parse(ex.files["clover.json"]!) as { capabilities?: string[]; client?: { entry: string } };
    if (manifest.client === undefined) continue;
    const code = ex.files[manifest.client.entry]!;
    for (const m of code.matchAll(/\bapi\.([a-zA-Z!.]+?)!?\(/g)) {
      const path = m[1]!.replace(/!/g, "");
      seen.push(path);
      const info = calls[path];
      expect({ ex: ex.folder, path, listed: info !== undefined }).toEqual({ ex: ex.folder, path, listed: true });
      expect({ ex: ex.folder, path, where: info!.where === "ui" || info!.where === "both" }).toEqual({ ex: ex.folder, path, where: true });
      expect({ ex: ex.folder, path, notYet: info!.notYet ?? null }).toEqual({ ex: ex.folder, path, notYet: null });
      const needs = info!.capability;
      if (needs !== undefined && !needs.includes("*")) expect({ ex: ex.folder, path, holds: (manifest.capabilities ?? []).includes(needs) }).toEqual({ ex: ex.folder, path, holds: true });
    }
  }
  expect(seen.length).toBeGreaterThan(10);
});
