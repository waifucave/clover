// Every setting the bundled settings part reads or writes through the plugin API is one its manifest declares (the
// daemon refuses the rest), with the same defaults the part shows.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OWN_SETTING_KEYS } from "../client/keys";

const manifest = JSON.parse(readFileSync(join(import.meta.dir, "..", "clover.json"), "utf8")) as { settings?: Record<string, { type: string; options?: string[]; default?: unknown }> };

describe("the settings part's own keys", () => {
  test("each key it touches is declared in clover.json", () => {
    const declared = Object.keys(manifest.settings ?? {});
    for (const k of OWN_SETTING_KEYS) expect(declared).toContain(k);
    expect(declared.sort()).toEqual([...OWN_SETTING_KEYS].sort());
  });

  test("the part's source names no other settings key", () => {
    const src = readFileSync(join(import.meta.dir, "..", "client", "entry.tsx"), "utf8");
    const direct = [...src.matchAll(/settings\.(?:get|set)(?:<[^>]*>)?\(\s*"([^"]+)"/g)].map((m) => m[1]!);
    expect(direct).toEqual([]);
  });
});
