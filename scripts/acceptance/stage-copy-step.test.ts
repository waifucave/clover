// The avatar-copy clause's folders: the copy's manifest is valid as a third party's (another id, its points renamed to it),
// holds the capabilities its OK card is checked for and declares no point of the bundled plugin's; the renderer copy fills the
// copy's points only; each client builds to one module with the layers' imports left and the copy's names in it.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capabilityOkText } from "../../packages/plugin-sdk/src/catalogs/capabilities";
import { validateManifest } from "../../packages/plugin-sdk/src/manifest/validate";
import { COPY_ID, RENDERER_ID, buildCopy, buildRenderer, copyManifest, copyOkLines } from "./stage-copy-step";

const root = mkdtempSync(join(tmpdir(), "clv-avatar-copy-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const bare = (js: string) => [...js.matchAll(/^(?:import|export)\b[^;\n]*?\bfrom\s*"([^"./][^"]*)"/gm)].map((m) => m[1]!);
const layerImport = (spec: string) => ["react", "react/jsx-runtime", "@waifucave/moss-plugin-sdk"].some((a) => spec === a || spec.startsWith(`${a}/`));

describe("the copy the avatar clause installs", () => {
  test("a valid third-party manifest under its own id, its points its own, holding the bundled plugin's capabilities", () => {
    const manifest = copyManifest();
    const report = validateManifest(manifest, { folderName: COPY_ID });
    expect(report.issues.filter((i) => i.severity === "error").map((i) => `${i.code}:${i.path}`)).toEqual([]);
    expect([report.ok, report.id]).toEqual([true, COPY_ID]);
    expect(JSON.stringify(manifest)).not.toContain("moss.character.");
    expect(JSON.stringify(manifest)).toContain(`${COPY_ID}.renderer`);
    expect([...(manifest.capabilities as string[])].sort()).toEqual(["activity.read.bots", "activity.read.sessions", "files", "overlay"]);
  });
  test("its OK card lines are the catalog's words for what it holds", () => {
    for (const [cap, line] of (copyManifest().capabilities as string[]).map((c, i) => [c, copyOkLines()[i]] as const)) expect(line).toBe(capabilityOkText(cap)!);
  });
  test("its client builds to a module that keeps only the layers' imports, with the copy's names, and its stylesheet", async () => {
    const dir = await buildCopy(root);
    const js = readFileSync(join(dir, "client", "index.js"), "utf8");
    expect(js).toContain(`"${COPY_ID}.renderer"`);
    expect(js).not.toContain("moss.character.");
    expect(existsSync(join(dir, "client", "styles.css"))).toBe(true);
    for (const spec of bare(js)) expect([spec, layerImport(spec)]).toEqual([spec, true]);
  }, 60_000);
  test("the renderer copy fills the copy's points (renderer spot, formats, packs) and MOSS Voice's speech; valid as a third party's", async () => {
    const dir = await buildRenderer(root);
    const m = JSON.parse(readFileSync(join(dir, "moss.json"), "utf8"));
    const report = validateManifest(m, { folderName: RENDERER_ID });
    expect(report.issues.filter((i) => i.severity === "error").map((i) => `${i.code}:${i.path}`)).toEqual([]);
    expect(m.contributes.ui[0].spot).toBe(`${COPY_ID}.renderer`);
    expect(Object.keys(m.contributes).filter((k) => k !== "locales").sort()).toEqual([`${COPY_ID}.formats`, `${COPY_ID}.packs`, "moss.voice.speech", "ui"].sort());
    expect(existsSync(join(dir, "sample-model", "sunny.pngtuber.json"))).toBe(true);
    for (const spec of bare(readFileSync(join(dir, "client", "index.js"), "utf8"))) expect([spec, layerImport(spec)]).toEqual([spec, true]);
  }, 60_000);
});
