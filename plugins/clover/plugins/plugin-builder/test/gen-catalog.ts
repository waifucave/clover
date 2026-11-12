// `bun run gen`: rewrites the generated block of skills/plugin-catalog/SKILL.md from the SDK's catalogs.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withReference } from "./catalog";

const file = join(import.meta.dir, "..", "skills", "plugin-catalog", "SKILL.md");
writeFileSync(file, withReference(readFileSync(file, "utf8")));
console.log(`wrote ${file}`);
