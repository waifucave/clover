// The binaries Clover ships beside its core, and the code identities they are signed under: one source, shared by the
// core's runtime checks (`registry/plugin-run.ts`'s `pluginBun`) and lane M's packaging and signing (#244), so the
// requirement the core checks and the signature the release makes can't drift apart.
/** The Apple developer team Clover's apps and shipped binaries are signed by (`apple/Winter/project.yml`'s
 *  `DEVELOPMENT_TEAM`). This module imports nothing, so scripts and the guard's checks read it anywhere. */
export const CLOVER_TEAM_ID = "37N77U9RSZ";

/** The Bun plugin code runs on (#234's check 5, K1): its own binary, never the core's, so no Keychain item's access
 *  list (which names `clover-core` alone) lets plugin code in. */
export const PLUGIN_BUN_FILE = "clover-plugin-bun";
export const PLUGIN_BUN_IDENTIFIER = { dist: "com.waifucave.clover.plugin-bun", dev: "com.waifucave.clover.plugin-bun.dev" } as const;

/** The process holder (lane A's seam, lane M's startup check), beside the core. */
export const PROCESS_HOLDER_FILE = "clover-process-holder";
export const PROCESS_HOLDER_IDENTIFIER = { dist: "com.waifucave.clover.process-holder", dev: "com.waifucave.clover.process-holder.dev" } as const;

/** The designated requirement a shipped plugin Bun must satisfy on macOS: Apple's anchor, Clover's team, its own
 *  identifier. Nothing but a binary Clover's team signed under that identifier passes it. */
export function pluginBunRequirement(team: string = CLOVER_TEAM_ID): string {
  if (!/^[A-Z0-9]{10}$/.test(team)) throw new Error(`not a team identifier: ${team}`);
  return `anchor apple generic and identifier "${PLUGIN_BUN_IDENTIFIER.dist}" and certificate leaf[subject.OU] = "${team}"`;
}
