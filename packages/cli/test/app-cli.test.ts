// `clover-core app screenshot` / `app frames` (app-cli.ts): its words, one request per window (`all` lists first), one
// PNG per window drawn, and the JSON it prints (a window that wasn't drawn has no file and says "not drawn").
import { describe, expect, test } from "bun:test";
import { parseAppArgs, runApp } from "../src/app-cli";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const main = { name: "main", bounds: { x: 0, y: 25, width: 1280, height: 820 }, scale: 2, visible: true, drawn: true, png: PNG.toString("base64"), pixels: { width: 2560, height: 1640 }, views: [] };
const island = { name: "island", bounds: { x: 600, y: 0, width: 214, height: 46 }, scale: 2, visible: false, drawn: false, note: "hidden: not drawn", views: [] };

function harness() {
  const asked: unknown[] = [];
  const written: Record<string, Buffer> = {};
  const made: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const deps = {
    request: async (_m: string, p: { window?: string; image?: boolean; frames?: boolean; target?: string }) => {
      asked.push(p);
      if (p.window === "all") return { windows: [{ ...main, png: undefined }, island] };
      if (p.window === "nope") throw new Error("no window named nope (there are: main, island)");
      const w = p.window === "main" ? main : island;
      return { windows: [{ ...w, ...(p.image === false ? { png: undefined } : {}), ...(p.frames ? { frames: [{ origin: "clover-core://app", width: 1280, height: 820, visibility: "visible" }] } : {}) }] };
    },
    writeFile: (path: string, bytes: Uint8Array) => { written[path] = Buffer.from(bytes); },
    mkdir: (path: string) => { made.push(path); },
    log: (l: string) => out.push(l),
    error: (l: string) => err.push(l),
  };
  return { deps, asked, written, made, out, err };
}

describe("clover-core app", () => {
  test("its words: screenshot needs --out, frames takes none, a bad window name or a stray word is refused", () => {
    expect(parseAppArgs(["screenshot", "--out", "/tmp/shots"])).toEqual({ sub: "screenshot", window: "main", out: "/tmp/shots", frames: false });
    expect(parseAppArgs(["screenshot", "--window", "all", "--out", "d", "--frames"])).toEqual({ sub: "screenshot", window: "all", out: "d", frames: true });
    expect(parseAppArgs(["frames", "--window", "pill"])).toEqual({ sub: "frames", window: "pill", frames: true });
    for (const bad of [["screenshot"], ["frames", "--out", "d"], ["screenshot", "--out"], ["screenshot", "--window", "a b", "--out", "d"], ["screenshot", "--out", "d", "--loud"], ["shoot"], []]) {
      expect(typeof parseAppArgs(bad)).toBe("string");
    }
  });

  test("screenshot --window all: the list, then each window; one PNG per window drawn; JSON with the files", async () => {
    const h = harness();
    expect(await runApp(["screenshot", "--window", "all", "--out", "/tmp/shots"], h.deps)).toBe(0);
    expect(h.asked).toEqual([{ window: "all" }, { window: "main" }, { window: "island" }]);
    expect(h.made).toEqual(["/tmp/shots"]);
    expect(Object.keys(h.written)).toEqual(["/tmp/shots/main.png"]);
    expect(h.written["/tmp/shots/main.png"]).toEqual(PNG);
    expect(JSON.parse(h.out.join("\n"))).toEqual({ windows: [
      { name: "main", bounds: main.bounds, scale: 2, visible: true, drawn: true, file: "/tmp/shots/main.png", pixels: main.pixels, views: [] },
      { name: "island", bounds: island.bounds, scale: 2, visible: false, drawn: false, note: "hidden: not drawn", views: [] },
    ] });
  });

  test("frames: no pictures asked, no file written, each window's frame list", async () => {
    const h = harness();
    expect(await runApp(["frames"], h.deps)).toBe(0);
    expect(h.asked).toEqual([{ window: "main", image: false, frames: true }]);
    expect(h.written).toEqual({});
    expect(JSON.parse(h.out.join("\n")).windows[0].frames).toEqual([{ origin: "clover-core://app", width: 1280, height: 820, visibility: "visible" }]);
  });

  test("the app's refusal is said, with exit 1; bad words, exit 2", async () => {
    const h = harness();
    expect(await runApp(["screenshot", "--window", "nope", "--out", "/tmp/shots"], h.deps)).toBe(1);
    expect(h.err).toEqual(["app screenshot: no window named nope (there are: main, island)"]);
    expect(await runApp(["screenshot"], h.deps)).toBe(2);
  });
});

describe("clover-core app open / where", () => {
  const answer = (target?: string, shown = true) => ({ ...(target ? { target } : {}), shown, ...(shown ? {} : { reason: "nope isn't a place in the app (targets: …)" }), drawn: true, where: { tab: { kind: "settings" }, side: "bots" }, frames: [{ origin: "clover-core://app", width: 1280, height: 820, visibility: "visible" }] });
  function nav() {
    const asked: unknown[] = [];
    const out: string[] = [];
    const err: string[] = [];
    return { asked, out, err, deps: {
      request: async (m: string, p: { target?: string }) => { asked.push([m, p]); return answer(p.target, p.target !== "nope"); },
      log: (l: string) => out.push(l), error: (l: string) => err.push(l),
    } };
  }
  test("open sends the target with the frames and prints the app's answer; a target that doesn't show exits 1", async () => {
    const h = nav();
    expect(await runApp(["open", "settings"], h.deps)).toBe(0);
    expect(await runApp(["open", "bot:alpha", "--window", "main"], h.deps)).toBe(0);
    expect(await runApp(["open", "nope"], h.deps)).toBe(1);
    expect(h.asked).toEqual([["app.open", { target: "settings", frames: true }], ["app.open", { target: "bot:alpha", frames: true }], ["app.open", { target: "nope", frames: true }]]);
    expect(JSON.parse(h.out[0]!)).toEqual(answer("settings"));
  });
  test("where asks for nothing but the place; bad words exit 2 and ask nothing", async () => {
    const h = nav();
    expect(await runApp(["where"], h.deps)).toBe(0);
    expect(h.asked).toEqual([["app.where", { frames: true }]]);
    for (const bad of [["open"], ["open", "a b"], ["open", "settings", "--window", "island"], ["open", "settings", "extra"], ["where", "now"]]) expect(await runApp(bad, h.deps)).toBe(2);
    expect(h.asked).toHaveLength(1);
  });
});
