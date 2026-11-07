// A command's `args` against the JSON Schema its manifest declares (§5.4, F-M3's review N4). The core runs it in
// `command.run` for every caller before the handler runs; the palette (lane F) runs the same check first, so the user
// sees the failing field before the call goes out.
//
// The schema language is a closed subset of JSON Schema 2020-12, so a check never passes by skipping a keyword it
// doesn't know: `type` (one or a list; `integer` is a whole number), `enum`, `const`, `minimum`, `maximum`,
// `exclusiveMinimum`, `exclusiveMaximum`, `multipleOf`, `minLength`, `maxLength` (in code points), `pattern` (a `u`
// regular expression, unanchored), `properties`, `required`, `additionalProperties` (a boolean or a schema),
// `minProperties`, `maxProperties`, `items`, `prefixItems`, `minItems`, `maxItems`, `uniqueItems`, `allOf`, `anyOf`,
// `oneOf` and `not`, plus the annotations (`title`, `description`, `default`, `examples`, `format`, `$schema`,
// `$comment`, `$id`, `deprecated`, `readOnly`, `writeOnly`). One difference from JSON Schema, on purpose: an object
// takes no property its schema doesn't name unless `additionalProperties` allows it.
//
// A failure names the JSON Pointer of the failing value and the keyword, never the value: args can carry what the
// user typed.
//
// The check is bounded, since a third-party schema runs in the core (#234's review, F3): a `pattern` stays in a
// linear-time subset (at most 256 characters; no backreference, lookaround, or quantified group holding a quantifier
// or an alternation; the product of its quantifiers' ranges at most 2^24), is tried only on strings of at most
// 4,096 code points (`patternLength`) and on at most 64K characters in all per call (`budget`), the args are at most
// 256 KiB of JSON (`size`), `uniqueItems` is linear, and one call visits at most 100,000 schema nodes (`budget`).

/** The keywords the check enforces. */
export const ARGS_SCHEMA_KEYWORDS = [
  "type", "enum", "const", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength",
  "maxLength", "pattern", "properties", "required", "additionalProperties", "minProperties", "maxProperties", "items",
  "prefixItems", "minItems", "maxItems", "uniqueItems", "allOf", "anyOf", "oneOf", "not",
] as const;

/** The keywords that only describe, and are never checked. */
export const ARGS_SCHEMA_ANNOTATIONS = [
  "title", "description", "default", "examples", "format", "$schema", "$comment", "$id", "deprecated", "readOnly", "writeOnly",
] as const;

const KEYWORDS = new Set<string>([...ARGS_SCHEMA_KEYWORDS, ...ARGS_SCHEMA_ANNOTATIONS]);
const TYPES = new Set(["string", "number", "integer", "boolean", "object", "array", "null"]);

/** How deep a schema or a value may nest. */
export const ARGS_MAX_DEPTH = 64;
/** The longest `pattern` a schema may hold, in UTF-16 code units (#234's review, F3). */
export const ARGS_MAX_PATTERN = 256;
/** The most args a call may carry, as JSON in UTF-8 bytes. */
export const ARGS_MAX_BYTES = 256 * 1024;
/** The longest string a `pattern` is tried on, in code points; a longer one fails `patternLength`. */
export const ARGS_MAX_PATTERN_INPUT = 4096;
/** The most schema nodes one call's check visits; past it the check fails `budget` (`anyOf`, `oneOf` and arrays
 *  multiply the work). */
export const ARGS_VISIT_BUDGET = 100_000;
/** The most characters (UTF-16 code units) one call tries patterns on, in all; past it the check fails `budget`. */
export const ARGS_PATTERN_INPUT_BUDGET = 64 * 1024;
/** The most one `pattern`'s quantifiers may multiply to (#234's check 3, F3): the product over every quantifier, nested
 *  ones included, of how many repetitions it allows (`max - min + 1`; `?` is 2, `{3}` is 1), with no upper bound
 *  counted as `ARGS_PATTERN_UNBOUNDED`. It bounds how many ways a match can be tried: two `*`s pass (2^24), and
 *  `^a*a*a*b$`, ten `a{0,16}` or sixty `\w?` don't. */
export const ARGS_MAX_PATTERN_PRODUCT = 2 ** 24;
/** What a quantifier with no upper bound (`*`, `+`, `{n,}`) counts as: the longest string a pattern is tried on. */
export const ARGS_PATTERN_UNBOUNDED = ARGS_MAX_PATTERN_INPUT;

/** Why a `pattern` is outside the linear-time subset, or undefined when it is in it: no backreference, no lookaround,
 *  no quantified group that holds a quantifier or an alternation (the shapes that backtrack exponentially, such as
 *  `^(a+)+$` or `(a|a)*`), and quantifiers whose ranges multiply to at most `ARGS_MAX_PATTERN_PRODUCT` (more backtrack
 *  in polynomial time, such as `^a*a*a*b$`). */
export function patternProblem(source: string): string | undefined {
  if (source.length > ARGS_MAX_PATTERN) return "too long";
  // One frame per open group: whether it holds a quantifier or an alternation at any depth.
  const frames: { quant: boolean; alt: boolean }[] = [{ quant: false, alt: false }];
  const isQuant = (i: number) => source[i] === "*" || source[i] === "+" || source[i] === "?" || (source[i] === "{" && /^\{\d+(,\d*)?\}/.test(source.slice(i)));
  // How many repetitions the quantifier at `i` allows. A group's quantifier multiplies what the group holds, which the
  // running product over the whole pattern already counts.
  const range = (i: number): number => {
    if (source[i] === "*" || source[i] === "+") return ARGS_PATTERN_UNBOUNDED;
    if (source[i] === "?") return 2;
    const m = /^\{(\d+)(,(\d*))?\}/.exec(source.slice(i))!;
    if (m[2] === undefined) return 1;
    if (m[3] === "") return ARGS_PATTERN_UNBOUNDED;
    return Math.max(1, Number(m[3]) - Number(m[1]) + 1);
  };
  let product = 1;
  const tooMany = (i: number) => (product *= range(i)) > ARGS_MAX_PATTERN_PRODUCT;
  // The index just past the quantifier at `i`, and its lazy `?` if any.
  const skipQuant = (i: number) => {
    const end = source[i] === "{" ? source.indexOf("}", i) + 1 : i + 1;
    return source[end] === "?" ? end + 1 : end;
  };
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    if (c === "\\") {
      const n = source[i + 1];
      if (n !== undefined && (/[1-9]/.test(n) || n === "k")) return "a backreference";
      i++;
      continue;
    }
    if (c === "[") {
      for (i++; i < source.length && source[i] !== "]"; i++) if (source[i] === "\\") i++;
      continue;
    }
    if (c === "(") {
      if (source.startsWith("(?=", i) || source.startsWith("(?!", i) || source.startsWith("(?<=", i) || source.startsWith("(?<!", i)) return "a lookaround";
      frames.push({ quant: false, alt: false });
      continue;
    }
    if (c === ")") {
      const f = frames.pop();
      if (f === undefined || frames.length === 0) return "an unbalanced group";
      const quantified = isQuant(i + 1);
      if (quantified && (f.quant || f.alt)) return "a quantified group holding a quantifier or an alternation";
      const parent = frames[frames.length - 1]!;
      parent.quant ||= f.quant || quantified;
      parent.alt ||= f.alt;
      // The group's own quantifier is counted here, not again as the next character.
      if (quantified) {
        if (tooMany(i + 1)) return "quantifiers that allow too many ways to match";
        i = skipQuant(i + 1) - 1;
      }
      continue;
    }
    if (c === "|") frames[frames.length - 1]!.alt = true;
    else if (isQuant(i) && !(c === "?" && source[i - 1] === "(")) {
      const f = frames[frames.length - 1]!;
      f.quant = true;
      if (tooMany(i)) return "quantifiers that allow too many ways to match";
      i = skipQuant(i) - 1;
    }
  }
  return undefined;
}

export type ArgsCheck =
  | { ok: true }
  /** `path`: the JSON Pointer of the failing value (`""` for the args themselves); `keyword`: the rule it broke. */
  | { ok: false; path: string; keyword: string };

/** A schema's own problem, before any value: an unknown keyword, a bad `pattern`, a wrong-typed keyword. */
export type ArgsSchemaCheck = { ok: true } | { ok: false; path: string; keyword: string };

type Schema = Record<string, unknown>;

const pointer = (base: string, key: string | number) => `${base}/${String(key).replace(/~/g, "~0").replace(/\//g, "~1")}`;
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const isCount = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v >= 0;
const isNumber = (v: unknown) => typeof v === "number" && Number.isFinite(v);

const patterns = new Map<string, RegExp | null>();
function regexOf(source: string): RegExp | null {
  if (!patterns.has(source)) {
    let re: RegExp | null = null;
    try { re = new RegExp(source, "u"); } catch { re = null; }
    if (patterns.size > 1024) patterns.clear();
    patterns.set(source, re);
  }
  return patterns.get(source)!;
}

/** Whether a schema uses only what the check enforces, well-formed, at any depth. The manifest validation and the
 *  core both run it: a command whose schema fails it takes no call. */
export function checkArgsSchema(schema: unknown, path = "", depth = 0): ArgsSchemaCheck {
  const bad = (keyword: string, at = path): ArgsSchemaCheck => ({ ok: false, path: at, keyword });
  if (typeof schema === "boolean") return { ok: true };
  if (!isObject(schema)) return bad("schema");
  if (depth > ARGS_MAX_DEPTH) return bad("depth");
  for (const key of Object.keys(schema)) if (!KEYWORDS.has(key)) return bad(key);
  const s = schema as Schema;
  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? s.type : [s.type];
    if (types.length === 0 || !types.every((t) => typeof t === "string" && TYPES.has(t))) return bad("type");
  }
  if (s.enum !== undefined && (!Array.isArray(s.enum) || s.enum.length === 0)) return bad("enum");
  for (const k of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"] as const) if (s[k] !== undefined && !isNumber(s[k])) return bad(k);
  if (s.multipleOf !== undefined && !(isNumber(s.multipleOf) && (s.multipleOf as number) > 0)) return bad("multipleOf");
  for (const k of ["minLength", "maxLength", "minProperties", "maxProperties", "minItems", "maxItems"] as const) if (s[k] !== undefined && !isCount(s[k])) return bad(k);
  if (s.pattern !== undefined && (typeof s.pattern !== "string" || patternProblem(s.pattern) !== undefined || regexOf(s.pattern) === null)) return bad("pattern");
  if (s.uniqueItems !== undefined && typeof s.uniqueItems !== "boolean") return bad("uniqueItems");
  if (s.required !== undefined && !(Array.isArray(s.required) && s.required.every((r) => typeof r === "string"))) return bad("required");
  if (s.properties !== undefined) {
    if (!isObject(s.properties)) return bad("properties");
    for (const [k, sub] of Object.entries(s.properties)) {
      const r = checkArgsSchema(sub, pointer(pointer(path, "properties"), k), depth + 1);
      if (!r.ok) return r;
    }
  }
  for (const k of ["additionalProperties", "items", "not"] as const) {
    if (s[k] === undefined) continue;
    const r = checkArgsSchema(s[k], pointer(path, k), depth + 1);
    if (!r.ok) return r;
  }
  for (const k of ["prefixItems", "allOf", "anyOf", "oneOf"] as const) {
    if (s[k] === undefined) continue;
    if (!Array.isArray(s[k]) || (s[k] as unknown[]).length === 0) return bad(k);
    for (const [i, sub] of (s[k] as unknown[]).entries()) {
      const r = checkArgsSchema(sub, pointer(pointer(path, k), i), depth + 1);
      if (!r.ok) return r;
    }
  }
  return { ok: true };
}

/** A value as JSON with sorted keys, so equal values give equal strings whatever their key order. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (isObject(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v) ?? "null";
}

/** JSON equality, for `enum` and `const`: objects by their keys, whatever their order. */
function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => jsonEqual(x, b[i]));
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => Object.hasOwn(b, k) && jsonEqual(a[k], b[k]));
  }
  return false;
}

function typeMatches(type: string, v: unknown): boolean {
  switch (type) {
    case "string": return typeof v === "string";
    case "number": return isNumber(v);
    case "integer": return isNumber(v) && Number.isInteger(v);
    case "boolean": return typeof v === "boolean";
    case "object": return isObject(v);
    case "array": return Array.isArray(v);
    case "null": return v === null;
    default: return false;
  }
}

/** One call's work: schema nodes visited, characters tried on patterns. */
interface Budget { visits: number; patternInput: number; spent: boolean }

function check(schema: unknown, v: unknown, path: string, depth: number, budget: Budget): ArgsCheck {
  const fail = (keyword: string, at = path): ArgsCheck => ({ ok: false, path: at, keyword });
  if (budget.spent || ++budget.visits > ARGS_VISIT_BUDGET) {
    budget.spent = true;
    return fail("budget");
  }
  if (schema === true) return { ok: true };
  if (schema === false) return fail("false");
  const s = schema as Schema;
  if (depth > ARGS_MAX_DEPTH) return fail("depth");
  if (s.type !== undefined) {
    const types = (Array.isArray(s.type) ? s.type : [s.type]) as string[];
    if (!types.some((t) => typeMatches(t, v))) return fail("type");
  }
  if (s.const !== undefined && !jsonEqual(s.const, v)) return fail("const");
  if (s.enum !== undefined && !(s.enum as unknown[]).some((e) => jsonEqual(e, v))) return fail("enum");
  if (typeof v === "number") {
    if (s.minimum !== undefined && v < (s.minimum as number)) return fail("minimum");
    if (s.maximum !== undefined && v > (s.maximum as number)) return fail("maximum");
    if (s.exclusiveMinimum !== undefined && v <= (s.exclusiveMinimum as number)) return fail("exclusiveMinimum");
    if (s.exclusiveMaximum !== undefined && v >= (s.exclusiveMaximum as number)) return fail("exclusiveMaximum");
    if (s.multipleOf !== undefined) {
      const q = v / (s.multipleOf as number);
      if (Math.abs(q - Math.round(q)) > 1e-9) return fail("multipleOf");
    }
  }
  if (typeof v === "string") {
    const length = [...v].length;
    if (s.minLength !== undefined && length < (s.minLength as number)) return fail("minLength");
    if (s.maxLength !== undefined && length > (s.maxLength as number)) return fail("maxLength");
    if (s.pattern !== undefined) {
      if (length > ARGS_MAX_PATTERN_INPUT) return fail("patternLength");
      budget.patternInput += v.length;
      if (budget.patternInput > ARGS_PATTERN_INPUT_BUDGET) {
        budget.spent = true;
        return fail("budget");
      }
      if (!regexOf(s.pattern as string)!.test(v)) return fail("pattern");
    }
  }
  if (Array.isArray(v)) {
    if (s.minItems !== undefined && v.length < (s.minItems as number)) return fail("minItems");
    if (s.maxItems !== undefined && v.length > (s.maxItems as number)) return fail("maxItems");
    if (s.uniqueItems === true) {
      // Canonical JSON (keys sorted) in a set: linear, where comparing each pair was quadratic (#234's review, F3).
      const seen = new Set<string>();
      for (let j = 0; j < v.length; j++) {
        const key = canonical(v[j]);
        if (seen.has(key)) return fail("uniqueItems", pointer(path, j));
        seen.add(key);
      }
    }
    const prefix = (s.prefixItems as unknown[] | undefined) ?? [];
    for (const [i, item] of v.entries()) {
      const sub = i < prefix.length ? prefix[i] : s.items;
      if (sub === undefined) continue;
      const r = check(sub, item, pointer(path, i), depth + 1, budget);
      if (!r.ok) return r;
    }
  }
  // An object's rules apply where the schema speaks of objects; there, a property it doesn't name is refused unless
  // `additionalProperties` allows it.
  const speaksOfObjects = s.type !== undefined || s.properties !== undefined || s.additionalProperties !== undefined || s.required !== undefined
    || s.minProperties !== undefined || s.maxProperties !== undefined;
  if (isObject(v) && speaksOfObjects) {
    const keys = Object.keys(v);
    if (s.minProperties !== undefined && keys.length < (s.minProperties as number)) return fail("minProperties");
    if (s.maxProperties !== undefined && keys.length > (s.maxProperties as number)) return fail("maxProperties");
    for (const r of (s.required as string[] | undefined) ?? []) if (!Object.hasOwn(v, r) || v[r] === undefined) return fail("required", pointer(path, r));
    const props = (s.properties as Record<string, unknown> | undefined) ?? {};
    for (const k of keys) {
      const sub = Object.hasOwn(props, k) ? props[k] : s.additionalProperties ?? false;
      const r = check(sub, v[k], pointer(path, k), depth + 1, budget);
      if (!r.ok) return Object.hasOwn(props, k) || r.keyword !== "false" ? r : fail("additionalProperties", pointer(path, k));
    }
  }
  if (s.allOf !== undefined) for (const sub of s.allOf as unknown[]) {
    const r = check(sub, v, path, depth + 1, budget);
    if (!r.ok) return r;
  }
  if (s.anyOf !== undefined && !(s.anyOf as unknown[]).some((sub) => check(sub, v, path, depth + 1, budget).ok)) return fail(budget.spent ? "budget" : "anyOf");
  if (s.oneOf !== undefined && (s.oneOf as unknown[]).filter((sub) => check(sub, v, path, depth + 1, budget).ok).length !== 1) return fail(budget.spent ? "budget" : "oneOf");
  if (s.not !== undefined && check(s.not, v, path, depth + 1, budget).ok) return fail("not");
  if (budget.spent) return fail("budget");
  return { ok: true };
}

/** Where args hold something JSON can't (undefined inside, a function, NaN or an infinity, a class instance such as a
 *  Date), or nest past `ARGS_MAX_DEPTH`: the JSON Pointer and the reason. */
function nonJson(v: unknown, path: string, depth: number): ArgsCheck {
  if (depth > ARGS_MAX_DEPTH) return { ok: false, path, keyword: "depth" };
  if (v === null || typeof v === "string" || typeof v === "boolean" || isNumber(v)) return { ok: true };
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      const r = nonJson(v[i], pointer(path, i), depth + 1);
      if (!r.ok) return r;
    }
    return { ok: true };
  }
  if (isObject(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)) {
    for (const k of Object.keys(v)) {
      const r = nonJson(v[k], pointer(path, k), depth + 1);
      if (!r.ok) return r;
    }
    return { ok: true };
  }
  return { ok: false, path, keyword: "type" };
}

/** Checks a command's `args` against its declared schema. No schema declared: the command takes no args, so only
 *  absent args (or an empty object) pass. A schema that fails `checkArgsSchema` fails every call, at `keyword:
 *  "schema"`. Absent args are checked as `{}` against a schema, so a required field still fails. */
export function validateArgs(schema: unknown, args: unknown): ArgsCheck {
  const value = args === undefined ? {} : args;
  const json = nonJson(value, "", 0);
  if (!json.ok) return json;
  // The whole call's size first, before any walk is paid for.
  if (new TextEncoder().encode(JSON.stringify(value)).length > ARGS_MAX_BYTES) return { ok: false, path: "", keyword: "size" };
  const budget: Budget = { visits: 0, patternInput: 0, spent: false };
  if (schema === undefined) return check({ type: "object", maxProperties: 0 }, value, "", 0, budget);
  if (!checkArgsSchema(schema).ok) return { ok: false, path: "", keyword: "schema" };
  const r = check(schema, value, "", 0, budget);
  return budget.spent ? { ok: false, path: "", keyword: "budget" } : r;
}
