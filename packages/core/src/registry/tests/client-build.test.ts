// A client entry's build keeps exactly `CLIENT_BARE_IMPORTS` as imports (the names every layer's import map serves,
// and the ones the loader check lets a client-only file import without shipping), so the client always runs on the
// layer's one React, even when the plugin ships its own.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLIENT_BARE_IMPORTS } from "@waifucave/clover-plugin-sdk";
import { buildPluginModule } from "../build";

const write = (root: string, files: Record<string, string>) => {
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), body);
  }
};

describe("a client's build and the layer's import map", () => {
  test("every name the map serves stays a bare import, and nothing else does", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clover-client-build-"));
    write(dir, {
      "client/index.tsx": [
        ...CLIENT_BARE_IMPORTS.map((n, i) => `import * as m${i} from "${n}";`),
        `export const all = [${CLIENT_BARE_IMPORTS.map((_, i) => `m${i}`).join(", ")}];`,
        `export const View = () => <p>hi</p>;`,
      ].join("\n"),
    });
    const built = await buildPluginModule({ entry: join(dir, "client", "index.tsx"), outFile: join(dir, "out", "index.js"), side: "client" });
    expect(new Set(built.imports)).toEqual(new Set(CLIENT_BARE_IMPORTS));
  });

  test("a plugin that ships its own react still imports the layer's: its copy is never bundled", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clover-client-build-"));
    write(dir, {
      "node_modules/react/package.json": JSON.stringify({ name: "react", version: "18.0.0", main: "index.js" }),
      "node_modules/react/index.js": `export const useState = () => "THE-PLUGINS-OWN-REACT";\n`,
      "node_modules/react/jsx-runtime.js": `export const jsx = () => "THE-PLUGINS-OWN-JSX";\n`,
      "client/index.tsx": `import { useState } from "react";\nexport const View = () => { const [x] = useState(0); return <p>{x}</p>; };\n`,
    });
    const built = await buildPluginModule({ entry: join(dir, "client", "index.tsx"), outFile: join(dir, "out", "index.js"), side: "client" });
    // A production build: its JSX goes through react/jsx-runtime (the map serves the dev runtime too).
    expect(new Set(built.imports)).toEqual(new Set(["react", "react/jsx-runtime"]));
    expect(built.source).not.toContain("THE-PLUGINS-OWN");
    expect(built.inputs.some((f) => f.includes("node_modules"))).toBe(false);
  });
});
