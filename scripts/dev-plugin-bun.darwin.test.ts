// The dev plugin Bun's signature on a real copy (#234's check 5): ad hoc, its own identifier, the hardened runtime and
// Bun's JIT entitlement, and it still runs. A copy in a temp folder; nothing else is touched.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEV_PLUGIN_BUN_IDENTIFIER, devPluginBunSignArgs, signedFacts } from "./dev-daemon-lib";

// The release copy's entitlements (bundled-binaries.ts's PLUGIN_BUN_ENTITLEMENTS), which dev:daemon signs its copy with.
const ENTITLEMENTS = join(dirname(fileURLToPath(import.meta.url)), "clover-plugin-bun.entitlements");

test("a copy of the pinned Bun, signed as the dev plugin Bun, carries its identifier and still runs", () => {
  const dir = mkdtempSync(join(tmpdir(), "clover-dev-plugin-bun-"));
  try {
    const bun = join(dir, "clover-plugin-bun");
    copyFileSync(realpathSync(process.execPath), bun);
    chmodSync(bun, 0o755);
    const signed = spawnSync("codesign", devPluginBunSignArgs(bun, ENTITLEMENTS), { encoding: "utf8" });
    expect([signed.status, signed.stderr.includes("error")]).toEqual([0, false]);
    const facts = signedFacts(spawnSync("codesign", ["-dv", bun], { encoding: "utf8" }).stderr);
    expect([facts.identifier, facts.runtime]).toEqual([DEV_PLUGIN_BUN_IDENTIFIER, true]);
    const ran = spawnSync(bun, ["-e", "console.log(Bun.version)"], { encoding: "utf8" });
    expect([ran.status, ran.stdout.trim()]).toEqual([0, Bun.version]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);
