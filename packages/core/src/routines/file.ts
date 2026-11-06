// A routine is a file (spec §7 "A routine is a file"): Markdown with frontmatter, whose body is the instructions.
// Owner: lane D.
//
// It lives at `home/<Computer>/.clover/routines/<bot>/<name>.md` in the folder tree, which before C5 is
// `<home>/routines/<bot>/<name>.md` on the computer that holds it; that computer runs it. The folder names the bot.
//
// ```markdown
// ---
// id: r_7k2m9q4x1c8v
// name: Morning brief
// triggers:
//   - schedule: "0 8 * * 1-5"
//   - webhook: true
// level: ask-risky        # optional: the computer's level when left out
// timezone: Europe/London # optional: the user's zone when left out
// missed: run-once        # or skip: what to do about runs missed while the computer was off
// ---
// Read my inbox and post a short brief.
// ```
//
// * **The id** is what the same-id rule and the webhook URL use; a file without one gets one when it is loaded.
// * **Secrets stay out:** a webhook's key lives in the credential store, never in the file.
// * A trigger of a plugin's type (`triggers` point) is `{ type: <its type>, …its fields }`.
import { createHash, randomBytes } from "node:crypto";
import { LEVELS, type Level } from "@waifucave/clover-protocol";
import { joinFrontmatter, splitFrontmatter } from "../runtime-sdk/host/run-home/frontmatter";
import { isTimeZone } from "./zone";
import { parseSpec, type RoutineSpec } from "./spec";

export type MissedRule = "run-once" | "skip";

export type RoutineTrigger =
  | { type: "schedule"; spec: string; parsed: RoutineSpec }
  /** `ingress`: the `webhook.ingress` entry it comes in through (an entry id, such as `waifucave`, or a plugin id);
   *  the first one installed when left out. */
  | { type: "webhook"; ingress?: string }
  | { type: string; fields: Record<string, unknown> };

export interface RoutineFile {
  id: string;
  name: string;
  triggers: RoutineTrigger[];
  level?: Level;
  timezone?: string;
  missed: MissedRule;
  /** Waiting for the user's review (a routine carried over from an earlier install, §12). */
  paused?: boolean;
  /** The instructions. */
  body: string;
}

/** The largest routine file read. */
export const ROUTINE_FILE_MAX_BYTES = 256 * 1024;
export const ROUTINE_TRIGGERS_MAX = 32;

export function mintRoutineId(): string {
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
  return `r_${[...randomBytes(12)].map((b) => alphabet[b % alphabet.length]).join("")}`;
}

export function isRoutineId(id: unknown): id is string {
  return typeof id === "string" && /^r_[a-z0-9]{6,40}$/.test(id);
}

/** The file's hash, which a raised level's OK is bound to (§7). */
export function routineHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export type ParseResult = { ok: true; routine: RoutineFile; minted: boolean } | { ok: false; reason: string };

/** Reads a routine file's text. `fallbackName` is its file name without `.md`. */
export function parseRoutine(text: string, fallbackName: string): ParseResult {
  const doc = splitFrontmatter(text);
  if (!doc) return { ok: false, reason: "it has no frontmatter (a `---` block with its triggers)" };
  let meta: unknown;
  try {
    meta = Bun.YAML.parse(doc.lines.join("\n"));
  } catch (err) {
    return { ok: false, reason: `its frontmatter isn't YAML: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (meta === null || meta === undefined) meta = {};
  if (typeof meta !== "object" || Array.isArray(meta)) return { ok: false, reason: "its frontmatter isn't a set of fields" };
  const m = meta as Record<string, unknown>;
  let minted = false;
  let id: unknown = m["id"];
  if (id === undefined) {
    id = mintRoutineId();
    minted = true;
  } else if (!isRoutineId(id)) return { ok: false, reason: `its id "${String(id).slice(0, 60)}" isn't a routine id (r_ and letters and digits)` };
  const name = m["name"] === undefined ? fallbackName : m["name"];
  if (typeof name !== "string" || name.trim() === "" || name.length > 200) return { ok: false, reason: "its name must be text of at most 200 characters" };
  const rawTriggers = m["triggers"] ?? [];
  if (!Array.isArray(rawTriggers)) return { ok: false, reason: "`triggers` must be a list" };
  if (rawTriggers.length > ROUTINE_TRIGGERS_MAX) return { ok: false, reason: `it has more than ${ROUTINE_TRIGGERS_MAX} triggers` };
  const triggers: RoutineTrigger[] = [];
  for (const t of rawTriggers) {
    if (t === null || typeof t !== "object" || Array.isArray(t)) return { ok: false, reason: "each trigger is a set of fields" };
    const tr = t as Record<string, unknown>;
    if (typeof tr["schedule"] === "string") {
      try {
        triggers.push({ type: "schedule", spec: tr["schedule"], parsed: parseSpec(tr["schedule"]) });
      } catch (err) {
        return { ok: false, reason: `its schedule "${tr["schedule"].slice(0, 80)}" doesn't read: ${err instanceof Error ? err.message : String(err)}` };
      }
    } else if (tr["webhook"] === true) {
      const ingress = tr["ingress"];
      if (ingress !== undefined && (typeof ingress !== "string" || !/^[a-z0-9][a-z0-9/._-]{0,127}$/.test(ingress))) return { ok: false, reason: "a webhook's `ingress` names a webhook.ingress entry or its plugin" };
      triggers.push({ type: "webhook", ...(ingress === undefined ? {} : { ingress }) });
    }
    else if (typeof tr["type"] === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(tr["type"])) {
      const { type, ...fields } = tr;
      triggers.push({ type: type as string, fields });
    } else return { ok: false, reason: "a trigger is `schedule: <spec>`, `webhook: true` or `type: <a plugin's trigger type>`" };
  }
  const level = m["level"];
  if (level !== undefined && !(LEVELS as readonly unknown[]).includes(level)) return { ok: false, reason: `its level must be one of ${LEVELS.join(", ")}` };
  const timezone = m["timezone"];
  if (timezone !== undefined && (typeof timezone !== "string" || !isTimeZone(timezone))) return { ok: false, reason: `its time zone "${String(timezone).slice(0, 60)}" isn't one this computer knows` };
  const missed = m["missed"] ?? "run-once";
  if (missed !== "run-once" && missed !== "skip") return { ok: false, reason: "`missed` is run-once or skip" };
  const paused = m["paused"];
  if (paused !== undefined && typeof paused !== "boolean") return { ok: false, reason: "`paused` is true or false" };
  const body = doc.body.replace(/^\r?\n/, "");
  return {
    ok: true, minted,
    routine: {
      id: id as string, name: name.trim(), triggers, missed,
      ...(level === undefined ? {} : { level: level as Level }),
      ...(timezone === undefined ? {} : { timezone: timezone as string }),
      ...(paused === true ? { paused: true } : {}),
      body,
    },
  };
}

const q = (s: string) => JSON.stringify(s);

/** Writes a routine as its file (the `Routine` tool, a migration). */
export function serializeRoutine(r: Omit<RoutineFile, "triggers"> & { triggers: (Omit<Extract<RoutineTrigger, { type: "schedule" }>, "parsed"> | { type: "webhook"; ingress?: string } | { type: string; fields: Record<string, unknown> })[] }): string {
  const lines = [`id: ${r.id}`, `name: ${q(r.name)}`, "triggers:"];
  if (r.triggers.length === 0) lines[lines.length - 1] = "triggers: []";
  for (const t of r.triggers) {
    if (t.type === "schedule" && "spec" in t) lines.push(`  - schedule: ${q(t.spec)}`);
    else if (t.type === "webhook") {
      lines.push("  - webhook: true");
      if ("ingress" in t && typeof t.ingress === "string") lines.push(`    ingress: ${q(t.ingress)}`);
    }
    else if ("fields" in t) lines.push(`  - ${JSON.stringify({ type: t.type, ...t.fields })}`);
  }
  if (r.level !== undefined) lines.push(`level: ${r.level}`);
  if (r.timezone !== undefined) lines.push(`timezone: ${q(r.timezone)}`);
  lines.push(`missed: ${r.missed}`);
  if (r.paused === true) lines.push("paused: true");
  return joinFrontmatter({ lines, body: `\n${r.body.trimEnd()}\n`, newline: "\n" });
}

/** The file with its minted id written in, its other lines as they were (§7 "a file without one gets one"). */
export function withId(text: string, id: string): string {
  const doc = splitFrontmatter(text);
  if (!doc) return text;
  return joinFrontmatter({ ...doc, lines: [`id: ${id}`, ...doc.lines] });
}

/** A short summary of a trigger, for `RoutineView.triggers`. */
export function triggerSummary(t: RoutineTrigger): { type: string; summary: string } {
  if (t.type === "schedule" && "spec" in t) return { type: "schedule", summary: t.spec };
  if (t.type === "webhook") return { type: "webhook", summary: `a webhook URL with its key${"ingress" in t && typeof t.ingress === "string" ? `, through ${t.ingress}` : ""}` };
  return { type: t.type, summary: JSON.stringify("fields" in t ? t.fields : {}).slice(0, 500) };
}
