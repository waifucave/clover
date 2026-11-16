// The committed `generated/moss/` files must be what the generator makes now (`pnpm protocol:generate`).
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { buildMossArtifacts } from "../scripts/moss-artifacts";

const dir = join(import.meta.dir, "..", "generated", "moss");

function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else out.push(relative(root, p).split("\\").join("/"));
    }
  };
  if (existsSync(root)) walk(root);
  return out.sort();
}

describe("generated/moss", () => {
  test("is current: run `pnpm protocol:generate` and commit the result if this fails", () => {
    const want = buildMossArtifacts();
    expect(listFiles(dir)).toEqual([...want.keys()].sort());
    for (const [rel, content] of want) expect(readFileSync(join(dir, rel), "utf8")).toBe(content);
  });
});
