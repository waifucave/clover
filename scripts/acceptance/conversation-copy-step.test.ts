// The conversation-copy clause's folder: the copy's manifest is valid as a third party's (another id, no locale of the bundled
// namespace), holds the capabilities its OK card is checked for (user.send for Try again among them), and its client builds
// to one module with the layers' imports left and its stylesheet beside it.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capabilityOkText } from "../../packages/plugin-sdk/src/catalogs/capabilities";
import { validateManifest } from "../../packages/plugin-sdk/src/manifest/validate";
import { COPY_ID, COPY_OK_LINES, buildCopy, copyManifest } from "./conversation-copy-step";

const root = mkdtempSync(join(tmpdir(), "clv-conv-copy-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("the copy the conversation clause installs", () => {
  test("a valid third-party manifest under its own id, holding the capabilities its rows need", () => {
    const manifest = copyManifest();
    const report = validateManifest(manifest, { folderName: COPY_ID });
    expect(report.issues.filter((i) => i.severity === "error").map((i) => `${i.code}:${i.path}`)).toEqual([]);
    expect([report.ok, report.id]).toEqual([true, COPY_ID]);
    expect(manifest.capabilities).toEqual(expect.arrayContaining(["conversation.read", "user.send"]));
  });
  test("its OK card lines are the catalog's words for what it holds", () => {
    const caps = (copyManifest().capabilities as string[]).map((c) => capabilityOkText(c));
    for (const line of COPY_OK_LINES) expect(caps.some((c) => c?.includes(line))).toBe(true);
  });
  test("its client builds to a module that keeps only the layers' imports, with its stylesheet", async () => {
    const dir = await buildCopy(root);
    const js = readFileSync(join(dir, "client", "index.js"), "utf8");
    expect(js).toContain("ConversationEntry");
    expect(existsSync(join(dir, "client", "styles.css"))).toBe(true);
    const bare = [...js.matchAll(/^(?:import|export)\b[^;\n]*?\bfrom\s*"([^"./][^"]*)"/gm)].map((m) => m[1]!);
    for (const spec of bare) expect(["react", "react/jsx-runtime", "@waifucave/moss-plugin-sdk/ui"].some((a) => spec === a || spec.startsWith(`${a}/`))).toBe(true);
  }, 60_000);
});
