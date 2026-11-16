// Writes Alpha's placeholder avatar to plugins/alpha/assets/alpha.vrm (the path Alpha's manifest names in
// spec §5.9). `bun run placeholder` after changing src/placeholder/; the test fails until the committed file
// matches the code again.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makePlaceholderVrm } from "../src/placeholder/model";

const out = join(import.meta.dir, "..", "..", "..", "..", "alpha", "assets", "alpha.vrm");
const bytes = makePlaceholderVrm();
writeFileSync(out, bytes);
console.log(`wrote ${out} (${bytes.byteLength} bytes)`);
