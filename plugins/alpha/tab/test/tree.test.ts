// Alpha's folder is a plugin tree the registry validates strictly: a link that leaves it refuses the whole plugin. A nested
// install (a `node_modules` under her folder, which the workspace installer makes when a member names its own
// dependencies) is exactly that, so her `server/` and `tab/` take their tools from the workspace root and this test fails
// the day one grows a dependency of its own.
import { describe, expect, test } from "bun:test";
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ALPHA = join(import.meta.dir, "..", "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = lstatSync(p);
    if (st.isSymbolicLink() || name === "node_modules") out.push(p.slice(ALPHA.length + 1));
    else if (st.isDirectory()) walk(p, out);
  }
  return out;
}

describe("Alpha's folder after an install", () => {
  test("holds no node_modules and no link anywhere, so the registry's strict tree check passes", () => {
    expect(walk(ALPHA)).toEqual([]);
  });

  test("her server and tab packages name no dependencies of their own", async () => {
    for (const p of ["server", "tab"]) {
      const pkg = (await Bun.file(join(ALPHA, p, "package.json")).json()) as Record<string, unknown>;
      expect(Object.keys(pkg).filter((k) => /^(dev|peer|optional)?[dD]ependencies$/.test(k)), p).toEqual([]);
    }
  });
});
