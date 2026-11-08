// A built daemon and its release's bundled-plugins tarball belong together (#244): the tarball, unpacked as a server
// unpacks it (packages/update-feed's `unpackTarball`), measures to exactly the manifest the daemon embeds, which the
// daemon itself reports (`__bundled-manifest`, run as a server's self-update runs it: self-update.ts's
// `runBundledManifest`, PATH alone).
//
//   bun scripts/release/check-plugins-tarball.ts <clover-core-…> <clover-plugins-…tar.gz>
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { formatBundledManifest } from "../../packages/core/src/bundled-plugins-dir";
import { unpackTarball } from "../../packages/update-feed/src/index";
import { runBundledManifest } from "../../packages/cli/src/self-update";

/** The SHA-256 of the manifest text the tarball's files measure to. */
export function tarballManifestSha256(gz: Uint8Array): { sha256: string; files: number } {
  const files = unpackTarball(gz);
  const m: Record<string, { sha256: string; size: number }> = {};
  for (const f of files) m[f.path] = { sha256: createHash("sha256").update(f.bytes).digest("hex"), size: f.bytes.length };
  return { sha256: createHash("sha256").update(formatBundledManifest({ files: m })).digest("hex"), files: files.length };
}

export async function main(argv: readonly string[]): Promise<number> {
  const [binary, tarball] = argv;
  if (binary === undefined || tarball === undefined || argv.length !== 2) {
    console.error("usage: check-plugins-tarball <clover-core binary> <clover-plugins tarball>");
    return 2;
  }
  const said = await runBundledManifest(binary);
  if (said === undefined || said === "none") {
    console.error(`check-plugins-tarball: ${binary} ${said === "none" ? "carries no bundled-plugins manifest" : "didn't say which manifest it carries"}`);
    return 1;
  }
  const t = tarballManifestSha256(new Uint8Array(readFileSync(tarball)));
  if (t.sha256 !== said) {
    console.error(`check-plugins-tarball: ${tarball} (${t.files} files) measures to ${t.sha256}, not the ${said} ${binary} embeds`);
    return 1;
  }
  console.log(`check-plugins-tarball: ${tarball} is the tree ${binary} embeds the manifest of (${t.files} files, sha256 ${said})`);
  return 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
