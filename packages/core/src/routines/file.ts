// A routine is a file (spec §7 "A routine is a file"): Markdown with frontmatter, whose body is the instructions.
// Owner: lane D.
//
// It lives at `home/<Computer>/.moss/routines/<bot>/<name>.md` in the folder tree, which before C5 is
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
import { LEVELS, type Level } from "@waifucave/moss-protocol";
import { joinFrontmatter, keyRange, splitFrontmatter } from "../runtime-sdk/host/run-home/frontmatter";
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

/** What the user's `routine.edit` changes (§7). */
export interface RoutinePatch {
  name?: string;
  schedule?: string;
  instructions?: string;
  paused?: boolean;
}

/** The file name a routine's name gives (the `Routine` tool's rule): lower-case letters, digits and dashes only, so it
 *  never leaves the bot's folder. */
export function routineFileName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "routine";
}

/** A routine's file text with the user's patch applied, changing ONLY the fields the patch names, in place: every other
 *  line of the frontmatter (comments, keys this build doesn't know, their order, the other triggers) and, unless the
 *  instructions change, the body stay byte for byte. The id stays (the webhook URL and its key, kept in the credential
 *  store, hang off it); a schedule is validated as the `Routine` tool does. A schedule change needs to know which trigger
 *  it means: a routine with more than one schedule, or one written in a form this can't change in place, is refused with
 *  "edit the file", while its name, instructions and pause still change. The result is read again, and anything but the
 *  named fields read differently is refused rather than written. */
export function patchRoutine(text: string, fallbackName: string, patch: RoutinePatch): { ok: true; text: string; routine: RoutineFile } | { ok: false; reason: string } {
  const parsed = parseRoutine(text, fallbackName);
  if (!parsed.ok) return parsed;
  if (parsed.minted) return { ok: false, reason: "the file has no id yet; it gets one when it is loaded" };
  const r = parsed.routine;
  const doc = splitFrontmatter(text)!;
  const lines = [...doc.lines];
  let body = doc.body;
  const editFile = "edit the routine's file to change it";
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (name === "" || name.length > 200) return { ok: false, reason: "a routine's name is text of at most 200 characters" };
    const at = keyRange(lines, "name");
    const line = `name: ${q(name)}`;
    if (at === undefined) {
      const id = keyRange(lines, "id");
      lines.splice(id === undefined ? 0 : id[1], 0, line);
    } else lines.splice(at[0], at[1] - at[0], `${line}${trailingComment(lines[at[0]]!)}`);
  }
  if (patch.instructions !== undefined) {
    const instructions = patch.instructions.trim();
    if (instructions === "") return { ok: false, reason: "a routine needs its instructions" };
    const lead = /^(?:\r?\n)*/.exec(body)?.[0] ?? "";
    body = `${lead}${instructions.split(/\r?\n/).join(doc.newline)}${doc.newline}`;
  }
  if (patch.paused !== undefined) {
    const at = keyRange(lines, "paused");
    if (patch.paused) {
      if (at === undefined) lines.push("paused: true");
      else lines.splice(at[0], at[1] - at[0], `paused: true${trailingComment(lines[at[0]]!)}`);
    } else if (at !== undefined) lines.splice(at[0], at[1] - at[0]);
  }
  if (patch.schedule !== undefined) {
    const schedule = patch.schedule.trim();
    try {
      parseSpec(schedule);
    } catch (err) {
      return { ok: false, reason: `the schedule doesn't read: ${err instanceof Error ? err.message : String(err)}` };
    }
    const schedules = r.triggers.filter((t) => t.type === "schedule").length;
    if (schedules > 1) return { ok: false, reason: `the routine has ${schedules} schedules, and a change can't say which one it means: ${editFile}` };
    const at = keyRange(lines, "triggers");
    if (schedules === 1) {
      const items = at === undefined ? [] : lines.map((l, i) => ({ l, i })).filter(({ l, i }) => i >= at[0] && i < at[1] && /^\s*-\s*schedule\s*:/.test(l));
      if (items.length !== 1) return { ok: false, reason: `its schedule isn't written as one \`- schedule:\` line: ${editFile}` };
      const { l, i } = items[0]!;
      const head = /^(\s*-\s*schedule\s*:\s*)/.exec(l)![1]!;
      lines[i] = `${head}${q(schedule)}${trailingComment(l)}`;
    } else if (at === undefined) {
      lines.push("triggers:", `  - schedule: ${q(schedule)}`);
    } else if (/^triggers\s*:\s*\[\s*\]\s*(#.*)?$/.test(lines[at[0]]!)) {
      lines.splice(at[0], 1, `triggers:${trailingComment(lines[at[0]]!)}`, `  - schedule: ${q(schedule)}`);
    } else if (/^triggers\s*:\s*(#.*)?$/.test(lines[at[0]]!)) {
      const item = lines.slice(at[0] + 1, at[1]).find((x) => /^\s*-/.test(x));
      const indent = item === undefined ? "  " : /^(\s*)/.exec(item)![1]!;
      lines.splice(at[0] + 1, 0, `${indent}- schedule: ${q(schedule)}`);
    } else return { ok: false, reason: `its triggers aren't written as a list of lines: ${editFile}` };
  }
  const out = joinFrontmatter({ lines, body, newline: doc.newline });
  const again = parseRoutine(out, fallbackName);
  if (!again.ok) return { ok: false, reason: `the change wouldn't read as a routine (${again.reason}): ${editFile}` };
  // What the patch didn't name reads exactly as before; what it named reads as asked.
  const n = again.routine;
  const want = {
    id: r.id, missed: r.missed, level: r.level, timezone: r.timezone,
    name: patch.name === undefined ? r.name : patch.name.trim(),
    paused: patch.paused ?? r.paused === true,
    body: patch.instructions === undefined ? r.body : n.body,
    triggers: r.triggers.map((t) => (t.type === "schedule" && "spec" in t && patch.schedule !== undefined ? { type: "schedule", spec: patch.schedule.trim() } : triggerKey(t))),
  };
  const got = { id: n.id, missed: n.missed, level: n.level, timezone: n.timezone, name: n.name, paused: n.paused === true, body: n.body, triggers: n.triggers.map(triggerKey) };
  if (patch.schedule !== undefined && !r.triggers.some((t) => t.type === "schedule")) want.triggers.unshift({ type: "schedule", spec: patch.schedule.trim() });
  if (JSON.stringify(want) !== JSON.stringify(got)) return { ok: false, reason: `the change would read as more than it says: ${editFile}` };
  if (patch.instructions !== undefined && n.body.trim() !== patch.instructions.trim()) return { ok: false, reason: `the instructions wouldn't read back as written: ${editFile}` };
  return { ok: true, text: out, routine: n };
}

/** A trigger as compared before and after an edit. */
function triggerKey(t: RoutineTrigger): Record<string, unknown> {
  if (t.type === "schedule" && "spec" in t) return { type: "schedule", spec: t.spec };
  if (t.type === "webhook" && !("fields" in t)) return { type: "webhook", ...("ingress" in t && t.ingress !== undefined ? { ingress: t.ingress } : {}) };
  return { type: t.type, fields: "fields" in t ? t.fields : {} };
}

/** A line's own trailing YAML comment (` # …` after its value), kept when the value changes. */
function trailingComment(line: string): string {
  const m = /\s+#[^"']*$/.exec(line);
  return m === null ? "" : m[0];
}

/** The file with its minted id written in, its other lines as they were (§7 "a file without one gets one"). */
/** The text with `paused: true` in its frontmatter (MOSS pausing it; the user resumes by taking it out). */
export function withPaused(text: string): string {
  const doc = splitFrontmatter(text);
  if (!doc) return text;
  return joinFrontmatter({ ...doc, lines: [...doc.lines.filter((l) => !/^paused\s*:/.test(l)), "paused: true"] });
}

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
