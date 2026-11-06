// Lane B's manifest validator run over one bundled part of `clover` (§5.4), for each part's manifest test: the
// findings the core would report when it loads the part, as lines, so a test can ask for none. Tests only; it reads
// the disk, so nothing in a client bundle imports it.
import { validateManifest } from "@waifucave/clover-plugin-sdk";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";

export function manifestFindings(root: string): string[] {
  const report = validateManifest(readFileSync(join(root, "clover.json"), "utf8"), {
    folderName: basename(root),
    parent: { id: "clover", namespace: "clover" },
    bundled: true,
    file: "clover.json",
  });
  return report.issues.map((i) => `${i.severity} ${i.code} ${i.path}: ${i.message}`);
}
