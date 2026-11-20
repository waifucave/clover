import { describe, expect, test } from "bun:test";
import { loadCatalog } from "@waifucave/clover-provider-catalog";
import { effectiveDefault, noDefaultModelReason, providerOfTag, recommendedModel, settledDefault, setupMissing } from "../src/default-model";

const catalog = loadCatalog();
const rec = (p: string) => recommendedModel(catalog, p);

describe("recommendedModel (from the catalog only)", () => {
  test("a vendor's own family's first slot it serves", () => {
    for (const p of ["anthropic", "codex-oauth", "openai", "google", "deepseek"]) {
      const tag = rec(p);
      expect(tag).toBeDefined();
      expect(providerOfTag(tag!)).toBe(p);
      const row = catalog.models.find((m) => m.key === tag)!;
      const family = catalog.families!.find((f) => (f.vendorProviders ?? []).includes(p))!;
      // It is one of the family's slots, and no slot before it is served by this provider.
      const at = family.slots.findIndex((s) => s.canonicalModelId === row.canonicalModelId);
      expect(at).toBeGreaterThanOrEqual(0);
    }
  });
  test("an aggregator that is no family's vendor recommends nothing", () => {
    const vendors = new Set(catalog.families!.flatMap((f) => f.vendorProviders ?? []));
    const aggregator = catalog.providers.find((p) => !vendors.has(p.id) && catalog.models.some((m) => m.providerId === p.id));
    expect(aggregator).toBeDefined();
    expect(rec(aggregator!.id)).toBeUndefined();
  });
});

describe("effectiveDefault", () => {
  const two = new Set(["anthropic", "openai"]);
  test("a fresh home with no provider has no default", () => {
    expect(effectiveDefault(undefined, new Set(), rec)).toEqual({});
    expect(setupMissing(new Set(), {})).toEqual(["provider", "model"]);
  });
  test("one provider and nothing named: its recommended model, computed", () => {
    expect(effectiveDefault(undefined, new Set(["anthropic"]), rec)).toEqual({ model: rec("anthropic")!, source: "computed" });
  });
  test("several providers and nothing named: none, the person picks", () => {
    const a = effectiveDefault(undefined, two, rec);
    expect(a).toEqual({});
    expect(setupMissing(two, a)).toEqual(["model"]);
  });
  test("a named model whose provider the person has is kept, whatever else is added", () => {
    expect(effectiveDefault("openai/gpt-4.1", two, rec)).toEqual({ model: "openai/gpt-4.1", source: "chosen" });
  });
  test("an older build's written default with no credential for its provider counts as none", () => {
    expect(effectiveDefault("codex-oauth/gpt-5.6-sol", two, rec)).toEqual({});
    expect(effectiveDefault("codex-oauth/gpt-5.6-sol", new Set(["anthropic"]), rec)).toEqual({ model: rec("anthropic")!, source: "computed" });
  });
  test("an aggregator alone recommends nothing: the person picks", () => {
    const vendors = new Set(catalog.families!.flatMap((f) => f.vendorProviders ?? []));
    const agg = catalog.providers.find((p) => !vendors.has(p.id) && catalog.models.some((m) => m.providerId === p.id))!.id;
    expect(effectiveDefault(undefined, new Set([agg]), rec)).toEqual({});
  });
  test("the harness's test doubles need no provider", () => {
    expect(effectiveDefault("winter-test/echo", new Set(), rec)).toEqual({ model: "winter-test/echo", source: "chosen" });
  });
  test("the refusal sentence leads to adding a provider or picking a model", () => {
    expect(noDefaultModelReason(new Set())).toMatch(/add a model provider/);
    expect(noDefaultModelReason(two)).toMatch(/pick one/);
  });
});

// The generated-sequence test: providers added and removed, a default chosen or not, in any order, with the engine's
// settle after every change. The invariants: the default always names a provider the person has, or is absent; adding
// a provider never changes a default there was; removing one changes the default only when it was that provider's;
// a choice is what the default is right after it.
describe("the default over any sequence of changes", () => {
  const vendors = ["anthropic", "codex-oauth", "openai", "google", "deepseek"];
  const vendorSet = new Set(catalog.families!.flatMap((f) => f.vendorProviders ?? []));
  const aggregator = catalog.providers.find((p) => !vendorSet.has(p.id) && catalog.models.some((m) => m.providerId === p.id))!.id;
  const pool = [...vendors, aggregator];
  const tagsOf = (p: string) => catalog.models.filter((m) => m.providerId === p && m.status !== "blocked" && m.status !== "deprecated").map((m) => m.key);

  function rng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 2 ** 32;
    };
  }

  test("2000 sequences of 40 steps", () => {
    for (let seed = 1; seed <= 2000; seed++) {
      const r = rng(seed);
      const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
      // Sometimes an older build's written default to start from.
      let stored: string | undefined = r() < 0.3 ? "codex-oauth/gpt-5.6-sol" : undefined;
      const present = new Set<string>();
      const settle = () => {
        const w = settledDefault(stored, present, rec);
        if (w !== undefined) stored = w;
      };
      settle();
      for (let step = 0; step < 40; step++) {
        const before = effectiveDefault(stored, present, rec).model;
        const roll = r();
        let event: string;
        if (roll < 0.45) {
          const p = pick(pool);
          event = `add ${p}`;
          present.add(p);
          settle();
          const after = effectiveDefault(stored, present, rec).model;
          if (before !== undefined) expect({ seed, step, event, after }).toEqual({ seed, step, event, after: before });
        } else if (roll < 0.8) {
          if (present.size === 0) continue;
          const p = pick([...present]);
          event = `remove ${p}`;
          present.delete(p);
          settle();
          const after = effectiveDefault(stored, present, rec).model;
          if (before !== undefined && providerOfTag(before) !== p) expect({ seed, step, event, after }).toEqual({ seed, step, event, after: before });
        } else {
          if (present.size === 0) continue;
          const tag = pick(tagsOf(pick([...present])));
          event = `choose ${tag}`;
          stored = tag;
          settle();
          expect({ seed, step, event, after: effectiveDefault(stored, present, rec).model }).toEqual({ seed, step, event, after: tag });
        }
        const now = effectiveDefault(stored, present, rec);
        if (now.model !== undefined) expect({ seed, step, event, has: present.has(providerOfTag(now.model)!) }).toEqual({ seed, step, event, has: true });
        // After a settle nothing stays merely computed: one provider with a recommendation is written down.
        expect({ seed, step, event, source: now.source }).not.toEqual({ seed, step, event, source: "computed" });
      }
    }
  });
});
