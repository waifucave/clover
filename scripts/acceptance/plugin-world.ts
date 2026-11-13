// The run's fake plugin index and npm registry (fake-exa.ts serves them by name, from `world`): publishing a version
// writes its `.tar.gz` and the index or npm record that lists it, as an index author or `npm publish` would. The tree
// hash an index lists is the one Clover computes for the unpacked folder (validatePluginFolder).
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { validatePluginFolder } from "../../packages/core/src/registry/validate";
import { tgz } from "../../packages/core/src/registry/indexes/tests/tar-fixture";
import { FAKE_INDEX_HOST, FAKE_NPM_HOST } from "./fake-exa";

/** The address the user adds the fake index by. */
export const FAKE_INDEX_URL = `https://${FAKE_INDEX_HOST}/index.json`;

/** A plugin version's files, by path. */
export type Files = Record<string, string>;

/** The tree hash Clover computes for these files as a plugin folder. */
export async function treeHashOf(files: Files): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "clover-acceptance-hash-"));
  try {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    const v = await validatePluginFolder(dir);
    if (v.treeHash === undefined) throw new Error(`the files don't make a plugin: ${JSON.stringify(v).slice(0, 300)}`);
    return v.treeHash;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const tarball = (files: Files, prefix = "") => tgz(Object.entries(files).map(([path, data]) => ({ path: `${prefix}${path}`, data })));

/** Lists `id`'s `version` in the fake index (named "Acceptance index"), its download beside it. */
export async function publishIndexVersion(world: string, id: string, version: string, files: Files): Promise<string> {
  const root = join(world, FAKE_INDEX_HOST);
  mkdirSync(root, { recursive: true });
  const file = `${id}-${version}.tgz`;
  writeFileSync(join(root, file), tarball(files));
  const hash = await treeHashOf(files);
  const indexFile = join(root, "index.json");
  let index: { index: 1; name: string; plugins: { id: string; versions: { version: string; hash: string; url: string }[] }[] };
  try {
    index = JSON.parse(readFileSync(indexFile, "utf8"));
  } catch {
    index = { index: 1, name: "Acceptance index", plugins: [] };
  }
  let entry = index.plugins.find((p) => p.id === id);
  if (entry === undefined) index.plugins.push((entry = { id, versions: [] }));
  entry.versions = [...entry.versions.filter((v) => v.version !== version), { version, hash, url: `https://${FAKE_INDEX_HOST}/${file}` }];
  writeFileSync(indexFile, JSON.stringify(index, null, 2));
  return hash;
}

/** Publishes `name@version` to the fake npm registry (its tarball under `package/`, its SHA-512 integrity) as latest. */
export async function publishNpm(world: string, name: string, version: string, files: Files): Promise<string> {
  const root = join(world, FAKE_NPM_HOST);
  mkdirSync(join(root, name, "-"), { recursive: true });
  const bytes = tarball(files, "package/");
  writeFileSync(join(root, name, "-", `${name}-${version}.tgz`), bytes);
  const meta = {
    name, "dist-tags": { latest: version },
    versions: { [version]: { name, version, dist: { tarball: `https://${FAKE_NPM_HOST}/${name}/-/${name}-${version}.tgz`, integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` } } },
  };
  // The package's record is the bare path `/<name>`: a file beside its folder, so the folder keeps its tarballs.
  writeFileSync(join(root, `${name}.meta`), JSON.stringify(meta));
  return treeHashOf(files);
}
