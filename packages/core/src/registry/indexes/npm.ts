// Installing a plugin from npm (spec §5.1 "Indexes and npm"): the package is unpacked as it is. No install script runs
// and no dependency is fetched (nothing of the package runs before its OK; its code ships bundled). It is checked
// before it lands:
//
// * Its metadata from the npm registry (https, the pinned fetch, the index limits); a version named exactly, or its
//   `latest` tag. Ranges aren't resolved: what installs is the version the user saw.
// * Its tarball: https, the download limits, and its `dist.integrity` (SHA-512, npm's own record of the bytes) checked
//   before it is unpacked; a package without one isn't installed (a SHA-1 `shasum` alone isn't enough).
// * Unpacked by Clover's own reader (`unpack.ts`, npm's `package/` folder as its root), validated as any install, and
//   refused when a revocation list names its tree (the official list blocks a tree hash from any source).
//
// npm has no signature of Clover's: the OK says "not reviewed", and its updates are offered, never applied on their
// own (`NPM_UPDATES`, the owner's answer E).
import { createHash } from "node:crypto";
import { readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { MANIFEST_FILE } from "@waifucave/clover-plugin-sdk";
import { SemverVersion, TopPluginId } from "@waifucave/clover-protocol";
import { ContractError } from "../../contracts/common";
import { installStaged, newStage, type InstallTarget } from "../install-folder";
import { INDEX_MAX_BYTES, type IndexClient } from "./client";
import { DOWNLOAD_MAX_BYTES } from "./install";
import type { Revocations } from "./revocations";
import { unpackTarGz } from "./unpack";

/** The npm registry. */
export const NPM_REGISTRY = "https://registry.npmjs.org";

/** Whether an npm plugin's update applies on its own or is offered: the owner's answer E (2026-11-11), offered. Index
 *  plugins update on their own unless pinned; an update that adds an OK trigger asks again from any source. */
export const NPM_UPDATES: "offer" | "apply" = "offer";

/** npm's abbreviated metadata (the versions' `dist` and the tags, what an install reads), else the full document. */
export const NPM_ACCEPT = { accept: "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8" } as const;

/** An npm package name: lowercase (a legacy mixed-case name is refused), `@scope/name` or `name`, at most 214 characters. */
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;

export function npmPackageUrl(name: string, registry = NPM_REGISTRY): string {
  if (name.length > 214 || !NPM_NAME.test(name)) throw new ContractError("invalid", `${JSON.stringify(name.slice(0, 220))} isn't an npm package name`);
  // A scoped name keeps its `@` and escapes its `/` (`@scope%2fname`), as the registry takes it.
  return `${registry}/${name.startsWith("@") ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name)}`;
}

interface NpmMeta {
  "dist-tags"?: Record<string, string>;
  versions?: Record<string, { dist?: { tarball?: unknown; integrity?: unknown } }>;
}

/** The version to install: the one named (exactly), or `latest`; its tarball URL and SHA-512. */
export function npmVersionOf(meta: unknown, name: string, version?: string): { version: string; tarball: string; sha512: string } {
  const m = meta as NpmMeta;
  const v = version ?? m["dist-tags"]?.latest;
  if (v === undefined || !SemverVersion.safeParse(v).success) throw new ContractError("not_found", `${name} has no ${version === undefined ? "latest version" : `version ${version}`} Clover can install`);
  const dist = m.versions?.[v]?.dist;
  if (dist === undefined) throw new ContractError("not_found", `${name} ${v} isn't on npm`);
  if (typeof dist.tarball !== "string" || !dist.tarball.startsWith("https://")) throw new ContractError("invalid", `${name} ${v} has no https tarball`);
  const integrity = typeof dist.integrity === "string" ? dist.integrity.split(/\s+/).find((x) => x.startsWith("sha512-")) : undefined;
  if (integrity === undefined) throw new ContractError("invalid", `${name} ${v} has no SHA-512 integrity record, so its bytes can't be checked`);
  const sha512 = Buffer.from(integrity.slice("sha512-".length), "base64").toString("hex");
  if (sha512.length !== 128) throw new ContractError("invalid", `${name} ${v}'s integrity record isn't a SHA-512`);
  return { version: v, tarball: dist.tarball, sha512 };
}

export interface NpmInstallOptions extends InstallTarget {
  client: IndexClient;
  revocations?: Revocations;
  name: string;
  version?: string;
  registry?: string;
  signal?: AbortSignal;
}

/** npm's record of a package (its metadata), over the pinned fetch. */
export async function npmMetadata(client: IndexClient, name: string, registry?: string, signal?: AbortSignal): Promise<unknown> {
  try {
    return JSON.parse(new TextDecoder().decode(await client.fetchBytes(npmPackageUrl(name, registry), INDEX_MAX_BYTES, signal, NPM_ACCEPT)));
  } catch (err) {
    if (err instanceof ContractError) throw err;
    throw new ContractError("failed", `${name} couldn't be looked up on npm: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`);
  }
}

/** Downloads a version's tarball, checks it against npm's integrity record, and unpacks it into `stageDir/<its
 *  manifest's id>` (a plugin's folder is named by its id, which validation checks). Gives back the folder. */
export async function stageNpmVersion(client: IndexClient, name: string, v: { version: string; tarball: string; sha512: string }, stageDir: string, signal?: AbortSignal): Promise<string> {
  let bytes: Uint8Array;
  try {
    bytes = await client.download(v.tarball, DOWNLOAD_MAX_BYTES, signal);
  } catch (err) {
    throw new ContractError("failed", `${name} ${v.version} couldn't be downloaded: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`);
  }
  if (createHash("sha512").update(bytes).digest("hex") !== v.sha512) throw new ContractError("invalid", `${name} ${v.version}'s download doesn't match npm's integrity record`);
  const unpacked = unpackTarGz(bytes, join(stageDir, "unpacked"));
  let id: unknown;
  try {
    id = (JSON.parse(readFileSync(join(unpacked, MANIFEST_FILE), "utf8")) as { id?: unknown }).id;
  } catch {
    throw new ContractError("invalid", `${name} ${v.version}'s ${MANIFEST_FILE} isn't JSON`);
  }
  if (typeof id !== "string" || !TopPluginId.safeParse(id).success) throw new ContractError("invalid", `${name} ${v.version}'s ${MANIFEST_FILE} names no plugin id`);
  const root = join(stageDir, id);
  renameSync(unpacked, root);
  return root;
}

export async function installFromNpm(o: NpmInstallOptions): Promise<{ id: string; folder: string; treeHash: string; npm: { name: string; version: string } }> {
  if (o.version !== undefined && !SemverVersion.safeParse(o.version).success) throw new ContractError("invalid", "an npm version is named exactly (1.2.3); ranges aren't resolved");
  const v = npmVersionOf(await npmMetadata(o.client, o.name, o.registry, o.signal), o.name, o.version);
  const stage = newStage(o.stagingDir);
  try {
    const root = await stageNpmVersion(o.client, o.name, v, stage.dir, o.signal);
    const npm = { name: o.name, version: v.version };
    const done = await installStaged(root, o, {
      version: v.version, from: { npm },
      check: (id, treeHash) => {
        const blocked = o.revocations?.blockedOf({ id, treeHash, version: v.version, provenance: { by: "user-app", at: 0, npm } });
        if (blocked !== undefined) throw new ContractError("refused", `${o.name} ${v.version} isn't installed: ${blocked}`);
      },
    });
    return { ...done, npm };
  } finally {
    stage.done();
  }
}
