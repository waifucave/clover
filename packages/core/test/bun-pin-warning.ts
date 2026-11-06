// One line on stderr when this Bun is not the one `.bun-version` pins. CI tests on the pinned one, so a local run on
// another can fail (or pass) where CI would not: on 1.3.14 the Bun 1.4 charset and proxy tests fail. Run tests with
// `scripts/pinned-bun test …` or through `scripts/heavy`, which put the pinned Bun first. Said once per run: the
// processes a test starts inherit the mark.
import { readFileSync } from "node:fs";
import { join } from "node:path";

if (process.env.CLOVER_BUN_PIN_WARNED !== "1") {
  let pinned: string | undefined;
  try {
    pinned = readFileSync(join(import.meta.dir, "..", "..", "..", ".bun-version"), "utf8").trim();
  } catch {
    // Not in a checkout: nothing to compare against.
  }
  if (pinned !== undefined && pinned !== Bun.version) {
    process.env.CLOVER_BUN_PIN_WARNED = "1";
    console.warn(`warning: this is Bun ${Bun.version}, but .bun-version pins ${pinned} (CI's): run tests with scripts/pinned-bun test … or through scripts/heavy`);
  }
}
