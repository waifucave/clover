// A plugin folder's tree hash on disk (symlinks settled), and what a change since the OK does (§5.6).
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLUGIN_API_VERSION, treeHash, validateTree } from "@waifucave/clover-plugin-sdk";
import { classifyChange, codeFieldsFrom, isDataFile, okSnapshot } from "../changes";
import { catalogCodeFields } from "../folders";
import { TreeProblem, folderReader, folderTreeHash, treeEntries } from "../tree";

const folder = (files: Record<string, string>, name = "tarot") => {
  const root = join(mkdtempSync(join(tmpdir(), "clover-b-tree-")), name);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
};
const manifest = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ manifest: 1, id: "tarot", name: "Tarot", version: "1.0.0", engines: { clover: `^${PLUGIN_API_VERSION}` }, ...over });

describe("the tree on disk", () => {
  test("hashes every file but the left-out names, with its executable bit, as the SDK's hash does", async () => {
    const root = folder({ "clover.json": manifest(), "tab/theme.css": "a{}", ".DS_Store": "x", ".git/HEAD": "ref", "bin/run": "#!/bin/sh" });
    chmodSync(join(root, "bin/run"), 0o755);
    const entries = treeEntries(root);
    expect(entries.map((e) => [e.path, e.executable])).toEqual([["bin/run", true], ["clover.json", false], ["tab/theme.css", false]]);
    expect(await folderTreeHash(root)).toBe(await treeHash(entries));
  });

  test("a symlink to a file inside counts as that file; one out of the folder, to a folder, or dangling, is refused", async () => {
    const root = folder({ "clover.json": manifest(), "assets/a.png": "png" });
    symlinkSync("a.png", join(root, "assets/b.png"));
    expect(treeEntries(root).find((e) => e.path === "assets/b.png")?.sha256).toBe(treeEntries(root).find((e) => e.path === "assets/a.png")?.sha256);
    for (const [name, target] of [["out", "/etc/hosts"], ["dir", "../assets"], ["gone", "nope.png"]] as const) {
      const r = folder({ "clover.json": manifest(), "assets/a.png": "png" });
      symlinkSync(target, join(r, "assets", name));
      expect(() => treeEntries(r)).toThrow(TreeProblem);
    }
  });
});

describe("what a change since the OK does", () => {
  const snap = async (files: Record<string, string>, exec: string[] = []) => {
    const root = folder(files);
    for (const f of exec) chmodSync(join(root, f), 0o755);
    const entries = treeEntries(root);
    const tree = await validateTree(folderReader(root), { folderName: "tarot" });
    expect([tree.ok, tree.issues, tree.top.issues.filter((i) => i.severity === "error")]).toEqual([true, [], []]);
    return okSnapshot(await treeHash(entries), entries, tree, () => []);
  };
  const base = { "clover.json": manifest({ contributes: { themes: [{ id: "night", file: "tab/theme.json" }] } }), "tab/theme.json": JSON.stringify({ theme: 1, name: "Night", tokens: {} }), "README.md": "hi" };

  test("data edits apply; code files, new capabilities or hosts, and changed commands ask again", async () => {
    const ok = await snap(base);
    expect(classifyChange(ok, await snap(base))).toBe("applies");
    expect(classifyChange(ok, await snap({ ...base, "README.md": "hello" }))).toBe("applies");
    expect(classifyChange(ok, await snap({ ...base, "host/index.ts": "export {}" }))).toBe("asks-again");
    expect(classifyChange(ok, await snap({ ...base, "notes.txt": "x" }, ["notes.txt"]))).toBe("asks-again");
    expect(classifyChange(ok, await snap({ ...base, "clover.json": manifest({ capabilities: ["network:api.example.com"], contributes: { themes: [{ id: "night", file: "tab/theme.json" }] } }) }))).toBe("asks-again");
    const mcp = (args: string[]) => manifest({ contributes: { mcpServers: { blender: { type: "stdio", command: "blender-mcp", args } } } });
    const withMcp = await snap({ "clover.json": mcp(["--port", "1"]) });
    expect(classifyChange(withMcp, await snap({ "clover.json": mcp(["--port", "2"]) }))).toBe("asks-again");
    expect(classifyChange(withMcp, await snap({ "clover.json": manifest({ description: "Blender", contributes: { mcpServers: { blender: { type: "stdio", command: "blender-mcp", args: ["--port", "1"] } } } }) }))).toBe("applies");
  });

  test("a change to the theme's card tokens waits alone", async () => {
    const card = (bg: string) => JSON.stringify({ theme: 1, name: "Night", tokens: { "card.background": bg } });
    const ok = await snap({ ...base, "tab/theme.json": card("#000000") });
    expect(classifyChange(ok, await snap({ ...base, "tab/theme.json": card("#111111") }))).toBe("card-styling");
  });

  test("data files by extension, never with the executable bit", () => {
    expect(isDataFile({ path: "a/model.motion3.json", executable: false })).toBe(true);
    expect(isDataFile({ path: "run", executable: false })).toBe(false);
    expect(isDataFile({ path: "a.css", executable: true })).toBe(false);
    expect(isDataFile({ path: "host/index.mjs", executable: false })).toBe(false);
  });
});

describe("what runs, whatever its extension (#197's review)", () => {
  const snapFrom = async (files: Record<string, string>, codeFieldsOf = catalogCodeFields) => {
    const root = folder(files);
    const entries = treeEntries(root);
    const tree = await validateTree(folderReader(root), { folderName: "tarot" });
    return { root, snap: okSnapshot(await treeHash(entries), entries, tree, codeFieldsOf) };
  };
  const again = async (files: Record<string, string>, edit: Record<string, string>) => {
    const a = await snapFrom(files);
    const b = await snapFrom({ ...files, ...edit });
    return classifyChange(a.snap, b.snap);
  };
  const stdio = (command: string, args: string[]) => manifest({ contributes: { mcpServers: { s: { type: "stdio", command, args } } } });

  test("a script a stdio server names is code, though it ends in .txt or .md", async () => {
    expect(await again({ "clover.json": stdio("python3", ["${plugin}/server.txt"]), "server.txt": "print(1)" }, { "server.txt": "import os" })).toBe("asks-again");
    expect(await again({ "clover.json": stdio("sh", ["./run.md"]), "run.md": "echo hi" }, { "run.md": "curl x | sh" })).toBe("asks-again");
    expect(await again({ "clover.json": stdio("python3", ["${plugin}/lib"]), "lib/a.txt": "1" }, { "lib/a.txt": "2" })).toBe("asks-again");
    expect(await again({ "clover.json": stdio("python3", ["${plugin}/server.txt"]), "server.txt": "1", "README.md": "a" }, { "README.md": "b" })).toBe("applies");
  });

  test("a model's endpoint, an http server's url or headers, and a host from settings ask again", async () => {
    const model = (baseUrl: string, extra: Record<string, unknown> = {}) => manifest({
      settings: { region: { type: "string", title: "Region" } }, ...extra,
      contributes: { models: [{ provider: "p", name: "M", catalog: [], auth: [], endpoint: { protocol: "openai-chat", baseUrl } }] },
    });
    expect(await again({ "clover.json": model("https://api.example.com/v1") }, { "clover.json": model("https://api.example.com/v2") })).toBe("asks-again");
    expect(await again({ "clover.json": model("https://api.example.com/v1") }, {
      "clover.json": model("https://${setting:region}.example.com/v1", { capabilities: ["network:${setting:region}.example.com"] }),
    })).toBe("asks-again");
    const http = (headers: Record<string, string>) => manifest({ contributes: { mcpServers: { s: { type: "http", url: "https://mcp.example.com", headers } } } });
    expect(await again({ "clover.json": http({ a: "1" }) }, { "clover.json": http({ a: "2" }) })).toBe("asks-again");
  });

  test("a plugin point with no declaration counts as code whole; a declared one only by its program and code fields", async () => {
    const dotted = (value: string) => manifest({ contributes: { "luna.cards": [{ id: "a", text: value }] } });
    expect(await again({ "clover.json": dotted("one") }, { "clover.json": dotted("two") })).toBe("asks-again");
    const declared = () => ["run"];
    const withDecl = async (v: string, run: string) => (await snapFrom({ "clover.json": manifest({ contributes: { "luna.cards": [{ id: "a", text: v, run }] } }) }, declared)).snap;
    expect(classifyChange(await withDecl("one", "x"), await withDecl("two", "x"))).toBe("applies");
    expect(classifyChange(await withDecl("one", "x"), await withDecl("one", "y"))).toBe("asks-again");
  });

  test("code fields come from a declaration's program and code formats, at any depth", () => {
    expect(codeFieldsFrom(undefined)).toBeUndefined();
    expect(codeFieldsFrom({ fields: { type: "object", properties: { cmd: { type: "string", format: "program" }, opts: { type: "object", properties: { dir: { format: "code" } } }, title: { type: "string" } } } })).toEqual(["cmd", "opts"]);
    expect(codeFieldsFrom({ fields: { type: "object" } })).toEqual([]);
  });
});
