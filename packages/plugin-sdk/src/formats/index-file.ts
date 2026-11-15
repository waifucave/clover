// Index format 1 (spec §5.1 "Indexes and npm"): a plain JSON list of plugins, each id with its versions, each version
// with its tree hash and download URL. A user adds an index by its https URL. It is not signed and Clover keeps no
// official one (the owner's ruling, 2026-11-13): what keeps a user safe is each plugin's own OK card, and the tree hash,
// which the download must match.
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
