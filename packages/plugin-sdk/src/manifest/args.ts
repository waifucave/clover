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
  if (s.pattern !== undefined && (typeof s.pattern !== "string" || regexOf(s.pattern) === null)) return bad("pattern");
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

/** JSON equality, for `enum`, `const` and `uniqueItems`: objects by their keys, whatever their order. */
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

function check(schema: unknown, v: unknown, path: string, depth: number): ArgsCheck {
  const fail = (keyword: string, at = path): ArgsCheck => ({ ok: false, path: at, keyword });
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
    if (s.pattern !== undefined && !regexOf(s.pattern as string)!.test(v)) return fail("pattern");
  }
  if (Array.isArray(v)) {
    if (s.minItems !== undefined && v.length < (s.minItems as number)) return fail("minItems");
    if (s.maxItems !== undefined && v.length > (s.maxItems as number)) return fail("maxItems");
    if (s.uniqueItems === true) {
      for (let i = 0; i < v.length; i++) for (let j = i + 1; j < v.length; j++) if (jsonEqual(v[i], v[j])) return fail("uniqueItems", pointer(path, j));
    }
    const prefix = (s.prefixItems as unknown[] | undefined) ?? [];
    for (const [i, item] of v.entries()) {
      const sub = i < prefix.length ? prefix[i] : s.items;
      if (sub === undefined) continue;
      const r = check(sub, item, pointer(path, i), depth + 1);
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
      const r = check(sub, v[k], pointer(path, k), depth + 1);
      if (!r.ok) return Object.hasOwn(props, k) || r.keyword !== "false" ? r : fail("additionalProperties", pointer(path, k));
    }
  }
  if (s.allOf !== undefined) for (const sub of s.allOf as unknown[]) {
    const r = check(sub, v, path, depth + 1);
    if (!r.ok) return r;
  }
  if (s.anyOf !== undefined && !(s.anyOf as unknown[]).some((sub) => check(sub, v, path, depth + 1).ok)) return fail("anyOf");
  if (s.oneOf !== undefined && (s.oneOf as unknown[]).filter((sub) => check(sub, v, path, depth + 1).ok).length !== 1) return fail("oneOf");
  if (s.not !== undefined && check(s.not, v, path, depth + 1).ok) return fail("not");
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
  if (schema === undefined) return check({ type: "object", maxProperties: 0 }, value, "", 0);
  if (!checkArgsSchema(schema).ok) return { ok: false, path: "", keyword: "schema" };
  return check(schema, value, "", 0);
}
