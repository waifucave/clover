// The surface-copy clause's folders: each copy's manifest is valid as a third party's (another id, no locale of the bundled
// namespace), holds the capabilities its OK card is checked for, and its client builds to one module with the layers' imports left.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capabilityOkText } from "../../packages/plugin-sdk/src/catalogs/capabilities";
import { validateManifest } from "../../packages/plugin-sdk/src/manifest/validate";
import { MIRROR_ID, MIRROR_OK_LINES, buildMirror, mirrorManifest, type Mirror } from "./surface-copy-step";

const root = mkdtempSync(join(tmpdir(), "clv-mirror-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("the copies the surface clause installs", () => {
  for (const kind of ["island", "pill"] as const satisfies readonly Mirror[]) {
    test(`the ${kind} copy is a valid third-party manifest under its own id`, () => {
      const manifest = mirrorManifest(kind);
      const report = validateManifest(manifest, { folderName: MIRROR_ID[kind] });
      expect(report.issues.filter((i) => i.severity === "error").map((i) => `${i.code}:${i.path}`)).toEqual([]);
      expect([report.ok, report.id]).toEqual([true, MIRROR_ID[kind]]);
    });
    test(`its OK card lines are the catalog's words for what it holds (${kind})`, () => {
      const caps = (mirrorManifest(kind).capabilities as string[]).map((c) => capabilityOkText(c));
      for (const line of MIRROR_OK_LINES[kind]) expect(caps.some((c) => c?.includes(line))).toBe(true);
    });
  }
  test("a copy's client builds to a module that keeps only the layers' imports", async () => {
    const dir = await buildMirror("island", root);
    const js = readFileSync(join(dir, "client", "index.js"), "utf8");
    expect(js).toContain("IslandApp");
    const bare = [...js.matchAll(/^(?:import|export)\b[^;\n]*?\bfrom\s*"([^"./][^"]*)"/gm)].map((m) => m[1]!);
    expect(bare.length).toBeGreaterThan(0);
    for (const spec of bare) expect(["react", "react/jsx-runtime", "@waifucave/moss-plugin-sdk/ui"].some((a) => spec === a || spec.startsWith(`${a}/`))).toBe(true);
  }, 60_000);
});
