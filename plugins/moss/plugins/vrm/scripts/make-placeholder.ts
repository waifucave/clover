// Writes Alpha's placeholder VRM figure to plugins/moss/plugins/alpha-figure/vrm/alpha.vrm (the path her figure pack
// names). `bun run placeholder` after changing src/placeholder/; the test fails until the committed file
// matches the code again.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makePlaceholderVrm } from "../src/placeholder/model";

const out = join(import.meta.dir, "..", "..", "alpha-figure", "vrm", "alpha.vrm");
const bytes = makePlaceholderVrm();
writeFileSync(out, bytes);
console.log(`wrote ${out} (${bytes.byteLength} bytes)`);
