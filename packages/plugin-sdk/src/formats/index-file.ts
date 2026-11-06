// Index format 1 and revocation list format 1 (spec §5.1 "Indexes and npm"). An index is a JSON file listing ids and
// versions, each with its tree hash and download URL; a revocation list names an id, with all its versions or listed
// hashes, and a reason. Both are signed with Ed25519 over their exact bytes, in a `.sig` file beside them. The
// official index's key ships in the app; another index is added by URL with its key and a warning.
import { z } from "zod";
import { SemverVersion, TopPluginId, TreeHash, utf16 } from "@waifucave/clover-protocol";
import { Text, Url } from "../manifest/fields";

export const IndexSchema = z.strictObject({
  $schema: utf16(2048).optional(),
  index: z.literal(1),
  name: utf16(200, 1),
  plugins: z.array(z.strictObject({
    id: TopPluginId,
    name: Text.optional(),
    description: Text.optional(),
    adult: z.boolean().optional(),
    /** A version downloads as a `.tar.gz` whose tree hash must match. */
    versions: z.array(z.strictObject({ version: SemverVersion, hash: TreeHash, url: Url })).min(1).max(10_000),
  })).max(100_000),
});
export type IndexFile = z.infer<typeof IndexSchema>;

export const RevocationsSchema = z.strictObject({
  $schema: utf16(2048).optional(),
  revocations: z.literal(1),
  entries: z.array(z.strictObject({
    id: TopPluginId,
    /** Revoked versions; with neither `versions` nor `hashes`, every version is. */
    versions: z.array(SemverVersion).max(10_000).optional(),
    hashes: z.array(TreeHash).max(10_000).optional(),
    reason: utf16(2000, 1),
  })).max(100_000),
});
export type RevocationsFile = z.infer<typeof RevocationsSchema>;

/** The app checks the revocation list at start and every 6 hours (§5.1). */
export const REVOCATION_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** The signature file's name beside a signed file. */
export function signatureFileFor(file: string): string {
  return `${file}.sig`;
}

/** A `.sig` file holds the 64-byte Ed25519 signature over the signed file's exact bytes, as one line of base64. */
export function parseSignatureFile(text: string): Uint8Array | null {
  const line = text.trim();
  if (!/^[A-Za-z0-9+/]{86}==$/.test(line)) return null;
  const bin = atob(line);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.length === 64 ? out : null;
}

/** Whether a plugin's version or tree is revoked by a list. */
export function isRevoked(list: RevocationsFile, id: string, version: string, hash: string): { revoked: false } | { revoked: true; reason: string } {
  for (const e of list.entries) {
    if (e.id !== id) continue;
    const all = e.versions === undefined && e.hashes === undefined;
    if (all || e.versions?.includes(version) || e.hashes?.includes(hash)) return { revoked: true, reason: e.reason };
  }
  return { revoked: false };
}
