import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACCEPTANCE_BUILD_LABEL, TEST_ONLY_APP_STRINGS, asarFiles, asarMarkerProblems, carriesTestBuild, TEST_BUILD_LABEL, TEST_BUILD_SENTINEL, testBuildDefine, testBuildDefineArg, testBuildMarkerProblems } from "./test-build";
import { verifySealedCore } from "./verify-sealed-core";

const utf8 = (s: string) => new TextEncoder().encode(s);

/** An `app.asar` as Electron packs one: a pickled JSON header (`[4][header size]` then `[payload size][json length][json]`
 *  padded to 4), then each file's bytes at its offset. */
function packAsar(files: Record<string, string>, unpacked: readonly string[] = []): Uint8Array {
  const tree: { files: Record<string, unknown> } = { files: {} };
  const blobs: Uint8Array[] = [];
  let offset = 0;
  for (const [path, text] of Object.entries(files)) {
    const parts = path.split("/");
    let at = tree;
    for (const dir of parts.slice(0, -1)) at = ((at.files[dir] ??= { files: {} }) as typeof tree);
    const bytes = utf8(text);
    if (unpacked.includes(path)) at.files[parts.at(-1)!] = { size: bytes.length, unpacked: true };
    else {
      at.files[parts.at(-1)!] = { size: bytes.length, offset: String(offset) };
      blobs.push(bytes);
      offset += bytes.length;
    }
  }
  const json = utf8(JSON.stringify(tree));
  const padded = Math.ceil(json.length / 4) * 4;
  const header = new Uint8Array(8 + padded);
  new DataView(header.buffer).setUint32(0, 4 + padded, true);
  new DataView(header.buffer).setUint32(4, json.length, true);
  header.set(json, 8);
  const out = new Uint8Array(8 + header.length + offset);
  new DataView(out.buffer).setUint32(0, 4, true);
  new DataView(out.buffer).setUint32(4, header.length, true);
  out.set(header, 8);
  let at = 8 + header.length;
  for (const b of blobs) { out.set(b, at); at += b.length; }
  return out;
}

describe("the test-marked build's marker (scripts/test-build.ts)", () => {
  test("the define: `false` for a real build (no quotes, cmd.exe takes it), the label for a test build", () => {
    expect(testBuildDefineArg(false)).toBe("__CLOVER_TEST_BUILD__=false");
    expect(testBuildDefineArg(true)).toBe(`'__CLOVER_TEST_BUILD__="${TEST_BUILD_LABEL}"'`);
    expect(testBuildDefine(false)).toEqual({ __CLOVER_TEST_BUILD__: "false" });
    expect(testBuildDefine(true)).toEqual({ __CLOVER_TEST_BUILD__: JSON.stringify(TEST_BUILD_LABEL) });
    expect(TEST_BUILD_LABEL).toMatch(/^[A-Z-]+$/);
  });

  test("the gate: a real build carries neither the label nor the test-only code, a test build both", () => {
    const clean = utf8("clover 1.2.3 code");
    const both = utf8(`code ${TEST_BUILD_LABEL} and ${TEST_BUILD_SENTINEL}`);
    expect(testBuildMarkerProblems("core", clean, false)).toEqual([]);
    expect(testBuildMarkerProblems("core", both, true)).toEqual([]);
    expect(testBuildMarkerProblems("core", utf8(`x ${TEST_BUILD_LABEL}`), false)).toEqual([`core carries the test-build label ${TEST_BUILD_LABEL}: a real build never does`]);
    expect(testBuildMarkerProblems("core", utf8(`x ${TEST_BUILD_SENTINEL}`), false)[0]).toContain("compiled out");
    expect(testBuildMarkerProblems("core", clean, true)).toHaveLength(2);
    expect(testBuildMarkerProblems("core", utf8(TEST_BUILD_LABEL), true)[0]).toContain("test-only code");
    expect(carriesTestBuild(clean)).toBe(false);
    expect(carriesTestBuild(utf8(TEST_BUILD_SENTINEL))).toBe(true);
  });

  test("an app.asar: its files read back; the label checked everywhere, the test-only code in what runs, not the maps", () => {
    const real = packAsar({ "package.json": "{}", "out/main/index.js": "real code", "out/main/index.js.map": `{"sourcesContent":["if (t) say('${TEST_BUILD_SENTINEL}')"]}` });
    const files = asarFiles(real);
    expect([...files.keys()].sort()).toEqual(["out/main/index.js", "out/main/index.js.map", "package.json"]);
    expect(new TextDecoder().decode(files.get("out/main/index.js")!)).toBe("real code");
    expect(asarMarkerProblems("app.asar", real, false)).toEqual([]);
    const leaked = packAsar({ "out/main/index.js": `say('${TEST_BUILD_SENTINEL}')` });
    expect(asarMarkerProblems("app.asar", leaked, false)[0]).toContain("compiled out");
    const labelled = packAsar({ "out/main/index.js.map": TEST_BUILD_LABEL });
    expect(asarMarkerProblems("app.asar", labelled, false)[0]).toContain("label");
    const test = packAsar({ "out/main/index.js": `log('${TEST_BUILD_LABEL}: a ${TEST_BUILD_SENTINEL}')` });
    expect(asarMarkerProblems("app.asar", test, true)).toEqual([]);
    expect(asarMarkerProblems("app.asar", real, true)).toHaveLength(2);
    // The test-only app paths: a real build's code reads neither variable, nor carries the acceptance build's label.
    for (const t of TEST_ONLY_APP_STRINGS) {
      expect(asarMarkerProblems("app.asar", packAsar({ "out/main/index.js": `process.env.${t}` }), false)[0]).toContain(`reads ${t}`);
      expect(asarMarkerProblems("app.asar", packAsar({ "out/main/index.js.map": `process.env.${t}` }), false)).toEqual([]);
    }
    expect(asarMarkerProblems("app.asar", packAsar({ "out/main/index.js": ACCEPTANCE_BUILD_LABEL }), false)[0]).toContain("acceptance build");
    // A file kept outside the archive (app.asar.unpacked) isn't in it.
    expect([...asarFiles(packAsar({ "a.js": "x", "b.node": "y" }, ["b.node"])).keys()]).toEqual(["a.js"]);
    expect(() => asarFiles(utf8("not an archive at all"))).toThrow(/not an asar/);
  });

  test("verify:sealed-core refuses a test-marked core before running it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lane-int-sealed-test-"));
    try {
      const core = join(dir, "clover-core");
      writeFileSync(core, `binary ${TEST_BUILD_LABEL} bytes`);
      expect(await verifySealedCore(core, { signed: true, sweep: false, requireProof: true })).toEqual([`ERROR: ${core} is a test-marked core (scripts/test-build.ts): never verified or shipped as a release's`]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
