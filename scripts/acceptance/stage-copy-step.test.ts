// The stage-copy clause's folder: the copy's manifest is valid as a third party's (another id), holds the capabilities its OK
// card is checked for and declares no platform point; its client builds to one module with the layers' imports left.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capabilityOkText } from "../../packages/plugin-sdk/src/catalogs/capabilities";
import { validateManifest } from "../../packages/plugin-sdk/src/manifest/validate";
import { COPY_ID, COPY_OK_LINES, buildCopy, copyManifest } from "./stage-copy-step";

const root = mkdtempSync(join(tmpdir(), "clv-stage-copy-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("the copy the stage clause installs", () => {
  test("a valid third-party manifest under its own id, holding avatar.report and bots.avatar", () => {
    const manifest = copyManifest();
    const report = validateManifest(manifest, { folderName: COPY_ID });
    expect(report.issues.filter((i) => i.severity === "error").map((i) => `${i.code}:${i.path}`)).toEqual([]);
    expect([report.ok, report.id]).toEqual([true, COPY_ID]);
    expect(manifest.capabilities).toEqual(expect.arrayContaining(["avatar.report", "bots.avatar"]));
  });
  test("its OK card lines are the catalog's words for what it holds", () => {
    const caps = (copyManifest().capabilities as string[]).map((c) => capabilityOkText(c));
    for (const line of COPY_OK_LINES) expect(caps.some((c) => c?.includes(line))).toBe(true);
  });
  test("its client builds to a module that keeps only the layers' imports, with its stylesheet", async () => {
    const dir = await buildCopy(root);
    const js = readFileSync(join(dir, "client", "index.js"), "utf8");
    expect(js).toContain("BotStage");
    expect(existsSync(join(dir, "client", "styles.css"))).toBe(true);
    const bare = [...js.matchAll(/^(?:import|export)\b[^;\n]*?\bfrom\s*"([^"./][^"]*)"/gm)].map((m) => m[1]!);
    for (const spec of bare) expect(["react", "react/jsx-runtime", "@waifucave/clover-plugin-sdk"].some((a) => spec === a || spec.startsWith(`${a}/`))).toBe(true);
  }, 60_000);
});
