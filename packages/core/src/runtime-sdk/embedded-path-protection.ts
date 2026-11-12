import { readdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { canonicalizeForWrite, resolveLeafSymlinks } from "../agent/paths";
import { escapeSandboxGlobPath } from "./host";
import { homeFenceFor } from "./home-fence";
import { hostStorageReadPatterns } from "./host-storage-fence";

/** Trusted Worker lifecycle policy. Never serialized into model settings, RuntimeConfig or env. */
export interface EmbeddedHostPathProtection {
  revision: number;
  denyReadPaths: readonly string[];
  denyWritePaths: readonly string[];
}
export interface EmbeddedProtectionCoverage {
  fileTools: readonly string[];
  ordinarySandboxPathChecks: boolean;
  approvedEscapesKeepMainBehavior: boolean;
  contextReadChecksVersion: number;
  sourceReaderFamilies?: readonly string[];
}
export interface EmbeddedProtectionCapability {
  contractVersion: number;
  capability: string;
  coverage: EmbeddedProtectionCoverage;
}
/** Independently accepted nine-family context/cache contract at SDK 1971f9a6 (Claude45).
 * Namespace/version/family checks still apply; package pins remain a separate release requirement. */
export const ACCEPTED_EMBEDDED_CONTEXT_VERSION: number = 1;
const REQUIRED_SOURCE_FAMILIES = ["instructions-imports-memory", "rules", "output-styles", "settings-mcp", "skills", "agent-definitions", "plugin-components-manifests-installed", "commands", "workflow-source"];
const REQUIRED_FILE_TOOLS = ["Read", "Write", "Edit", "NotebookEdit", "Glob", "Grep"];
export function embeddedFileProtectionSupported(value: EmbeddedProtectionCapability | undefined): boolean {
  return !!value?.coverage && Array.isArray(value.coverage.fileTools) && value.contractVersion === 1 && value.capability === "host-code-path-protection-v1"
    && value.coverage.ordinarySandboxPathChecks === true
    && value.coverage.approvedEscapesKeepMainBehavior === true
    && REQUIRED_FILE_TOOLS.every(tool => value.coverage.fileTools.includes(tool));
}
/** Read/Write alone does not authorize in-process instruction/settings/Skill/plugin readers. */
export function embeddedContextProtectionSupported(value: EmbeddedProtectionCapability | undefined, acceptedVersion = ACCEPTED_EMBEDDED_CONTEXT_VERSION): boolean {
  return acceptedVersion === 1 && embeddedFileProtectionSupported(value) && value?.coverage.contextReadChecksVersion === 1
    && Array.isArray(value.coverage.sourceReaderFamilies) && REQUIRED_SOURCE_FAMILIES.every(family => value.coverage.sourceReaderFamilies!.includes(family));
}
const spellings = (path: string): string[] => {
  const out = [resolve(path)];
  try { out.push(canonicalizeForWrite(resolveLeafSymlinks(resolve(path)))); } catch { /* literal still protects */ }
  return [...new Set(out)].map(escapeSandboxGlobPath);
};
/** The host protection with a bot's workshop opened (the coordinator's ruling for the owner's plugin-building test: the
 *  try-14c row 48 Edit came back "protected host path access refused"): `<home>/plugins` is write-denied whole for
 *  every Worker (`selfGrantDenyWrite`), so a session's own sandbox can't open a plugin there however it is drawn. For a
 *  session whose sandbox names one of `workshop` (the plugins a bot built, `provenance {by: "bot", bot}`) as a write
 *  root, the whole-folder entry is replaced by each of its OTHER entries: that plugin's folder is the only one the
 *  host protection lets its file tools into. Everything else stays: every other plugin, `node_modules` above them
 *  (`pluginLoadDenies`), and the rest of the list. A name made new in `<home>/plugins` is still refused to that
 *  session by its own sandbox (no write root holds it) and by the fence (`plugins`). */
export function withWorkshopOpen(policy: EmbeddedHostPathProtection, home: string, roots: readonly string[], workshop: readonly string[]): EmbeddedHostPathProtection {
  const real = (p: string): string => { try { return realpathSync(p); } catch { return resolve(p); } };
  const plugins = real(join(home, "plugins"));
  const fold = (p: string) => (process.platform === "darwin" || process.platform === "win32" ? p.toLowerCase() : p);
  const built = new Set(workshop.map((w) => fold(real(w))));
  // A write root of this session's that is a plugin folder directly in `<home>/plugins` and one a bot built.
  const open = roots.map(real).filter((r) => fold(dirname(r)) === fold(plugins) && built.has(fold(r)));
  // The drop: a bot session whose sandbox holds the plugins folder itself as a write root makes new folders there; the
  // entries already there are denied by name all the same (but its own).
  const drop = roots.some((r) => fold(real(r)) === fold(plugins));
  if (open.length === 0 && !drop) return policy;
  const whole = new Set(spellings(join(home, "plugins")));
  let names: string[];
  try { names = readdirSync(plugins); } catch { return policy; } // can't be listed: the whole folder stays denied
  const openNames = new Set(open.map((r) => fold(r.slice(plugins.length + 1))));
  const others = names.filter((n) => !openNames.has(fold(n))).flatMap((n) => spellings(join(plugins, n)));
  const denyWritePaths = [...new Set([...policy.denyWritePaths.filter((p) => !whole.has(p)), ...others])].sort();
  return Object.freeze({ ...policy, denyWritePaths: Object.freeze(denyWritePaths) });
}

export function embeddedHostPathProtection(home: string, revision: number): EmbeddedHostPathProtection {
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error("invalid host path-policy revision");
  const fence = homeFenceFor(home);
  const reads = hostStorageReadPatterns(home).flatMap(({ root, tail }) => spellings(root).map(path => tail === "**" ? path : `${path}/${tail}`));
  const writes = [...fence.dirs, ...fence.files].flatMap(spellings);
  return Object.freeze({ revision,
    denyReadPaths: Object.freeze([...new Set(reads)].sort()),
    denyWritePaths: Object.freeze([...new Set(writes)].sort()),
  });
}
