// The registry's load-time build of a TypeScript client entry (client-builds.ts, client-build-run.ts): what a build
// may read and write, its bounds, the child that runs it, and when the registry asks for one. Temp homes only.
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { CLIENT_BARE_IMPORTS, PLUGIN_API_VERSION } from "@waifucave/clover-plugin-sdk";
import { PLUGIN_TEMPLATES, templateFiles } from "@waifucave/clover-plugin-sdk/templates";
import { FakeApprovalBroker } from "../../contracts/fakes/approval-broker";
import { FakeClock } from "../../contracts/fakes/clock";
import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import { pluginRegistryMethods } from "../../plugin-host/registry-methods";
import { uiPluginViews } from "../../plugin-host/ui";
import { childRunner, ClientBuilds, clientBuildsRoot, wantsClientBuild, type ClientBuildRunner } from "../client-builds";
import { runClientBuild, type ClientBuildJob } from "../client-build-run";
import { openPluginRegistry } from "../open";

const temps: string[] = [];
const temp = (prefix: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(d);
  return d;
};
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});
const write = (root: string, files: Record<string, string>) => {
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), body);
  }
};
const TSX = 'import { useState } from "react";\nimport { usePluginApi } from "@waifucave/clover-plugin-sdk/ui";\nexport function Page() { const api = usePluginApi(); const [x] = useState(0); return <p data-x={String(!!api)}>{x}</p>; }\n';
const job = (root: string, o: Partial<ClientBuildJob> = {}): ClientBuildJob => {
  const outDir = temp("clover-cb-out-");
  return { root, entry: "client/index.tsx", outDir, home: homedir(), user: userInfo().username, ...o };
};
const manifest = (id: string, o: Record<string, unknown> = {}) => JSON.stringify({ manifest: 1, id, name: id, version: "1.0.0", engines: { clover: `^${PLUGIN_API_VERSION}` }, client: { entry: "client/index.tsx" }, contributes: { ui: [{ spot: "main", key: id, component: "Page" }] }, ...o });

describe("one build: what it reads and writes (client-build-run.ts)", () => {
  test("a TSX client importing React and the UI SDK builds to one module whose only bare imports are the layer's", async () => {
    const root = temp("clover-cb-");
    write(root, { "client/index.tsx": TSX, "client/part.ts": "export const n = 1;\n" });
    const j = job(root);
    const r = await runClientBuild(j);
    if (!r.ok) throw new Error(r.message);
    expect(r.imports.every((i) => (CLIENT_BARE_IMPORTS as readonly string[]).includes(i))).toBe(true);
    expect(r.imports).toContain("react");
    const text = readFileSync(join(j.outDir, "index.js"), "utf8");
    expect(createHash("sha256").update(text).digest("hex")).toBe(r.sha256);
    expect(readdirSync(j.outDir)).toEqual(["index.js"]);
    // No path of this computer's in it, and no source map.
    expect(text.includes(root) || text.includes(homedir()) || text.includes("sourceMappingURL")).toBe(false);
  });

  test("a macro import fails the build, closed, and nothing of the plugin's runs", async () => {
    const root = temp("clover-cb-");
    const ran = join(root, "ran.txt");
    write(root, {
      "client/mac.ts": `import { writeFileSync } from "node:fs";\nexport function m() { writeFileSync(${JSON.stringify(ran)}, "x"); return 1; }\n`,
      "client/index.tsx": 'import { m } from "./mac.ts" with { type: "macro" };\nexport const v = m();\n',
    });
    const r = await runClientBuild(job(root));
    expect(r.ok).toBe(false);
    expect(existsSync(ran)).toBe(false);
  });

  test("a file from outside the plugin (a relative path, a link, a tsconfig path) fails the build; the message has no absolute path", async () => {
    const outside = temp("clover-cb-outside-");
    write(outside, { "lib.ts": "export const secret = 1;\n" });
    for (const files of [
      { "client/index.tsx": `import { secret } from "${join(outside, "lib.ts")}";\nexport const v = secret;\n` },
      { "client/index.tsx": 'import { secret } from "./lib.ts";\nexport const v = secret;\n', link: "" },
      { "client/index.tsx": 'import { secret } from "@x/lib";\nexport const v = secret;\n', "tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@x/*": [`${outside}/*`] } } }) },
    ] as Record<string, string>[]) {
      const root = temp("clover-cb-");
      const { link, ...rest } = files;
      write(root, rest);
      if (link !== undefined) symlinkSync(join(outside, "lib.ts"), join(root, "client", "lib.ts"));
      const r = await runClientBuild(job(root));
      expect([files["client/index.tsx"], r.ok]).toEqual([files["client/index.tsx"], false]);
      if (!r.ok) expect([r.message, r.message.includes(root) || r.message.includes(outside)]).toEqual([r.message, false]);
    }
  });

  test("a bare import the layer's map doesn't serve fails with the builder's message; a stylesheet import fails too", async () => {
    const root = temp("clover-cb-");
    write(root, { "client/index.tsx": 'import x from "lodash";\nexport const v = x;\n', "node_modules/lodash/package.json": JSON.stringify({ name: "lodash", main: "index.js" }), "node_modules/lodash/index.js": "module.exports = 1;\n" });
    // lodash is bundled in (the plugin ships it): that is allowed.
    expect((await runClientBuild(job(root))).ok).toBe(true);
    const css = temp("clover-cb-");
    write(css, { "client/index.tsx": 'import "./a.css";\nexport const v = 1;\n', "client/a.css": "p { color: red }\n" });
    const r = await runClientBuild(job(css));
    expect(r.ok ? "" : r.message).toContain("imports code only");
    const missing = temp("clover-cb-");
    write(missing, { "client/index.tsx": 'import x from "left-pad";\nexport const v = x;\n' });
    expect((await runClientBuild(job(missing))).ok).toBe(false);
  });

  test("the bounds: the files read, their bytes, the module's bytes; an entry outside the folder", async () => {
    const root = temp("clover-cb-");
    write(root, { "client/index.tsx": 'import { n } from "./part";\nexport const v = n;\n', "client/part.ts": `export const n = ${JSON.stringify("x".repeat(5000))};\n` });
    expect(await runClientBuild(job(root, { maxInputs: 1 }))).toMatchObject({ ok: false, message: expect.stringContaining("reads at most 1") });
    expect(await runClientBuild(job(root, { maxInputBytes: 100 }))).toMatchObject({ ok: false, message: expect.stringContaining("reads at most 100") });
    expect(await runClientBuild(job(root, { maxOutputBytes: 100 }))).toMatchObject({ ok: false, message: expect.stringContaining("at most 100") });
    expect(await runClientBuild(job(root, { entry: "../x.tsx" }))).toMatchObject({ ok: false, message: expect.stringContaining("isn't a path inside the plugin") });
  });
});

describe("the child that runs it (childRunner)", () => {
  test("builds in a child of its own (fenced on macOS); killed past its time or its memory, or when the plugin changes", async () => {
    const home = temp("clover-cb-home-");
    const root = temp("clover-cb-");
    write(root, { "client/index.tsx": TSX });
    const ok = await childRunner({ cloverHome: home, bun: process.execPath })(job(root), new AbortController().signal);
    if (!ok.ok) throw new Error(ok.message);
    expect(ok.imports).toContain("react");
    const slow = await childRunner({ cloverHome: home, bun: process.execPath, timeoutMs: 1 })(job(root), new AbortController().signal);
    expect(slow).toMatchObject({ ok: false, message: expect.stringContaining("took longer than") });
    const heavy = temp("clover-cb-");
    write(heavy, { "client/index.tsx": `${TSX}export const blob = ${JSON.stringify("y".repeat(8 * 1024 * 1024))};\n` });
    const big = await childRunner({ cloverHome: home, bun: process.execPath, maxRssBytes: 1024, watchEveryMs: 5 })(job(heavy), new AbortController().signal);
    expect(big).toMatchObject({ ok: false, message: expect.stringContaining("more than") });
    const abort = new AbortController();
    const stopped = childRunner({ cloverHome: home, bun: process.execPath })(job(root), abort.signal);
    abort.abort();
    expect(await stopped).toMatchObject({ ok: false, message: expect.stringContaining("stopped") });
  }, 60_000);
});

describe("when the registry builds (ClientBuilds over a real registry)", () => {
  const open = async () => {
    const home = temp("clover-cb-reg-");
    const broker = new FakeApprovalBroker({ clock: new FakeClock() });
    const opened = await openPluginRegistry({ cloverHome: home, os: "macos", broker, secrets: new MemorySecretStore(), settleMs: 50 });
    const m = pluginRegistryMethods({ opened, host: { restart: async () => {} }, home });
    const runs: string[] = [];
    const real = childRunner({ cloverHome: home, bun: process.execPath });
    const run: ClientBuildRunner = (j, s) => {
      runs.push(j.root);
      return real(j, s);
    };
    const builds = new ClientBuilds({ cloverHome: home, registry: opened.registry, run });
    const install = async (id: string, files: Record<string, string>) => {
      const src = join(temp("clover-cb-src-"), id);
      write(src, files);
      return (await m["plugin.install"]!({ source: { from: "folder", path: src } }, { caller: { kind: "user", client: "app" } } as never)) as { id: string; treeHash: string };
    };
    return { home, opened, builds, runs, install, close: () => { builds.close(); opened.close(); } };
  };

  test("nothing for a found plugin; built once its OK lands, and the view names the module by its hash", async () => {
    const t = await open();
    try {
      const r = await t.install("tarot", { "clover.json": manifest("tarot"), "client/index.tsx": TSX });
      await t.builds.settled();
      expect(t.runs).toEqual([]);
      expect(uiPluginViews(t.opened.registry, t.builds).find((v) => v.pluginId === "tarot")).toBeUndefined();
      await t.opened.registry.approve("tarot", r.treeHash);
      expect(wantsClientBuild(t.opened.registry.get("tarot")!)).toBe(true);
      await t.builds.settled();
      expect(t.runs.length).toBe(1);
      const view = uiPluginViews(t.opened.registry, t.builds).find((v) => v.pluginId === "tarot")!;
      expect(view.clientEntry).toBeUndefined();
      const b = view.clientBuild!;
      expect(b.file).toBe("index.js");
      expect(b.base.startsWith(join(clientBuildsRoot(t.home), "tarot"))).toBe(true);
      expect(createHash("sha256").update(readFileSync(join(b.base, b.file))).digest("hex")).toBe(b.sha256);
      // Off: its build goes.
      await t.opened.registry.setEnabled("tarot", false);
      await t.builds.settled();
      expect(t.builds.get("tarot", r.treeHash)).toBeUndefined();
      expect(existsSync(b.base)).toBe(false);
    } finally {
      t.close();
    }
  }, 60_000);

  test("a build that fails leaves the plugin invalid with the reason, for that tree only; a folder read again doesn't retry it", async () => {
    const t = await open();
    try {
      const r = await t.install("luna", { "clover.json": manifest("luna"), "client/index.tsx": 'import { m } from "./mac.ts" with { type: "macro" };\nexport const Page = () => m();\n', "client/mac.ts": "export const m = () => 1;\n" });
      await t.opened.registry.approve("luna", r.treeHash);
      await t.builds.settled();
      const rec = t.opened.registry.get("luna")!;
      expect(rec.state).toBe("invalid");
      expect(rec.reason).toContain("its client didn't build");
      expect(rec.reason!.includes(t.home) || rec.reason!.includes(homedir())).toBe(false);
      // The same tree read again: still invalid, not built again.
      await t.opened.folders.refresh(join(t.home, "plugins", "luna"));
      await t.builds.settled();
      expect([t.opened.registry.get("luna")!.state, t.runs.length]).toEqual(["invalid", 1]);
    } finally {
      t.close();
    }
  }, 60_000);

  test("a development folder rebuilds with each new tree; the older tree's build goes", async () => {
    const t = await open();
    try {
      const folder = temp("clover-cb-dev-");
      write(folder, { "clover.json": manifest("devp"), "client/index.tsx": TSX });
      const m = JSON.parse(manifest("devp"));
      t.opened.registry.put({ id: "devp", manifest: m, approved: true, dev: true, folder, treeHash: `sha256:${"a".repeat(64)}` });
      await t.builds.settled();
      const first = t.builds.get("devp", `sha256:${"a".repeat(64)}`)!;
      expect(first.file).toBe("index.js");
      write(folder, { "client/index.tsx": TSX.replace("{x}", "{x + 1}") });
      t.opened.registry.put({ id: "devp", manifest: m, approved: true, dev: true, folder, treeHash: `sha256:${"b".repeat(64)}` });
      await t.builds.settled();
      const second = t.builds.get("devp", `sha256:${"b".repeat(64)}`)!;
      expect(second.sha256).not.toBe(first.sha256);
      expect(t.builds.get("devp", `sha256:${"a".repeat(64)}`)).toBeUndefined();
      expect(existsSync(first.base)).toBe(false);
      expect(t.runs.length).toBe(2);
    } finally {
      t.close();
    }
  }, 60_000);

  test("what an earlier run left in the cache is never trusted: it goes when the builds start", async () => {
    const home = temp("clover-cb-left-");
    write(clientBuildsRoot(home), { "tarot/abc-v1/index.js": "export const evil = 1;\n" });
    const opened = await openPluginRegistry({ cloverHome: home, os: "macos", broker: new FakeApprovalBroker({ clock: new FakeClock() }), secrets: new MemorySecretStore(), settleMs: 50 });
    const builds = new ClientBuilds({ cloverHome: home, registry: opened.registry, run: async () => ({ ok: false, message: "unused" }) });
    try {
      expect(existsSync(clientBuildsRoot(home))).toBe(false);
    } finally {
      builds.close();
      opened.close();
    }
  });

  test("the SDK's ui and point templates, generated, installed and OK'd, get their clients built (their parts can mount)", async () => {
    const t = await open();
    try {
      for (const template of ["ui", "point"]) {
        expect(Object.keys(PLUGIN_TEMPLATES)).toContain(template);
        const id = `my-${template}`;
        const made = templateFiles(template, { id, name: `My ${template}` });
        if ("error" in made) throw new Error(made.error);
        const r = await t.install(id, made.files);
        await t.opened.registry.approve(id, r.treeHash);
        await t.builds.settled();
        expect([template, t.builds.get(id, r.treeHash)?.file]).toEqual([template, "index.js"]);
        expect([template, uiPluginViews(t.opened.registry, t.builds).find((v) => v.pluginId === id)?.clientBuild !== undefined]).toEqual([template, true]);
      }
    } finally {
      t.close();
    }
  }, 60_000);
});
