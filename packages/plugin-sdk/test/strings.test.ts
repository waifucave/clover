// The SDK's string caps count UTF-16 units, as the protocol's do (lane M's zod 4.6 note): a manifest's or a format
// file's string reaches the wire, the registry's records and the app, which all count `.length`. zod 4.6 counts
// `.max()` in code points, so every cap goes through the protocol's `utf16`. This holds under zod 4.4 and 4.6.7.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { validateManifest } from "../src/index";
import { Path } from "../src/manifest/fields";

const EMOJI = "😀"; // one code point, two UTF-16 units

/** `z.string()` capped by zod's own count: `.max()`, `.length()` or a minimum above 1. */
const RAW_CAP = /z\.string\(\)(\.[a-z]+\([^()]*\))*?\.(max|length)\(|z\.string\(\)\.min\((?!1\))\d/;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? sources(p) : p.endsWith(".ts") ? [p] : [];
  });
}

describe("string caps", () => {
  test("no source caps a string by zod's own count", () => {
    const raw = sources(join(import.meta.dir, "..", "src")).flatMap((file) =>
      readFileSync(file, "utf8").split("\n").flatMap((line, i) => (RAW_CAP.test(line) ? [`${file}:${i + 1}: ${line.trim()}`] : [])));
    expect(raw).toEqual([]);
  });

  test("a manifest's caps count UTF-16 units: a 1024-unit path holds 512 emoji, not 513", () => {
    expect(Path.safeParse(EMOJI.repeat(512)).success).toBe(true);
    expect(Path.safeParse(EMOJI.repeat(513)).success).toBe(false);
    const by = (name: string) => validateManifest({ manifest: 1, id: "luna", name: "Luna", author: { name } }, { folderName: "luna" }).issues.map((i) => i.path);
    expect(by(EMOJI.repeat(100))).toEqual([]);
    expect(by(EMOJI.repeat(101))).toEqual(["/author/name"]);
  });
});
