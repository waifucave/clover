// The binaries MOSS ships beside its core, and the code identities they are signed under: one source, shared by the
// core's runtime checks (`registry/plugin-run.ts`'s `pluginBun`) and lane M's packaging and signing (#244), so the
// requirement the core checks and the signature the release makes can't drift apart.
/** The Apple developer team MOSS's apps and shipped binaries are signed by (`apple/Winter/project.yml`'s
 *  `DEVELOPMENT_TEAM`). This module imports nothing, so scripts and the guard's checks read it anywhere. */
export const MOSS_TEAM_ID = "37N77U9RSZ";

/** The bundle identifiers of the product's three programs per profile (spec revision 19, §3.1, item 120): MOSS Code
 *  (today's app: `apps/desktop/electron-builder.yml`'s `appId`, and the dev app `bun run dev:app` signs), MOSS, and the
 *  background host (a nested helper with one fixed identifier, the same in both apps). The same table as the protocol's
 *  `PROGRAM_IDENTIFIERS` (a test holds them equal); kept here because this module imports nothing. */
export const MOSS_PROGRAM_IDENTIFIERS = {
  code: { dist: "com.waifucave.moss.code", dev: "com.waifucave.moss.code.dev" },
  moss: { dist: "com.waifucave.moss", dev: "com.waifucave.moss.dev" },
  host: { dist: "com.waifucave.moss.host", dev: "com.waifucave.moss.host.dev" },
} as const;
export type MossProgramName = keyof typeof MOSS_PROGRAM_IDENTIFIERS;

/** MOSS Code's bundle identifier per profile (the packaged app and the dev app). */
export const MOSS_APP_IDENTIFIER = MOSS_PROGRAM_IDENTIFIERS.code;

/** A Developer ID Application leaf: Apple's Developer ID intermediate (OID 1.2.840.113635.100.6.2.6) under the anchor,
 *  and the leaf's Developer ID Application extension (1.2.840.113635.100.6.1.13). An Apple Development certificate of
 *  the same team has neither. */
export const DEVELOPER_ID_CLAUSES = "certificate 1[field.1.2.840.113635.100.6.2.6] and certificate leaf[field.1.2.840.113635.100.6.1.13]";

/** The code requirement the process on the other end of an `app` connection must satisfy on macOS to be `program` (the
 *  caller check, `platform/peer-signature.ts`; MOSS Code by default): that program's identifier for the profile, Apple's
 *  chain, MOSS's team, and for dist a Developer ID leaf (`developerId`, on by default for dist). Dev keeps Apple's chain
 *  and the team, which an Apple Development identity of the team meets. Unsigned, ad hoc or another team's code never
 *  passes. */
export function appRequirement(profile: "dist" | "dev", team: string = MOSS_TEAM_ID, developerId: boolean = profile === "dist", program: MossProgramName = "code"): string {
  if (!/^[A-Z0-9]{10}$/.test(team)) throw new Error(`not a team identifier: ${team}`);
  return `identifier "${MOSS_PROGRAM_IDENTIFIERS[program][profile]}" and anchor apple generic${developerId ? ` and ${DEVELOPER_ID_CLAUSES}` : ""} and certificate leaf[subject.OU] = "${team}"`;
}

/** The Bun plugin code runs on (#234's check 5, K1): its own binary, never the core's, so no Keychain item's access
 *  list (which names `moss-core` alone) lets plugin code in. */
export const PLUGIN_BUN_FILE = "moss-plugin-bun";
export const PLUGIN_BUN_IDENTIFIER = { dist: "com.waifucave.moss.core.plugin-bun", dev: "com.waifucave.moss.core.plugin-bun.dev" } as const;

/** The process holder (lane A's seam, lane M's startup check), beside the core. */
export const PROCESS_HOLDER_FILE = "moss-process-holder";
export const PROCESS_HOLDER_IDENTIFIER = { dist: "com.waifucave.moss.core.process-holder", dev: "com.waifucave.moss.core.process-holder.dev" } as const;

/** The link sidecar (native/link), beside the core: the engine hands it the device key and starts it itself. Signed under its
 *  own identifier by the release build (`scripts/release/lib.ts`'s `RESOURCE_BINARIES`, which a test holds to this). */
export const LINK_FILE = "moss-link";
export const LINK_IDENTIFIER = { dist: "com.waifucave.moss.core.link", dev: "com.waifucave.moss.core.link.dev" } as const;

/** The files a MOSS app bundle ships in its `daemon/` folder besides `moss-core`, each with the identifier it is signed
 *  under (dist, dev): the set the engine copy places beside the engine (`update/engine-copy.ts`) and the set
 *  `scripts/try/verify.sh` holds a build's `Resources/daemon/` to. The process holder is macOS's alone. `.exe` names on
 *  Windows. A file that is in the bundle and not here is a file the copy would not place: the verify check says so. */
export function engineSidecars(platform: NodeJS.Platform = process.platform): { file: string; identifier: { readonly dist: string; readonly dev: string } }[] {
  const exe = platform === "win32" ? ".exe" : "";
  return [
    { file: `${PLUGIN_BUN_FILE}${exe}`, identifier: PLUGIN_BUN_IDENTIFIER },
    { file: `${LINK_FILE}${exe}`, identifier: LINK_IDENTIFIER },
    ...(platform === "darwin" ? [{ file: PROCESS_HOLDER_FILE, identifier: PROCESS_HOLDER_IDENTIFIER }] : []),
  ];
}

/** The designated requirement a shipped plugin Bun must satisfy on macOS: Apple's anchor, MOSS's team, its own
 *  identifier. Nothing but a binary MOSS's team signed under that identifier passes it. */
export function pluginBunRequirement(team: string = MOSS_TEAM_ID): string {
  if (!/^[A-Z0-9]{10}$/.test(team)) throw new Error(`not a team identifier: ${team}`);
  return `anchor apple generic and identifier "${PLUGIN_BUN_IDENTIFIER.dist}" and certificate leaf[subject.OU] = "${team}"`;
}
