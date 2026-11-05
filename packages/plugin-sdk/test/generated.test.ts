// The committed `generated/` files must be what the generator makes now (`bun run generate` in packages/plugin-sdk).
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildSdkArtifacts } from "../scripts/schemas";

const dir = join(import.meta.dir, "..", "generated");

describe("generated/", () => {
  test("is current: run `bun run generate` in packages/plugin-sdk and commit the result if this fails", () => {
    const want = buildSdkArtifacts();
    expect(readdirSync(dir).sort()).toEqual([...want.keys()].sort());
    for (const [name, content] of want) expect(readFileSync(join(dir, name), "utf8")).toBe(content);
  });

  test("the manifest's schema takes any dotted contributes key and refuses others", () => {
    const schema = JSON.parse(readFileSync(join(dir, "clover.schema.json"), "utf8"));
    const contributes = schema.properties.contributes;
    expect(contributes.additionalProperties).toBe(false);
    const pattern = new RegExp(Object.keys(contributes.patternProperties)[0]!);
    expect(pattern.test("webhook.ingress")).toBe(true);
    expect(pattern.test("luna.cards.v2")).toBe(true);
    expect(pattern.test("tools")).toBe(false);
  });
});
