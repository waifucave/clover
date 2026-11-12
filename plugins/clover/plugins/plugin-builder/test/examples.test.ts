// Every example in skills/plugin-examples/SKILL.md, built the way a bot would: the template ones equal the scaffold's
// files exactly, each folder passes Clover's own validator (`clover plugin validate`'s), and all of them load through
// the plugin registry in a temp home, OK'd, with none failed and the widget plugin filling the board's spot.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { templateFiles } from "@waifucave/clover-plugin-sdk/templates";
import { FakeApprovalBroker } from "../../../../../packages/core/src/contracts/fakes/approval-broker";
import { FakeClock } from "../../../../../packages/core/src/contracts/fakes/clock";
import { MemorySecretStore } from "../../../../../packages/core/src/contracts/fakes/secret-store";
import { openPluginRegistry, type OpenedRegistry } from "../../../../../packages/core/src/registry/open";
import { buildPluginModule } from "../../../../../packages/core/src/registry/build";
import { validatePluginFolder } from "../../../../../packages/core/src/registry/validate";
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
    "ex-status", "ex-app", "ex-board", "ex-board-widget", "ex-buddy",
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
    for (const id of ["ex-tool", "ex-bot", "ex-buddy", "ex-model", "ex-theme", "ex-trigger"]) expect({ id, state: opened.registry.get(id)!.state }).toEqual({ id, state: "running" });
  });
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
