// The official plugin index (spec §5.1, §14.2 item 25): its URL, the Ed25519 keys it is trusted under, and its issue
// page for "Report" (§5.7). Whether an official index exists at launch is the owner's answer, so this is empty until
// he gives one: the app then ships with no index, and the user may add others by URL with their keys.
//
// A key is rotated by shipping the new one beside the old (`keys` is a list); the old one is dropped once the index is
// signed with the new one. No real key belongs anywhere else in the repo: tests make their own.

export interface IndexTrust {
  /** The index file's https URL; its signature is `<url>.sig`. */
  readonly url: string;
  /** The Ed25519 public keys (hex, 32 bytes) a signature may be made with: any one verifies. */
  readonly keys: readonly string[];
  /** Where to report a plugin (the index's issue page); the app fills in the plugin's id and tree hash. */
  readonly issues?: string;
}

export const OFFICIAL_INDEX: IndexTrust | undefined = undefined;

/** The "Report" link for a plugin (§5.7, the controller's ruling): the official index's issue page with the plugin's id
 *  and tree hash filled in, or undefined when there is no official index. */
export function reportUrl(id: string, treeHash: string | undefined, official: IndexTrust | undefined = OFFICIAL_INDEX): string | undefined {
  if (official?.issues === undefined) return undefined;
  const u = new URL(official.issues);
  u.searchParams.set("title", `Report: ${id}`);
  u.searchParams.set("body", `Plugin: ${id}\nTree hash: ${treeHash ?? "(unknown)"}\n\nWhat's wrong:\n`);
  return u.href;
}
