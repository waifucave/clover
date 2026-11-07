// A command's args against its declared schema (F-M3's review N4): the check `command.run` runs for every caller and
// the palette runs first.
import { describe, expect, test } from "bun:test";
import { ARGS_MAX_BYTES, ARGS_MAX_PATTERN_INPUT, checkArgsSchema, patternProblem, validateArgs } from "../src/index";

const fails = (schema: unknown, args: unknown) => {
  const r = validateArgs(schema, args);
  return r.ok ? "ok" : `${r.keyword} at ${r.path === "" ? "/" : r.path}`;
};

describe("validateArgs", () => {
  const schema = {
    type: "object",
    required: ["name", "count"],
    properties: {
      name: { type: "string", minLength: 1, maxLength: 8, pattern: "^[a-z]+$" },
      count: { type: "integer", minimum: 1, maximum: 10 },
      ratio: { type: "number", exclusiveMinimum: 0, exclusiveMaximum: 1 },
      mode: { enum: ["fast", "slow"] },
      tags: { type: "array", items: { type: "string" }, maxItems: 3, uniqueItems: true },
      where: {
        type: "object", required: ["x"],
        properties: { x: { type: "number" }, label: { type: ["string", "null"] } },
      },
    },
  };

  test("a call that fits passes", () => {
    expect(fails(schema, { name: "abc", count: 3 })).toBe("ok");
    expect(fails(schema, { name: "abc", count: 10, ratio: 0.5, mode: "slow", tags: ["a", "b"], where: { x: 1.5, label: null } })).toBe("ok");
  });

  test("type, integer, min and max, pattern and enum fail at their path", () => {
    expect(fails(schema, { name: 3, count: 3 })).toBe("type at /name");
    expect(fails(schema, { name: "abc", count: 2.5 })).toBe("type at /count");
    expect(fails(schema, { name: "abc", count: "3" })).toBe("type at /count");
    expect(fails(schema, { name: "abc", count: 0 })).toBe("minimum at /count");
    expect(fails(schema, { name: "abc", count: 11 })).toBe("maximum at /count");
    expect(fails(schema, { name: "abc", count: 3, ratio: 1 })).toBe("exclusiveMaximum at /ratio");
    expect(fails(schema, { name: "abc", count: 3, ratio: 0 })).toBe("exclusiveMinimum at /ratio");
    expect(fails(schema, { name: "ABC", count: 3 })).toBe("pattern at /name");
    expect(fails(schema, { name: "", count: 3 })).toBe("minLength at /name");
    expect(fails(schema, { name: "abcdefghi", count: 3 })).toBe("maxLength at /name");
    expect(fails(schema, { name: "abc", count: 3, mode: "medium" })).toBe("enum at /mode");
  });

  test("nested objects and arrays, required, and no extra properties unless allowed", () => {
    expect(fails(schema, { name: "abc" })).toBe("required at /count");
    expect(fails(schema, { name: "abc", count: 3, where: {} })).toBe("required at /where/x");
    expect(fails(schema, { name: "abc", count: 3, where: { x: 1, label: 2 } })).toBe("type at /where/label");
    expect(fails(schema, { name: "abc", count: 3, tags: ["a", 1] })).toBe("type at /tags/1");
    expect(fails(schema, { name: "abc", count: 3, tags: ["a", "a"] })).toBe("uniqueItems at /tags/1");
    expect(fails(schema, { name: "abc", count: 3, tags: ["a", "b", "c", "d"] })).toBe("maxItems at /tags");
    expect(fails(schema, { name: "abc", count: 3, extra: true })).toBe("additionalProperties at /extra");
    expect(fails(schema, { name: "abc", count: 3, where: { x: 1, y: 2 } })).toBe("additionalProperties at /where/y");
    expect(fails({ ...schema, additionalProperties: true }, { name: "abc", count: 3, extra: true })).toBe("ok");
    expect(fails({ ...schema, additionalProperties: { type: "boolean" } }, { name: "abc", count: 3, extra: "x" })).toBe("type at /extra");
    expect(fails(schema, [])).toBe("type at /");
    expect(fails(schema, null)).toBe("type at /");
  });

  test("the path is a JSON Pointer, and the failure never carries the value", () => {
    const secret = "hunter2-SECRET";
    const r = validateArgs({ type: "object", properties: { "a/b~c": { type: "integer" } } }, { "a/b~c": secret });
    expect(r).toEqual({ ok: false, path: "/a~1b~0c", keyword: "type" });
    expect(JSON.stringify(r)).not.toContain(secret);
  });

  test("no schema: the command takes no args; absent args are checked as {}", () => {
    expect(fails(undefined, undefined)).toBe("ok");
    expect(fails(undefined, {})).toBe("ok");
    expect(fails(undefined, { a: 1 })).toBe("maxProperties at /");
    expect(fails(undefined, "x")).toBe("type at /");
    expect(fails(schema, undefined)).toBe("required at /name");
  });

  test("only JSON values: NaN, infinities, undefined fields and class instances fail", () => {
    const n = { type: "object", properties: { v: { type: "number" } } };
    expect(fails(n, { v: Number.NaN })).toBe("type at /v");
    expect(fails(n, { v: Number.POSITIVE_INFINITY })).toBe("type at /v");
    expect(fails(n, { v: undefined })).toBe("type at /v");
    expect(fails({ type: "object", additionalProperties: true }, { d: new Date(0) })).toBe("type at /d");
    expect(fails({ type: "object", additionalProperties: true }, { f: () => 1 })).toBe("type at /f");
  });

  test("composition, const, prefixItems, multipleOf and property counts", () => {
    expect(fails({ anyOf: [{ type: "string" }, { type: "integer" }] }, true)).toBe("anyOf at /");
    expect(fails({ oneOf: [{ type: "number" }, { type: "integer" }] }, 3)).toBe("oneOf at /");
    expect(fails({ allOf: [{ type: "number" }, { minimum: 5 }] }, 3)).toBe("minimum at /");
    expect(fails({ not: { type: "string" } }, "x")).toBe("not at /");
    expect(fails({ const: { a: [1, 2] } }, { a: [1, 2] })).toBe("ok");
    expect(fails({ type: "array", prefixItems: [{ type: "string" }], items: { type: "integer" } }, ["a", 1, 2])).toBe("ok");
    expect(fails({ type: "array", prefixItems: [{ type: "string" }], items: { type: "integer" } }, ["a", "b"])).toBe("type at /1");
    expect(fails({ type: "number", multipleOf: 0.1 }, 0.3)).toBe("ok");
    expect(fails({ type: "number", multipleOf: 0.5 }, 0.3)).toBe("multipleOf at /");
    expect(fails({ type: "string", maxLength: 2 }, "😀😀")).toBe("ok");
    expect(fails({ type: "object", additionalProperties: true, minProperties: 1 }, {})).toBe("minProperties at /");
  });

  test("a schema outside the subset takes no call, so nothing passes by an unknown keyword", () => {
    expect(fails({ type: "object", properties: { a: { $ref: "#/x" } } }, { a: 1 })).toBe("schema at /");
    expect(fails({ type: "string", pattern: "(" }, "x")).toBe("schema at /");
    expect(fails({ type: "strings" }, "x")).toBe("schema at /");
    expect(checkArgsSchema({ type: "object", properties: { a: { if: {} } } })).toEqual({ ok: false, path: "/properties/a", keyword: "if" });
    expect(checkArgsSchema({ title: "T", description: "d", default: {}, examples: [], format: "uri", type: "object" })).toEqual({ ok: true });
    let deep: Record<string, unknown> = { type: "object" };
    for (let i = 0; i < 80; i++) deep = { type: "object", properties: { a: deep } };
    expect(checkArgsSchema(deep).ok).toBe(false);
  });

  test("a value nested past the depth limit fails instead of overflowing, whatever the schema", () => {
    let v: unknown = 1;
    for (let i = 0; i < 100; i++) v = [v];
    expect(validateArgs({ type: "object", properties: { v: true } }, { v })).toMatchObject({ ok: false, keyword: "depth" });
    let ok: unknown = 1;
    for (let i = 0; i < 10; i++) ok = [ok];
    expect(fails({ type: "object", properties: { v: true } }, { v: ok })).toBe("ok");
  });

  describe("bounded for a third-party schema (#234's review, F3)", () => {
    test("a pattern stays in a linear-time subset: no backreference, lookaround, or quantified group with a quantifier or an alternation", () => {
      for (const ok of ["^[a-z]+$", "^(foo|bar)$", "^(?:ab)+$", "^\\d{3}-\\d{4}$", "^[(]+$", "^a\\(b\\)+c$", "^(?<year>\\d{4})$"]) expect([ok, patternProblem(ok)]).toEqual([ok, undefined]);
      for (const bad of ["^(a+)+$", "^(a*)*b$", "(a|a)*", "^(\\w+\\s?)*$", "(x+x+)+y", "^((a)+)+$", "(a)\\1", "\\k<n>", "(?=a)", "(?!a)", "(?<=a)", "(?<!a)", "a".repeat(257)]) {
        expect([bad, patternProblem(bad) !== undefined, checkArgsSchema({ type: "string", pattern: bad }).ok]).toEqual([bad, true, false]);
      }
      // The reviewer's ~320 ms-per-string pattern never runs: the schema takes no call.
      const started = performance.now();
      expect(validateArgs({ type: "object", properties: { s: { type: "string", pattern: "^(a+)+$" } } }, { s: "a".repeat(30) + "!" })).toEqual({ ok: false, path: "", keyword: "schema" });
      expect(performance.now() - started).toBeLessThan(50);
    });

    test("a string longer than 4,096 code points isn't tried on a pattern; args over 256 KiB aren't checked at all", () => {
      const s = { type: "object", additionalProperties: { type: "string", pattern: "^[a-z]+$" } };
      expect(validateArgs(s, { a: "a".repeat(ARGS_MAX_PATTERN_INPUT) })).toEqual({ ok: true });
      expect(validateArgs(s, { a: "a".repeat(ARGS_MAX_PATTERN_INPUT + 1) })).toEqual({ ok: false, path: "/a", keyword: "patternLength" });
      expect(validateArgs({ type: "object", additionalProperties: true }, { a: "x".repeat(ARGS_MAX_BYTES) })).toEqual({ ok: false, path: "", keyword: "size" });
      expect(validateArgs({ type: "object", additionalProperties: true }, { a: "x".repeat(1000) })).toEqual({ ok: true });
    });

    test("uniqueItems is linear: 20,000 objects in well under a second, key order ignored", () => {
      const items = Array.from({ length: 20_000 }, (_, i) => ({ i })); // ~220 KB, inside the size cap
      const schema = { type: "array", uniqueItems: true, items: { type: "object", additionalProperties: true } };
      const started = performance.now();
      expect(validateArgs({ type: "object", properties: { xs: schema } }, { xs: items })).toEqual({ ok: true });
      expect(performance.now() - started).toBeLessThan(1000);
      expect(validateArgs({ type: "object", properties: { xs: schema } }, { xs: [{ a: 1, b: 2 }, { b: 2, a: 1 }] })).toEqual({ ok: false, path: "/xs/1", keyword: "uniqueItems" });
    });

    test("one call visits at most 100,000 schema nodes, anyOf and arrays included", () => {
      const wide = { anyOf: Array.from({ length: 8 }, () => ({ type: "array", items: { anyOf: Array.from({ length: 8 }, () => ({ type: "array", items: { type: "string" } })) } })) };
      // Every inner array fits but the very last, which fails only at its end: each outer branch walks it all.
      const value = { xs: Array.from({ length: 200 }, (_, i) => Array.from({ length: 200 }, (_, j) => (i === 199 && j === 199 ? 1 : "a"))) };
      const started = performance.now();
      expect(validateArgs({ type: "object", properties: { xs: wide } }, value)).toEqual({ ok: false, path: "", keyword: "budget" });
      expect(performance.now() - started).toBeLessThan(1000);
      expect(validateArgs({ type: "object", properties: { xs: wide } }, { xs: [["a"]] })).toEqual({ ok: true });
    });
  });
});
