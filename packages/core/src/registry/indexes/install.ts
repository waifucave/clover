// Installing a plugin from an index (spec §5.1): the version the index lists (its newest, or the one named), downloaded
// over https within a cap, unpacked by Clover's own reader (`unpack.ts`) into a staging folder, validated, and
// installed only if its id and tree hash are the ones the index lists (the download must be what the index named). Like
// every install, it then waits for its sealed OK card, which is what decides.
import { join } from "node:path";
import { ContractError } from "../../contracts/common";
import { installStaged, newStage, type InstallTarget } from "../install-folder";
import type { IndexClient } from "./client";
import { unpackTarGz } from "./unpack";

/** The largest download taken (compressed); what it unpacks to is bounded as a folder install. */
export const DOWNLOAD_MAX_BYTES = 256 * 1024 * 1024;

export interface IndexInstallOptions extends InstallTarget {
  client: IndexClient;
  id: string;
  version?: string;
  /** The index to take it from; default the first that lists it, in the order added. */
  index?: string;
  adultConfirmed: boolean;
  signal?: AbortSignal;
}

export async function installFromIndex(o: IndexInstallOptions): Promise<{ id: string; folder: string; treeHash: string; index: { url: string; version: string } }> {
  const e = o.client.find(o.id, { ...(o.version !== undefined ? { version: o.version } : {}), ...(o.index !== undefined ? { index: o.index } : {}), adultConfirmed: o.adultConfirmed });
  if (e === undefined) throw new ContractError("not_found", `${o.id}${o.version !== undefined ? ` ${o.version}` : ""} isn't in your plugin indexes`);
  if (o.taken(o.id)) throw new ContractError("conflict", `${o.id} is already installed; updating it is plugin.update`);
  const stage = newStage(o.stagingDir);
  try {
    const root = await stageIndexVersion(o.client, o.id, e, stage.dir, o.signal);
    const done = await installStaged(root, o, { id: o.id, treeHash: e.hash, version: e.version, from: { index: { url: e.index, version: e.version } } });
    return { ...done, index: { url: e.index, version: e.version } };
  } finally {
    stage.done();
  }
}

/** Downloads a listed version and unpacks it into `stageDir/<id>` (Clover's own reader); the caller validates it. */
export async function stageIndexVersion(client: IndexClient, id: string, e: { version: string; url: string }, stageDir: string, signal?: AbortSignal): Promise<string> {
  let bytes: Uint8Array;
  try {
    bytes = await client.download(e.url, DOWNLOAD_MAX_BYTES, signal);
  } catch (err) {
    throw new ContractError("failed", `${id} ${e.version} couldn't be downloaded: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`);
  }
  return unpackTarGz(bytes, join(stageDir, id));
}
