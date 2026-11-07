// A command's `args` checked against its JSON Schema before the palette runs it (review N4): the type (and `integer`),
// `minimum`/`maximum`, `minLength`/`maxLength`, `pattern`, `enum`/`const`, nested objects and arrays, `required` and
// `additionalProperties`. The validator is zod's own JSON Schema reader (`z.fromJSONSchema`, the zod lanes B and A
// already ship), the one lane B is asked to run in `command.run` for every caller. A schema it can't read (an unknown
// `$ref`) is refused, never run unchecked.
import { z } from "zod";

export interface ArgsIssue {
  /** The field it is about (the top-level property), or "" for the whole. */
  field: string;
  kind: "missing" | "type" | "too-small" | "too-big" | "pattern" | "choice" | "unknown-key" | "other";
  /** The limit, for too-small and too-big. */
  limit?: number;
  /** The limit counts characters (a string's length), or items (an array's). */
  of?: "characters" | "items";
}

export type ArgsCheck = { ok: true } | { ok: false; unreadable?: true; issues: ArgsIssue[] };

const compiled = new WeakMap<object, z.ZodType | null>();

function compile(schema: Record<string, unknown>): z.ZodType | null {
  if (compiled.has(schema)) return compiled.get(schema)!;
  let out: z.ZodType | null;
  try {
    out = z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]);
  } catch {
    out = null;
  }
  compiled.set(schema, out);
  return out;
}

/** The value at an issue's path in what was checked (zod leaves an issue's `input` out). */
function at(value: unknown, path: readonly PropertyKey[]): unknown {
  let v = value;
  for (const k of path) v = v !== null && typeof v === "object" ? (v as Record<PropertyKey, unknown>)[k] : undefined;
  return v;
}

function kindOf(issue: z.core.$ZodIssue, args: unknown): ArgsIssue {
  const field = typeof issue.path[0] === "string" ? issue.path[0] : "";
  const limit = "minimum" in issue ? Number(issue.minimum) : "maximum" in issue ? Number(issue.maximum) : undefined;
  const origin = "origin" in issue ? issue.origin : undefined;
  const of = origin === "string" ? { of: "characters" as const } : origin === "array" ? { of: "items" as const } : {};
  switch (issue.code) {
    case "invalid_type":
      return { field, kind: issue.path.length === 1 && at(args, issue.path) === undefined ? "missing" : "type" };
    case "too_small":
      return { field, kind: "too-small", ...of, ...(limit !== undefined && Number.isFinite(limit) ? { limit } : {}) };
    case "too_big":
      return { field, kind: "too-big", ...of, ...(limit !== undefined && Number.isFinite(limit) ? { limit } : {}) };
    case "invalid_format":
      return { field, kind: "pattern" };
    case "invalid_value":
      return { field, kind: "choice" };
    case "unrecognized_keys":
      return { field: issue.path.length === 0 ? (issue.keys[0] ?? "") : field, kind: "unknown-key" };
    default:
      return { field, kind: "other" };
  }
}

/** Whether `args` fits the command's schema. No schema: the command takes no args, so only `undefined` fits. */
export function checkArgs(schema: Record<string, unknown> | undefined, args: unknown): ArgsCheck {
  if (schema === undefined) return args === undefined ? { ok: true } : { ok: false, issues: [{ field: "", kind: "other" }] };
  const check = compile(schema);
  if (!check) return { ok: false, unreadable: true, issues: [] };
  const r = check.safeParse(args);
  return r.success ? { ok: true } : { ok: false, issues: r.error.issues.map((i) => kindOf(i, args)) };
}

/** What a command runs with when nothing is asked: `{}` for an object schema, else none. */
export const noArgs = (schema: Record<string, unknown> | undefined): Record<string, unknown> | undefined =>
  schema !== undefined && (schema.type === "object" || typeof schema.properties === "object") ? {} : undefined;

/** Whether a command can run as it is, with no form: its schema takes `noArgs`. */
export const runsBare = (schema: Record<string, unknown> | undefined) => checkArgs(schema, noArgs(schema)).ok;
