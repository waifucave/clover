// WS-21 (spec §4.2, §4.3): where an approval card's "always" answers are saved — claude's own locations,
// in claude's grammar, so both runtimes read them natively from the run folder's settings tiers:
//
//   "Allow … everywhere"        → `<home>/sdk/settings.json` `permissions.allow` (the user tier)
//   "Allow … in this project"   → `<root>/.clover/settings.local.json` `permissions.allow` (the local tier,
//                                 F17 — anchored at the canonical git root), offered and written ONLY for a
//                                 TRUSTED project; then `**\/.clover/settings.local.json` joins the user's
//                                 global git excludes (F21) so the file never lands in a commit.
//
// The daemon writes both files; the router refuses any `updatedPermissions` destination other than
// `session` (so claude itself never writes `.claude/settings.local.json` into the repo). The retired
// stores — `<home>/permissions/projects.json` (the approved-rules record) and a project's
// `.clover/permissions.local.json` — are no longer written; `clover doctor` reports what is left in them
// and `clover migrate-project` moves it.
import { lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { sdkAllowRulesFor } from "../runtime-sdk/mode-options";
import { updateSdkSettings, writeJsonAtomic } from "../sdk-files";
import { ensureGlobalGitExclude } from "./git-exclude";

/** A saved answer that was refused — the approval itself still resolves (the caller logs this). */
export class SavedAnswerRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SavedAnswerRefused";
  }
}

/** Clover's rule → claude's grammar (`sdkAllowRulesFor`: never wider than what was saved). A rule the
 *  runtimes cannot apply (a writable-directory `Edit(<dir>)`, a refused shape) is refused, not saved. */
function claudeRulesFor(cloverRule: string): string[] {
  const rules = sdkAllowRulesFor([cloverRule]);
  if (rules.length === 0) throw new SavedAnswerRefused(`"${cloverRule}" is not a rule the runtimes can apply, so it was not saved`);
  return rules;
}

function withAllowed(allow: unknown, rules: readonly string[]): string[] {
  const out = Array.isArray(allow) ? allow.filter((r): r is string => typeof r === "string") : [];
  for (const r of rules) if (!out.includes(r)) out.push(r);
  return out;
}

/** "Allow … everywhere": atomic, deduped, every other key of the user's file preserved. Returns the
 *  claude-grammar rules written. Throws `SavedAnswerRefused`/`SdkFileUnreadable`. */
export function saveAnswerEverywhere(home: string, cloverRule: string): string[] {
  const rules = claudeRulesFor(cloverRule);
  updateSdkSettings(home, (s) => ({ ...s, permissions: { ...(s.permissions ?? {}), allow: withAllowed(s.permissions?.allow, rules) } }));
  return rules;
}

const canonical = (p: string): string => {
  try { return realpathSync(p); } catch { return p; }
};

/**
 * "Allow … in this project": `<root>/.clover/settings.local.json`, the local settings tier. `root` is the
 * project's canonical git root (the tier's anchor, F17) — or its project root outside a repository.
 * Refused, and nothing written, when:
 *  - the project is not trusted (the card never offers it then; this is the second door);
 *  - `root` is the Clover home or inside it (Clover's own state is never "a project");
 *  - `<root>/.clover` or the file itself is a symbolic link (a planted link must never redirect the
 *    write — the same guard the retired `permissions.local.json` writer had);
 *  - the file exists but is not a JSON object (a hand-edited file is never clobbered).
 * Atomic (temp + rename), deduped, every other key preserved. Then the global git exclude (best-effort).
 */
export function saveAnswerInProject(opts: { root: string; cloverHome: string; trusted: boolean }, cloverRule: string): { path: string; rules: string[] } {
  if (!opts.trusted) throw new SavedAnswerRefused(`${opts.root} is not a trusted project, so an "in this project" answer is not saved there`);
  const root = canonical(opts.root);
  const home = canonical(opts.cloverHome);
  if (root === home || root.startsWith(home.endsWith(sep) ? home : home + sep)) {
    throw new SavedAnswerRefused(`refusing to save a project rule for ${root} — it is the Clover home itself or inside it`);
  }
  const rules = claudeRulesFor(cloverRule);
  const dotClover = join(root, ".clover");
  const path = join(dotClover, "settings.local.json");
  const linkAt = (p: string): boolean => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };
  if (linkAt(dotClover)) throw new SavedAnswerRefused(`refusing to save a project rule — ${dotClover} is a symbolic link, not a real directory`);
  mkdirSync(dotClover, { recursive: true });
  if (linkAt(path)) throw new SavedAnswerRefused(`refusing to save a project rule — ${path} is a symbolic link, not a real file`);
  let current: Record<string, unknown> = {};
  let raw: string | undefined;
  try { raw = readFileSync(path, "utf8"); } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (raw !== undefined) {
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { parsed = undefined; }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new SavedAnswerRefused(`${path} is not a readable JSON object — it was left untouched, and the answer was not saved`);
    }
    current = parsed as Record<string, unknown>;
  }
  const permissions = (current.permissions !== null && typeof current.permissions === "object" && !Array.isArray(current.permissions))
    ? current.permissions as Record<string, unknown>
    : {};
  writeJsonAtomic(path, { ...current, permissions: { ...permissions, allow: withAllowed(permissions.allow, rules) } });
  ensureGlobalGitExclude(root);
  return { path, rules };
}
