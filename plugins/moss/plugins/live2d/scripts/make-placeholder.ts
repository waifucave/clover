// `bun run placeholder`: writes Alpha's code-made Live2D placeholder (src/placeholder/model.ts) to
// plugins/moss/plugins/alpha-figure/live2d/ (Alpha's figure pack). A test checks the committed files are what this writes.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { placeholderFiles } from "../src/placeholder/model";

export const PLACEHOLDER_DIR = join(import.meta.dir, "..", "..", "alpha-figure", "live2d");

if (import.meta.main) {
  mkdirSync(PLACEHOLDER_DIR, { recursive: true });
  for (const [name, bytes] of Object.entries(placeholderFiles())) {
    writeFileSync(join(PLACEHOLDER_DIR, name), bytes);
    console.log(`${join(PLACEHOLDER_DIR, name)} (${bytes.byteLength} bytes)`);
  }
}
