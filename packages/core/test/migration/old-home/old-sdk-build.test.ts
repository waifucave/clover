// A folder plugin OUTSIDE the home is never rewritten (the one-time copy's ruling 6): one that still imports the plugin
// SDK under its old name builds, the build reading that name second (`old-names.ts`) and resolving it to the new package.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NEW_PLUGIN_SDK, OLD_NAMES, OLD_PLUGIN_SDK, newSdkSpecifier } from "../../../src/old-names";
import { buildPluginModule } from "../../../src/registry/build";
import { loaderOutsideIssues, loaderReach, pluginEntries, SHARED_PLUGIN_PACKAGES } from "../../../src/registry/loader-config";

describe("the plugin SDK's old import specifier, read second", () => {
  test("listed with the old names; not a shared package (only the builder reads it second)", () => {
    expect(OLD_NAMES).toContain(OLD_PLUGIN_SDK);
    expect(SHARED_PLUGIN_PACKAGES).not.toContain(OLD_PLUGIN_SDK);
    expect(newSdkSpecifier(OLD_PLUGIN_SDK)).toBe(NEW_PLUGIN_SDK);
    expect(newSdkSpecifier(`${OLD_PLUGIN_SDK}/ui`)).toBe(`${NEW_PLUGIN_SDK}/ui`);
    expect(newSdkSpecifier(`${OLD_PLUGIN_SDK}x`)).toBeUndefined();
    expect(newSdkSpecifier(NEW_PLUGIN_SDK)).toBeUndefined();
  });

  test("a host entry importing it builds against the new package", async () => {
    const dir = mkdtempSync(join(tmpdir(), "moss-old-sdk-"));
    const entry = join(dir, "host.ts");
    writeFileSync(entry, `import { CLIENT_BARE_IMPORTS } from "${OLD_PLUGIN_SDK}";\nexport const n = CLIENT_BARE_IMPORTS.length;\n`);
    const outFile = join(dir, "out", "host.js");
    await buildPluginModule({ entry, outFile, side: "bun" });
    const out = readFileSync(outFile, "utf8");
    expect(out).not.toContain(OLD_PLUGIN_SDK);
    expect(out).toContain("react/jsx-runtime");
  });

  test("a client entry keeps the UI API's import, under the new name, for its layer's import map", async () => {
    const dir = mkdtempSync(join(tmpdir(), "moss-old-sdk-"));
    const entry = join(dir, "entry.tsx");
    writeFileSync(entry, `import * as ui from "${OLD_PLUGIN_SDK}/ui";\nexport const x = Object.keys(ui).length;\n`);
    const outFile = join(dir, "out", "entry.js");
    await buildPluginModule({ entry, outFile, side: "client" });
    const out = readFileSync(outFile, "utf8");
    expect(out).toContain(`"${NEW_PLUGIN_SDK}/ui"`);
    expect(out).not.toContain(OLD_PLUGIN_SDK);
  });

  test("validation: host code that imports it is one plain problem naming the import and the new name; page code is not", () => {
    const text: Record<string, string> = {
      "moss.json": JSON.stringify({ manifest: 1, id: "old-folder", host: { entry: "host/index.ts" }, client: { entry: "client/index.tsx" } }),
      "host/index.ts": `import { definePlugin } from "${OLD_PLUGIN_SDK}";\nexport default definePlugin({});\n`,
      "client/index.tsx": `import { Card } from "${OLD_PLUGIN_SDK}/ui";\nexport const C = Card;\n`,
    };
    const files = Object.keys(text);
    const reach = loaderReach(files, (p) => text[p], (p) => text[p], pluginEntries(files, (p) => text[p]));
    const issues = loaderOutsideIssues(reach);
    expect(issues.map((i) => i.message)).toEqual([`host/index.ts imports "${OLD_PLUGIN_SDK}", the plugin SDK's old name, from code that runs outside the page: change the import to "${NEW_PLUGIN_SDK}"`]);
    expect(issues[0]!.code).toBe("dependency_missing");
  });
});
