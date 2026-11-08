// The fenced set in each agent's own sandbox format (spec §9.3 "The fence reaches agents through their own settings";
// spike S8 §8.3). The session's `SandboxPolicy` (the manager's `withHomeDenied(agentPolicyOf(…))`, so the whole Clover
// home is denied) in, the backend's own settings out, nothing written to the user's own config. A writer reads the disk
// only to add each denial's real path beside the one it was given.
//
// Admission is separate (admission.ts): a writer here does not make a backend "protected". Its rows stay `unverified`
// until the live gates in `live-gates.ts` pass for the exact backend, OS and version.
//
// * **Codex** (`codex-acp`, which drives the user's own `codex app-server`): a permissions profile, `clover`, handed in
//   `CODEX_CONFIG` (JSON merged into the session's config, S5 §3) and made the default with `default_permissions`. The
//   user's `CODEX_HOME` and login are untouched. Its filesystem table is the shape S8's Codex probe passed with
//   (`":root" = "read"`, write folders `"write"`, denied folders `"deny"`), and its network is off.
// * **Claude Code** (`claude-agent-acp`): `_meta.claudeCode.options` at `session/new`, which the adapter spreads into
//   the Claude Agent SDK's options. No settings sources (the user's, the project's and the local files could add
//   excluded commands, allowed domains, hooks, an API key helper, a status line and MCP servers, all run unsandboxed);
//   `sandbox` with the fence's folders and no way out of it; and the file tools' deny rules in the flag settings layer.
//   The adapter sets the permission mode after our options, from the user's own `permissions.defaultMode`, so the
//   session holds a mode floor (`modeFloor`), at its start and at every turn against the level then: never
//   `bypassPermissions`, and `acceptEdits` only while the level accepts edits.
// * **Both** write-deny the vendors' own config, which an agent could otherwise change to weaken its next session:
//   `~/.codex` (and `CODEX_HOME`), `~/.claude` and `~/.claude.json` (and `CLAUDE_CONFIG_DIR`), and `.codex`, `.claude`
//   and `.mcp.json` in the root and every folder above it up to the home.
//
// Pattern items (`<home>/bots/*/memory`) are written as literal folders: dropped where a literal denial already holds
// them (the Clover home does, for an agent), and otherwise widened to the folder above their first `*`. Widening only
// denies more, so a vendor's glob support is never relied on.
import { dirname, isAbsolute, join, relative } from "node:path";
import type { Level } from "@waifucave/clover-protocol";
import { ContractError } from "../../contracts/common";
import type { SandboxPolicy } from "../../contracts/fence";
import type { ModeFloor } from "../acp/session";
import { agentPolicyOf, fileToolDenials, realPathOf } from "../memory";
import type { SandboxContext, SandboxWriter } from "./admission";

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

/** The vendors' own config an agent may not change (see above): the home's, a moved vendor home, and the project
 *  files in the root and every folder above it up to the home (Codex reads `.codex/config.toml` up to the project's
 *  root; Claude Code reads `.claude/` and `.mcp.json` in its working folder). */
export function vendorConfigPaths(ctx: Pick<SandboxContext, "root" | "home" | "env">): string[] {
  const out = [join(ctx.home, ".codex"), join(ctx.home, ".claude"), join(ctx.home, ".claude.json")];
  for (const name of ["CODEX_HOME", "CLAUDE_CONFIG_DIR"]) {
    const v = ctx.env?.[name];
    if (v && isAbsolute(v)) out.push(trimEnd(v));
  }
  const inHome = (d: string) => { const r = relative(ctx.home, d); return r === "" || (!r.startsWith("..") && !isAbsolute(r)); };
  for (let d = ctx.root; ; d = dirname(d)) {
    out.push(join(d, ".codex"), join(d, ".claude"), join(d, ".mcp.json"));
    if (!inHome(d) || d === ctx.home || dirname(d) === d) break;
  }
  return [...new Set(out)];
}

/** Each path, and its real path where that differs (a link, or the disk's own form), so a link's form is covered. */
function withRealForms(paths: readonly string[]): string[] {
  const out: string[] = [];
  for (const p of paths) {
    out.push(p);
    if (!isAbsolute(p)) continue;
    const real = trimEnd(realPathOf(p, "/"));
    if (real !== p) out.push(real);
  }
  return [...new Set(out)];
}

/** A writer's denials: the policy's as literal folders, the vendors' config write-denied, each with its real path. */
export function writerDenials(p: SandboxPolicy, ctx: Pick<SandboxContext, "root" | "home" | "env">): { denyRead: string[]; denyWrite: string[] } {
  const { denyRead, denyWrite } = literalDenials(p);
  return { denyRead: withRealForms(denyRead), denyWrite: withRealForms([...denyWrite, ...vendorConfigPaths(ctx)]) };
}

/** A path for comparing: its real path, `/`-separated and case-folded, so neither a link nor a case variant of a
 *  folder makes an entry inside it look like it's outside. */
function foldKey(path: string): string {
  const real = isAbsolute(path) ? realPathOf(path, "/") : path;
  return trimEnd(real.replace(/\\/g, "/")).toLowerCase();
}

/** Codex's permissions profile for the policy: `:root` readable, the write folders writable, write-denied folders
 *  read-only, read-denied folders denied outright; no network. A path keeps its strictest access, and an entry inside
 *  a stricter folder is left out: a more specific entry must never reopen what a folder above it closes (a read-only
 *  `credentials` inside the denied Clover home would make it readable where the most specific entry wins). */
export function codexProfile(policy: SandboxPolicy, ctx: Pick<SandboxContext, "root" | "home" | "env">): { filesystem: Record<string, "read" | "write" | "deny">; network: { enabled: false } } {
  const p = checked(policy);
  const { denyRead, denyWrite } = writerDenials(p, ctx);
  const access = new Map<string, "read" | "write" | "deny">();
  const set = (path: string, a: "read" | "write" | "deny") => {
    const cur = access.get(path);
    if (cur === undefined || STRICTNESS[a] > STRICTNESS[cur]) access.set(path, a);
  };
  for (const w of writable(p, ctx.root)) set(w, "write");
  for (const d of denyWrite) set(d, "read");
  for (const d of denyRead) set(d, "deny");
  const entries = [...access].map(([path, a]) => ({ path, a, key: foldKey(path) }));
  const filesystem: Record<string, "read" | "write" | "deny"> = { ":root": "read" };
  for (const e of entries) {
    // Left out under any folder at least as strict, compared as folded real paths; at the same folded path, under a
    // stricter entry only (a denial's given and real forms are both written).
    const closedAbove = entries.some((o) => o !== e && holds(o.key, e.key) && (o.key === e.key ? STRICTNESS[o.a] > STRICTNESS[e.a] : STRICTNESS[o.a] >= STRICTNESS[e.a]));
    if (!closedAbove) filesystem[e.path] = e.a;
  }
  return { filesystem, network: { enabled: false } };
}

const STRICTNESS = { write: 0, read: 1, deny: 2 } as const;

/** Codex's mode floor: an allow-list of the modes the live gates showed keep the clover profile, empty until they run.
 *  Codex's modes are sandbox presets of its own and may replace the profile (its plain read-only sandbox reads the
 *  whole disk, the Clover home included), so no mode is counted on unchecked, and there is no fallback to switch to:
 *  failing closed, a Codex session the writer serves is refused at its start, and its read-only switch is never made,
 *  until B2 and B3 pass in a mode and it is listed here. */
export const CODEX_MODE_FLOOR: ModeFloor = { allowed: [] };

/** Codex: the profile in `CODEX_CONFIG`, made the session's default, and its mode floor. */
export const codexWriter: SandboxWriter = (policy, ctx) => ({
  env: { CODEX_CONFIG: JSON.stringify({ default_permissions: CODEX_PROFILE, permissions: { [CODEX_PROFILE]: codexProfile(policy, ctx) } }) },
  modeFloor: () => CODEX_MODE_FLOOR,
});

/** The Claude Agent SDK's `sandbox` and flag settings for the policy. */
export function claudeCodeOptions(policy: SandboxPolicy, ctx: Pick<SandboxContext, "root" | "home" | "env">): Record<string, unknown> {
  const p = checked(policy);
  const { denyRead, denyWrite } = writerDenials(p, ctx);
  return {
    // None of the user's, the project's or the local settings files (the adapter's default is all three).
    settingSources: [],
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
      filesystem: { allowWrite: writable(p, ctx.root), denyWrite: [...new Set([...denyWrite, ...denyRead])], denyRead },
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

/** Whether a level lets an agent's edits through without asking. */
function acceptsEdits(level: Level | undefined): boolean {
  return level === "accept-edits" || level === "automatic";
}

/** Claude Code's mode floor at a level: never `bypassPermissions`; `acceptEdits` only where the level accepts edits. */
export function claudeCodeModeFloor(level: Level | undefined): ModeFloor {
  return { refused: ["bypassPermissions", ...(acceptsEdits(level) ? [] : ["acceptEdits"])], fallback: "default" };
}

/** Claude Code: `_meta.claudeCode.options` at `session/new`, and its mode floor. */
export const claudeCodeWriter: SandboxWriter = (policy, ctx) => ({
  meta: { claudeCode: { options: claudeCodeOptions(policy, ctx) } },
  modeFloor: claudeCodeModeFloor,
});

/** The writers, by backend id. A writer is used only where its backend's row is `protected` (admission.ts). */
export const WRITERS: Readonly<Record<string, SandboxWriter>> = {
  codex: codexWriter,
  "claude-code": claudeCodeWriter,
};
