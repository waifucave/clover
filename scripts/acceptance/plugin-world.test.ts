// The run's fake plugin index and npm registry, as the daemon's pinned fetch reaches them through the source seam
// (fake-exa.ts searchOnlySeam with a plugin world): an index lists what was published, with the tree hash Clover
// computes; the download is that tarball; npm's record names an https tarball with a SHA-512 integrity that matches.
import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pinnedFetch } from "../../packages/core/src/plugin-host/pinned-fetch";
import { httpsFetch } from "../../packages/core/src/registry/indexes/client";
import { npmPackageUrl, npmVersionOf } from "../../packages/core/src/registry/indexes/npm";
import { searchOnlySeam } from "./fake-exa";
import { FAKE_INDEX_URL, publishIndexVersion, publishNpm, treeHashOf } from "./plugin-world";

const world = mkdtempSync(join(tmpdir(), "clover-acceptance-world-"));
afterAll(() => rmSync(world, { recursive: true, force: true }));
const refused: string[] = [];
const fetchVia = httpsFetch(5_000, pinnedFetch(searchOnlySeam({ calls: [], handle: async () => new Response("no") } as never, (h) => refused.push(h), world)));
const files = (v: string) => ({ "clover.json": JSON.stringify({ manifest: 1, id: "acceptance-indexed", name: "Indexed", version: v, engines: { clover: "^1.0.0" } }) });

test("the fake index lists each version published, with Clover's tree hash and its download", async () => {
  await publishIndexVersion(world, "acceptance-indexed", "1.0.0", files("1.0.0"));
  await publishIndexVersion(world, "acceptance-indexed", "1.1.0", files("1.1.0"));
  const index = JSON.parse(new TextDecoder().decode(await fetchVia(FAKE_INDEX_URL, 1_000_000)));
  const versions = index.plugins[0].versions as { version: string; hash: string; url: string }[];
  expect(versions.map((v) => v.version)).toEqual(["1.0.0", "1.1.0"]);
  expect(versions[1]!.hash).toBe(await treeHashOf(files("1.1.0")));
  expect((await fetchVia(versions[1]!.url, 10_000_000)).byteLength).toBeGreaterThan(0);
});

test("the fake npm registry's record names an https tarball whose SHA-512 matches its integrity", async () => {
  await publishNpm(world, "acceptance-npm-plugin", "1.0.0", files("1.0.0"));
  const meta = JSON.parse(new TextDecoder().decode(await fetchVia(npmPackageUrl("acceptance-npm-plugin"), 1_000_000)));
  const v = npmVersionOf(meta, "acceptance-npm-plugin");
  expect(createHash("sha512").update(await fetchVia(v.tarball, 10_000_000)).digest("hex")).toBe(v.sha512);
  expect(refused).toEqual([]);
});
