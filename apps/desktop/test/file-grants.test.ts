// The files a user hands a plugin's page: the pickers' doors (`routePick`) and the media route (`grantResponse`).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileGrants, grantMediaType, parseRange, routePick, type DialogRequest, type Grant, type PickRoute } from "../src/main/ui/file-grants";
import { layerCsp, layerHeaders } from "../src/main/ui/documents";

let dir: string;
let video: string;
beforeAll(() => {
  dir = realTmp();
  video = join(dir, "clip.mp4");
  writeFileSync(video, Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256)));
  mkdirSync(join(dir, "folder"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function realTmp(): string {
  return require("node:fs").realpathSync(mkdtempSync(join(tmpdir(), "clover-grants-")));
}

function route(over: Partial<PickRoute> & { paths?: string[] }): { r: PickRoute; seen: DialogRequest[]; registered: Grant[]; grants: FileGrants } {
  const seen: DialogRequest[] = [];
  const registered: Grant[] = [];
  const grants = over.grants ?? new FileGrants();
  const r: PickRoute = {
    method: "files.pickOpen",
    params: {},
    plugin: { id: "editor", capabilities: new Set(["files"]) },
    windowId: 1,
    takeGesture: () => true,
    dialog: async (_w, request) => { seen.push(request); return over.paths ?? []; },
    grants,
    register: async (g) => { registered.push(g); return "ok"; },
    log: () => {},
    refuse: (why) => new Error(why),
    ...over,
  };
  return { r, seen, registered, grants };
}

describe("the pickers' door", () => {
  test("a plugin without the files capability is refused, and no dialog opens", async () => {
    const t = route({ plugin: { id: "editor", capabilities: new Set(["net:example.com"]) }, paths: [video] });
    await expect(routePick(t.r)).rejects.toThrow(/files capability/);
    expect(t.seen).toEqual([]);
  });

  test("no key press or click just before: refused, no dialog", async () => {
    const t = route({ takeGesture: () => false, paths: [video] });
    await expect(routePick(t.r)).rejects.toThrow(/key press or click/);
    expect(t.seen).toEqual([]);
  });

  test("only the three pick methods", async () => {
    await expect(routePick(route({ method: "files.readBytes" }).r)).rejects.toThrow();
  });

  test("an open pick returns a token, the name and the size, never the path", async () => {
    const t = route({ paths: [video], params: { filters: [{ name: "Video", extensions: ["mp4", "../x", "w ebm"] }, { name: "", extensions: ["a"] }] } });
    const out = await routePick(t.r);
    expect(out).toMatchObject({ grants: [{ name: "clip.mp4", kind: "file", access: "read", size: 1000 }] });
    const text = JSON.stringify(out);
    expect(text).not.toContain(dir);
    expect(text).toMatch(/grant:[0-9a-f-]{36}/);
    expect(t.seen[0]).toMatchObject({ kind: "open", multiple: false, filters: [{ name: "Video", extensions: ["mp4"] }] });
    expect(t.registered).toHaveLength(1);
    expect(t.registered[0]).toMatchObject({ pluginId: "editor", path: video, kind: "file", access: "read" });
  });

  test("one path unless several were asked for", async () => {
    const other = join(dir, "b.mp4");
    writeFileSync(other, "x");
    const one = route({ paths: [video, other] });
    expect(((await routePick(one.r)) as { grants: unknown[] }).grants).toHaveLength(1);
    const many = route({ paths: [video, other], params: { multiple: true } });
    expect(((await routePick(many.r)) as { grants: unknown[] }).grants).toHaveLength(2);
  });

  test("a cancelled dialog is no grant", async () => {
    const t = route({ paths: [] });
    expect(await routePick(t.r)).toEqual({ cancelled: true });
    expect(t.registered).toEqual([]);
  });

  test("a folder for writing is read and write; one for reading is read", async () => {
    const w = route({ method: "files.pickFolder", params: { forWriting: true }, paths: [join(dir, "folder")] });
    expect(await routePick(w.r)).toMatchObject({ grants: [{ kind: "folder", access: "readwrite" }] });
    expect(w.registered[0]).toMatchObject({ kind: "folder", access: "write" });
    const rd = route({ method: "files.pickFolder", paths: [join(dir, "folder")] });
    expect(await routePick(rd.r)).toMatchObject({ grants: [{ kind: "folder", access: "read" }] });
    // A file is not a folder.
    await expect(routePick(route({ method: "files.pickFolder", paths: [video] }).r)).rejects.toThrow();
  });

  test("a save grant is the one file, which may not exist yet; a suggested name is a plain name", async () => {
    const target = join(dir, "export.mp4");
    const t = route({ method: "files.pickSave", params: { suggestedName: "out.mp4" }, paths: [target] });
    expect(await routePick(t.r)).toMatchObject({ grants: [{ name: "export.mp4", kind: "file", access: "write" }] });
    expect(t.seen[0]).toMatchObject({ kind: "save", suggestedName: "out.mp4" });
    const bad = route({ method: "files.pickSave", params: { suggestedName: "../../etc/passwd" }, paths: [target] });
    await routePick(bad.r);
    expect(bad.seen[0]!.suggestedName).toBeUndefined();
  });

  test("a save target whose folder is a link is judged by its real folder", async () => {
    const real = join(dir, "real");
    mkdirSync(real);
    symlinkSync(real, join(dir, "link"));
    const t = route({ method: "files.pickSave", paths: [join(dir, "link", "new.mp4")] });
    await routePick(t.r);
    expect(t.registered[0]!.path).toBe(join(real, "new.mp4"));
  });

  test("the core's refusal reaches the page as its reason and leaves no token behind", async () => {
    const grants = new FileGrants();
    const t = route({ grants, paths: [video], register: async () => { throw new Error("That folder holds Clover's own home."); } });
    await expect(routePick(t.r)).rejects.toThrow(/Clover's own home/);
    expect(t.registered).toEqual([]);
    const probe = grants.issue("editor", { path: video, kind: "file", access: "read" });
    expect(grants.get("editor", probe.token)).toBeDefined();
  });

  test("a core without grants still gives the token (said once in the log)", async () => {
    const lines: string[] = [];
    const t = route({ paths: [video], register: async () => "unserved", log: (l) => lines.push(l) });
    expect(await routePick(t.r)).toMatchObject({ grants: [{ name: "clip.mp4" }] });
    expect(lines.join("\n")).toContain("keeps no grants yet");
  });
});

describe("tokens belong to one plugin", () => {
  test("another plugin's token is nothing", () => {
    const grants = new FileGrants();
    const g = grants.issue("editor", { path: video, kind: "file", access: "read" });
    expect(grants.get("editor", g.token)).toBeDefined();
    expect(grants.get("other", g.token)).toBeUndefined();
    expect(grants.byId("other", g.token.slice("grant:".length))).toBeUndefined();
    expect(grants.forget("other", g.token)).toBe(false);
    expect(grants.forget("editor", g.token)).toBe(true);
    expect(grants.get("editor", g.token)).toBeUndefined();
  });

  test("main holds a bounded number per plugin, the oldest going first", () => {
    const grants = new FileGrants();
    const first = grants.issue("editor", { path: video, kind: "file", access: "read" });
    for (let i = 0; i < 300; i++) grants.issue("editor", { path: video, kind: "file", access: "read" });
    expect(grants.get("editor", first.token)).toBeUndefined();
  });
});

describe("the media route", () => {
  const H = { "X-Test": "1" };
  const id = (g: Grant): string => g.token.slice("grant:".length);
  const serve = async (grants: FileGrants, who: string, g: Grant, range: string | null): Promise<Response> => import("../src/main/ui/file-grants").then((m) => m.grantResponse(grants, who, id(g), range, H));

  test("the whole file, with its type, and ranges inside the grant", async () => {
    const { grants } = route({});
    const g = grants.issue("editor", { path: video, kind: "file", access: "read" });
    const all = await serve(grants, "editor", g, null);
    expect(all.status).toBe(200);
    expect(all.headers.get("Content-Type")).toBe("video/mp4");
    expect(all.headers.get("Accept-Ranges")).toBe("bytes");
    expect((await all.arrayBuffer()).byteLength).toBe(1000);
    const part = await serve(grants, "editor", g, "bytes=10-19");
    expect(part.status).toBe(206);
    expect(part.headers.get("Content-Range")).toBe("bytes 10-19/1000");
    expect([...new Uint8Array(await part.arrayBuffer())]).toEqual(Array.from({ length: 10 }, (_, i) => (i + 10) % 256));
    const open = await serve(grants, "editor", g, "bytes=990-");
    expect(open.headers.get("Content-Range")).toBe("bytes 990-999/1000");
    const tail = await serve(grants, "editor", g, "bytes=-5");
    expect(tail.headers.get("Content-Range")).toBe("bytes 995-999/1000");
    const clamped = await serve(grants, "editor", g, "bytes=990-5000");
    expect(clamped.headers.get("Content-Range")).toBe("bytes 990-999/1000");
  });

  test("a range outside the file is refused with 416", async () => {
    const { grants } = route({});
    const g = grants.issue("editor", { path: video, kind: "file", access: "read" });
    for (const range of ["bytes=1000-", "bytes=2000-3000", "bytes=5-1", "bytes=-0", "bytes=0-1,5-6", "items=0-1", "bytes=-"]) {
      const r = await serve(grants, "editor", g, range);
      expect(r.status, range).toBe(416);
      expect(r.headers.get("Content-Range"), range).toBe("bytes */1000");
    }
  });

  test("another plugin's token, a folder and an unknown id are refused", async () => {
    const { grants } = route({});
    const g = grants.issue("editor", { path: video, kind: "file", access: "read" });
    expect((await serve(grants, "other", g, null)).status).toBe(403);
    const folder = grants.issue("editor", { path: join(dir, "folder"), kind: "folder", access: "read" });
    expect((await serve(grants, "editor", folder, null)).status).toBe(403);
    const { grantResponse } = await import("../src/main/ui/file-grants");
    expect(grantResponse(grants, "editor", "../../etc/passwd", null, H).status).toBe(403);
    expect(grantResponse(grants, "editor", "00000000-0000-4000-8000-000000000000", null, H).status).toBe(403);
  });

  test("a link swapped in for the picked file is refused", async () => {
    const { grants } = route({});
    const file = join(dir, "swap.mp4");
    writeFileSync(file, "a-real-file");
    const g = grants.issue("editor", { path: file, kind: "file", access: "read" });
    rmSync(file);
    symlinkSync(video, file);
    expect((await serve(grants, "editor", g, null)).status).toBe(403);
  });

  test("a file removed after the pick is not found", async () => {
    const { grants } = route({});
    const file = join(dir, "gone.mp4");
    writeFileSync(file, "x");
    const g = grants.issue("editor", { path: file, kind: "file", access: "read" });
    rmSync(file);
    expect((await serve(grants, "editor", g, null)).status).toBe(404);
  });

  test("types: media by extension, anything else opaque, never a document", () => {
    expect(grantMediaType("a.webm")).toBe("video/webm");
    expect(grantMediaType("a.MP3")).toBe("audio/mpeg");
    for (const n of ["a.html", "a.svg", "a.js", "a.wasm", "a"]) expect(grantMediaType(n)).toBe("application/octet-stream");
  });

  test("range parsing", () => {
    expect(parseRange(null, 10)).toBe("whole");
    expect(parseRange("bytes=0-0", 10)).toEqual({ start: 0, end: 0 });
    expect(parseRange("bytes=0-", 0)).toBe("unsatisfiable");
  });
});

describe("the layer's content security policy", () => {
  test("WebAssembly compiles only where it is asked for, and eval never", () => {
    expect(layerCsp()).not.toContain("wasm-unsafe-eval");
    expect(layerCsp([], true)).toContain("script-src 'self' 'sha256-");
    expect(layerCsp([], true)).toContain("'wasm-unsafe-eval'");
    expect(layerCsp([], true)).not.toContain("'unsafe-eval'");
    expect(layerCsp([], true)).toContain("media-src 'self' blob:");
    expect(layerCsp([], true)).toContain("worker-src 'self' blob:");
    expect(layerHeaders("text/html; charset=utf-8", [], [], true)["Content-Security-Policy"]).toContain("'wasm-unsafe-eval'");
    expect(layerHeaders("text/html; charset=utf-8")["Content-Security-Policy"]).not.toContain("wasm-unsafe-eval");
  });
});

describe("a test's answer file", () => {
  test("a line answers its own kind; a bare path answers any", async () => {
    const { answersFor } = await import("../src/main/ui/file-grants");
    const text = "open=/a/b.webm\nsave=/c/d.bin\n/any/e\n\nfolder=\n";
    expect(answersFor(text, "open")).toEqual(["/a/b.webm", "/any/e"]);
    expect(answersFor(text, "save")).toEqual(["/c/d.bin", "/any/e"]);
    expect(answersFor(text, "folder")).toEqual(["/any/e"]);
  });
});
