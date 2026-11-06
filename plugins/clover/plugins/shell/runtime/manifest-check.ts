// Lane B's manifest validator run over one bundled part of `clover` (§5.4), for each part's manifest test: the
// findings the core would report when it loads the part, as lines, so a test can ask for none. Tests only; it reads
// the disk, so nothing in a client bundle imports it.
import { LocaleSchema, validateManifest } from "@waifucave/clover-plugin-sdk";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";

export function manifestFindings(root: string): string[] {
  const report = validateManifest(readFileSync(join(root, "clover.json"), "utf8"), {
    folderName: basename(root),
    parent: { id: "clover", namespace: "clover" },
    bundled: true,
    file: "clover.json",
  });
  const found = report.issues.map((i) => `${i.severity} ${i.code} ${i.path}: ${i.message}`);
  // Its string tables: locale format 1, every key a `clover.` key (F-M3: no inline English).
  const manifest = JSON.parse(readFileSync(join(root, "clover.json"), "utf8")) as { contributes?: { locales?: { lang: string; file: string }[] } };
  for (const l of manifest.contributes?.locales ?? []) {
    const parsed = LocaleSchema.safeParse(JSON.parse(readFileSync(join(root, l.file), "utf8")));
    if (!parsed.success) found.push(`error locale ${l.file}: ${parsed.error.message}`);
    else for (const key of Object.keys(parsed.data.strings)) if (!key.startsWith("clover.")) found.push(`error locale ${l.file}: ${key} isn't a clover. key`);
  }
  if ((manifest.contributes?.locales ?? []).length === 0) found.push("error locale: no locales/en.json declared");
  return found;
}
