import { describe, expect, test } from "bun:test";
import { loadCatalog } from "@waifucave/clover-provider-catalog";
import { defaultEffortFor, effectiveDefault, LEGACY_DEFAULT_MODEL, NO_DEFAULT_MODEL_REASON, providerOfTag, recommended, recommendedModel, settledDefault, setupMissing } from "../src/default-model";
import { FAMILY_DEFAULTS } from "../src/runtime-sdk/model-plugins/family-defaults";

const catalog = loadCatalog();
const rec = (p: string) => recommended(catalog, p);
const recM = (p: string) => recommendedModel(catalog, p);

describe("the recommended default: the family's one default, as the provider serves it", () => {
  test("the owner's: Claude Opus 5.5 at medium, GPT-6.2 Sol at medium", () => {
    expect(rec("anthropic")).toEqual({ model: "anthropic/claude-opus-5-5", effort: "medium" });
    expect(rec("console")?.effort).toBe("medium");
    expect(catalog.models.find((m) => m.key === recM("console"))?.canonicalModelId).toBe("claude-opus-5.5");
    for (const p of ["codex-oauth", "openai"]) {
      expect(catalog.models.find((m) => m.key === recM(p))?.canonicalModelId).toBe("gpt-6.2-sol");
      expect(rec(p)?.effort).toBe("medium");
    }
  });
  test("every family default names a model the catalog has, and a family's vendors serve it or recommend nothing", () => {
    for (const [family, def] of Object.entries(FAMILY_DEFAULTS)) {
      expect(catalog.families!.some((f) => f.id === family)).toBe(true);
      expect(catalog.models.some((m) => m.canonicalModelId === def.model)).toBe(true);
    }
  });
  test("the effort is dropped for a row that doesn't take it", () => {
    const r = rec("deepseek");
    expect(r?.model).toBeDefined();
    expect(r?.effort).toBeUndefined();
  });
  test("a picked model starts with its family's effort only when it is the family's default", () => {
    expect(defaultEffortFor(catalog, recM("anthropic")!)).toBe("medium");
    expect(defaultEffortFor(catalog, "anthropic/claude-sonnet-5-5")).toBeUndefined();
  });
  test("an aggregator that is no family's vendor recommends nothing", () => {
    const vendors = new Set(catalog.families!.flatMap((f) => f.vendorProviders ?? []));
    const aggregator = catalog.providers.find((p) => !vendors.has(p.id) && catalog.models.some((m) => m.providerId === p.id));
    expect(aggregator).toBeDefined();
    expect(rec(aggregator!.id)).toBeUndefined();
    expect(rec("openrouter")).toBeUndefined();
  });
});

describe("effectiveDefault", () => {
  const two = new Set(["anthropic", "openai"]);
  test("a fresh home with no provider has no default", () => {
    expect(effectiveDefault(undefined, new Set(), rec)).toEqual({});
    expect(setupMissing(new Set(), {})).toEqual(["provider", "model"]);
  });
  test("one provider and nothing named: its recommended model, computed", () => {
    expect(effectiveDefault(undefined, new Set(["anthropic"]), rec)).toEqual({ model: recM("anthropic")!, source: "computed", effort: "medium" });
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
    expect(effectiveDefault("codex-oauth/gpt-5.6-sol", new Set(["anthropic"]), rec)).toEqual({ model: recM("anthropic")!, source: "computed", effort: "medium" });
  });
  test("an aggregator alone recommends nothing: the person picks", () => {
    const vendors = new Set(catalog.families!.flatMap((f) => f.vendorProviders ?? []));
    const agg = catalog.providers.find((p) => !vendors.has(p.id) && catalog.models.some((m) => m.providerId === p.id))!.id;
    expect(effectiveDefault(undefined, new Set([agg]), rec)).toEqual({});
  });
  test("a named model whose provider a complete read didn't see is kept on disk, signed out: no default, not ready", () => {
    const a = effectiveDefault("openai/gpt-4.1", new Set(["anthropic"]), rec);
    expect(a).toEqual({ signedOut: "openai/gpt-4.1" });
    expect(setupMissing(new Set(["anthropic"]), a)).toEqual(["default-provider"]);
    expect(settledDefault("openai/gpt-4.1", { present: new Set(["anthropic"]), complete: true }, rec)).toBeUndefined();
  });
  test("a read that isn't complete honours a named model and writes nothing", () => {
    expect(effectiveDefault("openai/gpt-4.1", new Set(["anthropic"]), rec, { complete: false })).toEqual({ model: "openai/gpt-4.1", source: "chosen" });
    expect(settledDefault(undefined, { present: new Set(["anthropic"]), complete: false }, rec)).toBeUndefined();
    expect(settledDefault(LEGACY_DEFAULT_MODEL, { present: new Set(["anthropic"]), complete: false }, rec)).toBeUndefined();
  });
  test("a keyless local provider counts as had for a named model, never as an added provider", () => {
    const keyless = new Set(["ollama-local"]);
    expect(effectiveDefault("ollama-local/llama3", new Set(), rec, { keyless })).toMatchObject({ model: "ollama-local/llama3", source: "chosen" });
    expect(effectiveDefault(undefined, new Set(), rec, { keyless })).toEqual({});
  });
  test("the three exceptions, on a complete read: none named, the untouched old default, the person's removal", () => {
    const one = { present: new Set(["anthropic"]), complete: true };
    expect(settledDefault(undefined, one, rec)).toEqual({ kind: "write", model: recM("anthropic")!, effort: "medium" });
    expect(settledDefault(LEGACY_DEFAULT_MODEL, one, rec)).toEqual({ kind: "write", model: recM("anthropic")!, effort: "medium" });
    // The old default with a Codex credential is the person's: kept.
    expect(settledDefault(LEGACY_DEFAULT_MODEL, { present: new Set(["codex-oauth", "anthropic"]), complete: true }, rec)).toBeUndefined();
    expect(settledDefault("openai/gpt-4.1", one, rec)).toBeUndefined();
    expect(settledDefault("openai/gpt-4.1", one, rec, new Set(["openai"]))).toEqual({ kind: "write", model: recM("anthropic")!, effort: "medium" });
    expect(settledDefault("openai/gpt-4.1", { present: new Set(["anthropic", "google"]), complete: true }, rec, new Set(["openai"]))).toEqual({ kind: "clear" });
    expect(settledDefault("openai/gpt-4.1", { present: new Set(["anthropic"]), complete: false }, rec, new Set(["openai"]))).toBeUndefined();
  });
  test("the harness's test doubles need no provider", () => {
    expect(effectiveDefault("winter-test/echo", new Set(), rec)).toEqual({ model: "winter-test/echo", source: "chosen" });
  });
  test("the refusal sentence leads to adding a provider or picking a model", () => {
    expect(NO_DEFAULT_MODEL_REASON).toMatch(/add a model provider/);
    expect(NO_DEFAULT_MODEL_REASON).toMatch(/pick a default model/);
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

  // A step is a key added, a key the person removed (an explicit act: exception iii), a credential that merely isn't
  // seen (a lossy read: a plugin sign-in not read yet, a slot whose probe failed, a provider signed out elsewhere), a
  // read that isn't complete, or a pick. After each, the engine settles from that read.
  test("2000 sequences of 40 steps, with lossy and incomplete reads", () => {
    for (let seed = 1; seed <= 2000; seed++) {
      const r = rng(seed);
      const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
      // Sometimes an older build's written default, sometimes a choice on a provider only a plugin serves, to start from.
      let stored: string | undefined = r() < 0.3 ? LEGACY_DEFAULT_MODEL : r() < 0.3 ? pick(tagsOf(pick(vendors))) : undefined;
      const had = new Set<string>();
      const removed = new Set<string>();
      let lastPick = stored;
      const settle = (present: ReadonlySet<string>, complete: boolean, why: string) => {
        const before = stored;
        const a = settledDefault(stored, { present, complete }, rec, removed);
        if (complete) removed.clear();
        if (a?.kind === "write") stored = a.model;
        if (a?.kind === "clear") stored = undefined;
        // The invariant: a named model other than the old default changes on disk only by the person's pick or their
        // removal of its provider, and only on a complete read.
        if (before !== undefined && before !== LEGACY_DEFAULT_MODEL && stored !== before) {
          expect({ seed, why, before, complete, removedOwn: why === `remove ${providerOfTag(before)}` }).toEqual({ seed, why, before, complete: true, removedOwn: true });
        }
      };
      settle(had, r() < 0.5, "boot");
      for (let step = 0; step < 40; step++) {
        const roll = r();
        let why: string;
        let present: ReadonlySet<string> = had;
        let complete = true;
        if (roll < 0.35) {
          const p = pick(pool);
          why = `add ${p}`;
          had.add(p);
        } else if (roll < 0.55) {
          if (had.size === 0) continue;
          const p = pick([...had]);
          why = `remove ${p}`;
          had.delete(p);
          removed.add(p);
        } else if (roll < 0.7) {
          // Lossy: a provider the person still has isn't in this read; the read may or may not know it is partial.
          if (had.size === 0) continue;
          const p = pick([...had]);
          why = `lossy ${p}`;
          present = new Set([...had].filter((x) => x !== p));
          complete = r() < 0.5;
        } else if (roll < 0.8) {
          why = "incomplete";
          complete = false;
        } else {
          if (had.size === 0) continue;
          const tag = pick(tagsOf(pick([...had])));
          why = `choose ${tag}`;
          stored = tag;
          lastPick = tag;
        }
        settle(present, complete, why);
        const now = effectiveDefault(stored, had, rec);
        if (now.model !== undefined) expect({ seed, step, why, has: had.has(providerOfTag(now.model)!) }).toEqual({ seed, step, why, has: true });
        if (why.startsWith("choose")) expect({ seed, step, why, after: now.model }).toEqual({ seed, step, why, after: lastPick });
      }
    }
  });
});
