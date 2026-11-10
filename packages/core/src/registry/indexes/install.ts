// Installing a plugin from an index (spec §5.1): the version the index lists (its newest, or the one named), downloaded
// over https within a cap, unpacked by Clover's own reader (`unpack.ts`) into a staging folder, validated, and
// installed only if its id and tree hash are the ones the signed index lists. A tree a revocation list names is never
// downloaded. Like every install, it then waits for its sealed OK card.
import { join } from "node:path";
import { ContractError } from "../../contracts/common";
import { installStaged, newStage, type InstallTarget } from "../install-folder";
import type { IndexClient } from "./client";
import type { Revocations } from "./revocations";
import { unpackTarGz } from "./unpack";

/** The largest download taken (compressed); what it unpacks to is bounded as a folder install. */
export const DOWNLOAD_MAX_BYTES = 256 * 1024 * 1024;

export interface IndexInstallOptions extends InstallTarget {
  client: IndexClient;
  revocations?: Revocations;
  id: string;
  version?: string;
  /** The index to take it from; default the first that lists it, the official one first. */
  index?: string;
  adultConfirmed: boolean;
  signal?: AbortSignal;
}

export async function installFromIndex(o: IndexInstallOptions): Promise<{ id: string; folder: string; treeHash: string; index: { url: string; version: string } }> {
  const e = o.client.find(o.id, { ...(o.version !== undefined ? { version: o.version } : {}), ...(o.index !== undefined ? { index: o.index } : {}), adultConfirmed: o.adultConfirmed });
  if (e === undefined) throw new ContractError("not_found", `${o.id}${o.version !== undefined ? ` ${o.version}` : ""} isn't in your plugin indexes`);
  if (o.taken(o.id)) throw new ContractError("conflict", `${o.id} is already installed; updating it is plugin.update`);
  const blocked = o.revocations?.blockedOf({ id: o.id, treeHash: e.hash, version: e.version, provenance: { by: "user-app", at: 0, index: { url: e.index, version: e.version } } });
  if (blocked !== undefined) throw new ContractError("refused", `${o.id} ${e.version} isn't installed: ${blocked}`);
  let bytes: Uint8Array;
  try {
    bytes = await o.client.download(e.url, DOWNLOAD_MAX_BYTES, o.signal);
  } catch (err) {
    throw new ContractError("failed", `${o.id} ${e.version} couldn't be downloaded: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`);
  }
  const stage = newStage(o.stagingDir);
  try {
    const root = unpackTarGz(bytes, join(stage.dir, o.id));
    const done = await installStaged(root, o, { id: o.id, treeHash: e.hash });
    return { ...done, index: { url: e.index, version: e.version } };
  } finally {
    stage.done();
  }
}
