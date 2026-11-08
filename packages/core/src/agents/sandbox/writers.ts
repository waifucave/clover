// The fenced set in each agent's own sandbox format (spec §9.3 "The fence reaches agents through their own settings";
// spike S8 §8.3). A writer is pure: the session's `SandboxPolicy` (the manager's `withHomeDenied(agentPolicyOf(…))`,
// so the whole Clover home is denied) in, the backend's own settings out, nothing written to the user's own config.
//
// Admission is separate (admission.ts): a writer here does not make a backend "protected". Its rows stay `unverified`
// until the live gates in `live-gates.ts` pass for the exact backend, OS and version.
//
// * **Codex** (`codex-acp`, which drives the user's own `codex app-server`): a permissions profile, `clover`, handed in
//   `CODEX_CONFIG` (JSON merged into the session's config, S5 §3) and made the default with `default_permissions`. The
//   user's `CODEX_HOME` and login are untouched. Its filesystem table is the shape S8's Codex probe passed with
//   (`":root" = "read"`, write folders `"write"`, denied folders `"deny"`), and its network is off.
// * **Claude Code** (`claude-agent-acp`): `_meta.claudeCode.options` at `session/new`, which the adapter spreads into
//   the Claude Agent SDK's options. `sandbox` with the fence's folders, no way out of it (`allowUnsandboxedCommands:
//   false`, no excluded commands, fail if it can't start), and the file tools' deny rules in the flag settings layer.
//
// Pattern items (`<home>/bots/*/memory`) are written as literal folders: dropped where a literal denial already holds
// them (the Clover home does, for an agent), and otherwise widened to the folder above their first `*`. Widening only
// denies more, so a vendor's glob support is never relied on.
import { ContractError } from "../../contracts/common";
import type { SandboxPolicy } from "../../contracts/fence";
import { agentPolicyOf, fileToolDenials } from "../memory";
import type { SandboxWriter } from "./admission";

/** The Codex permissions profile Clover's writer names. */
export const CODEX_PROFILE = "clover";

/** A policy's denials with every pattern item written as a literal folder (see above). */
export function literalDenials(policy: SandboxPolicy): { denyRead: string[]; denyWrite: string[] } {
  const denyRead = literalOf(policy.denyRead, []);
  // A read-and-write denial holds a write denial's pattern too.
  const denyWrite = literalOf(policy.denyWrite, denyRead);
  return { denyRead, denyWrite };
}

function literalOf(items: readonly string[], alsoHeld: readonly string[]): string[] {
  const literal = items.filter((p) => !p.includes("*")).map(trimEnd).filter((p) => p !== "");
  const out = [...literal];
  for (const pattern of items.filter((p) => p.includes("*"))) {
    const prefix = trimEnd(patternPrefix(pattern));
    if ([...literal, ...alsoHeld].some((held) => holds(held, prefix))) continue;
    // A pattern with no folder above its first `*` can't be widened safely: refused, never dropped.
    if (prefix === "" || /^[A-Za-z]:$/.test(prefix)) throw refused(`the fence's pattern ${pattern} has no folder to deny`);
    out.push(prefix);
  }
  return [...new Set(out)];
}

/** The folder above a pattern's first `*` segment (`/h/bots/*\/memory` → `/h/bots`). */
function patternPrefix(pattern: string): string {
  const sep = pattern.includes("\\") && !pattern.includes("/") ? "\\" : "/";
  const segs = pattern.split(/[\\/]/);
  const at = segs.findIndex((s) => s.includes("*"));
  return segs.slice(0, at).join(sep);
}

function trimEnd(p: string): string {
  return p.length > 1 ? p.replace(/[\\/]+$/, "") : p;
}

/** Whether `folder` holds `path` (or is it), compared exactly: a case or form mismatch widens rather than drops. */
function holds(folder: string, path: string): boolean {
  const f = folder.replace(/\\/g, "/"), p = path.replace(/\\/g, "/");
  return p === f || p.startsWith(f.endsWith("/") ? f : `${f}/`);
}

function refused(why: string): ContractError {
  return new ContractError("refused", `the agent's sandbox couldn't be written: ${why}, so the agent wasn't started`);
}

/** What every writer checks first: an agent's policy (never a bot's own memory) with no network. */
function checked(policy: SandboxPolicy): SandboxPolicy {
  const p = agentPolicyOf(policy);
  // `filtered` would need the blocked addresses in the vendor's format, which neither writer has yet.
  if (p.network !== "none") throw refused(`its network is ${p.network}, and only "none" is written`);
  return p;
}

/** The writable folders: the policy's, or the session's root where the policy names none (as clover-code does). */
function writable(policy: SandboxPolicy, root: string): string[] {
  return policy.allowWrite.length > 0 ? policy.allowWrite.map(trimEnd) : [root];
}

/** Codex's permissions profile for the policy: `:root` readable, the write folders writable, write-denied folders
 *  read-only, read-denied folders denied outright; no network. A path keeps its strictest access, and an entry inside
 *  a stricter folder is left out: a more specific entry must never reopen what a folder above it closes (a read-only
 *  `credentials` inside the denied Clover home would make it readable where the most specific entry wins). */
export function codexProfile(policy: SandboxPolicy, root: string): { filesystem: Record<string, "read" | "write" | "deny">; network: { enabled: false } } {
  const p = checked(policy);
  const { denyRead, denyWrite } = literalDenials(p);
  const access = new Map<string, "read" | "write" | "deny">();
  const set = (path: string, a: "read" | "write" | "deny") => {
    const cur = access.get(path);
    if (cur === undefined || STRICTNESS[a] > STRICTNESS[cur]) access.set(path, a);
  };
  for (const w of writable(p, root)) set(w, "write");
  for (const d of denyWrite) set(d, "read");
  for (const d of denyRead) set(d, "deny");
  const filesystem: Record<string, "read" | "write" | "deny"> = { ":root": "read" };
  for (const [path, a] of access) {
    const closedAbove = [...access].some(([other, b]) => other !== path && holds(other, path) && STRICTNESS[b] >= STRICTNESS[a]);
    if (!closedAbove) filesystem[path] = a;
  }
  return { filesystem, network: { enabled: false } };
}

const STRICTNESS = { write: 0, read: 1, deny: 2 } as const;

/** Codex: the profile in `CODEX_CONFIG`, made the session's default. */
export const codexWriter: SandboxWriter = (policy, { root }) => ({
  env: { CODEX_CONFIG: JSON.stringify({ default_permissions: CODEX_PROFILE, permissions: { [CODEX_PROFILE]: codexProfile(policy, root) } }) },
});

/** The Claude Agent SDK's `sandbox` and flag settings for the policy. */
export function claudeCodeOptions(policy: SandboxPolicy, root: string): Record<string, unknown> {
  const p = checked(policy);
  const { denyRead, denyWrite } = literalDenials(p);
  return {
    sandbox: {
      enabled: true,
      // No sandbox, no session: never a warning and an unsandboxed shell.
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: false,
      // `dangerouslyDisableSandbox` ignored, and nothing run outside it.
      allowUnsandboxedCommands: false,
      excludedCommands: [],
      enableWeakerNestedSandbox: false,
      enableWeakerNetworkIsolation: false,
      filesystem: { allowWrite: writable(p, root), denyWrite: [...new Set([...denyWrite, ...denyRead])], denyRead },
      network: { allowedDomains: [], allowLocalBinding: false, allowAllUnixSockets: false, allowUnixSockets: [] },
    },
    settings: {
      permissions: {
        // The file tools, which the sandbox doesn't hold, get the same denials; the closed doors as Bash rules too,
        // though a prefix rule is no fence (the gate checks the sandbox refuses them).
        deny: [...fileToolDenials(denyRead, denyWrite), ...p.closedDoors.map((d) => `Bash(${d}:*)`)],
      },
    },
  };
}

/** Claude Code: `_meta.claudeCode.options` at `session/new`. */
export const claudeCodeWriter: SandboxWriter = (policy, { root }) => ({
  meta: { claudeCode: { options: claudeCodeOptions(policy, root) } },
});

/** The writers, by backend id. A writer is used only where its backend's row is `protected` (admission.ts). */
export const WRITERS: Readonly<Record<string, SandboxWriter>> = {
  codex: codexWriter,
  "claude-code": claudeCodeWriter,
};
