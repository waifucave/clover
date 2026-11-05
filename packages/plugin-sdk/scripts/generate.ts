// Writes the plugin SDK's JSON Schemas and catalog to `generated/` (`bun run generate` in packages/plugin-sdk).
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildSdkArtifacts } from "./schemas";

const dir = join(import.meta.dir, "..", "generated");
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const files = buildSdkArtifacts();
for (const [name, content] of files) writeFileSync(join(dir, name), content);
console.log(`generated: ${[...files.keys()].join(", ")}`);
