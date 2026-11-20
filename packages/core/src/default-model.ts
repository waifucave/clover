// The person's default model, computed from the providers they added (the owner, 2026-11-20: "we should kind of compute
// the default model by the providers the user added, if he added just one we either compute it from there or give him a
// picker to chose right there"). Pure: the providers the person has come in as a set, read by the caller from the
// credential store and the plugins' sign-ins; nothing here reads a key.
//
// The rule:
//   * a model the settings file names is the default while its provider is one the person has;
//   * otherwise, with exactly one provider added, the default is that provider's recommended model (below), and the
//     engine writes it down (`settledDefault`), so a second provider added later never takes it away;
//   * otherwise there is none: with several providers the person picks; with none they add one first.
// A model named on disk whose provider the person does not have counts as no default. That is how a settings file an
// older build wrote is told apart: every older build wrote its fixed default (`codex-oauth/gpt-5.6-sol`) into a fresh
// home, chosen or not, so a named model is honoured only while the person holds its provider's key or sign-in. The file
// is never stripped for it (a presence read that failed would otherwise wipe a real choice); the next settle writes the
// computed one over it only when exactly one provider is there.
//
// The recommended model is the provider's family's ONE default (a model and an effort, `FAMILY_DEFAULTS`, the owner's
// for Claude and GPT) as that provider serves it: a family whose `vendorProviders` names the provider, in catalog order,
// and in it a row of that provider whose canonical id is the family's default, which a session can run. A provider
// that is no family's vendor (an aggregator, a local server), or that doesn't serve its family's default, recommends
// nothing, and the person picks.
import type { WinterCatalog } from "@waifucave/clover-provider-catalog";
import { effortVocabularyOf, toolsRefusedFor } from "./runtime-sdk/provider-selection";
import { FAMILY_DEFAULTS, type FamilyDefault } from "./runtime-sdk/model-plugins/family-defaults";

/** The harness's provider-less test doubles (`winter-test/*`): always "had", they need no key. */
const TEST_PREFIX = "winter-test/";

export function providerOfTag(tag: string): string | undefined {
  const slash = tag.indexOf("/");
  return slash > 0 ? tag.slice(0, slash) : undefined;
}

/** Whether the person has the provider a tag names. */
export function hasProviderOf(tag: string, present: ReadonlySet<string>): boolean {
  if (tag.startsWith(TEST_PREFIX)) return true;
  const p = providerOfTag(tag);
  return p !== undefined && present.has(p);
}

/** A recommended default: a model and the effort written with it (absent where the row takes no such effort). */
export interface Recommendation {
  model: string;
  effort?: string;
}

/** The family a model row belongs to (whose `vendorProviders` names its provider), and that family's default. */
function familyOf(catalog: Pick<WinterCatalog, "families">, providerId: string): { id: string; def: FamilyDefault }[] {
  return (catalog.families ?? []).filter((f) => (f.vendorProviders ?? []).includes(providerId) && FAMILY_DEFAULTS[f.id] !== undefined).map((f) => ({ id: f.id, def: FAMILY_DEFAULTS[f.id]! }));
}

/** A provider's recommended default from its family's (see the header), or none. */
export function recommended(catalog: Pick<WinterCatalog, "families" | "models">, providerId: string): Recommendation | undefined {
  for (const { def } of familyOf(catalog, providerId)) {
    const row = catalog.models.find((m) => m.providerId === providerId && m.canonicalModelId === def.model
      && m.status !== "blocked" && m.status !== "deprecated" && !toolsRefusedFor(m));
    if (row === undefined) continue;
    const efforts = effortVocabularyOf(row) ?? [];
    return { model: row.key, ...(def.effort !== undefined && efforts.includes(def.effort) ? { effort: def.effort } : {}) };
  }
  return undefined;
}

/** A provider's recommended model alone. */
export function recommendedModel(catalog: Pick<WinterCatalog, "families" | "models">, providerId: string): string | undefined {
  return recommended(catalog, providerId)?.model;
}

/** The effort a picked model starts with: its family's default effort when it is that family's default model, else none. */
export function defaultEffortFor(catalog: Pick<WinterCatalog, "families" | "models">, tag: string): string | undefined {
  const provider = providerOfTag(tag);
  if (provider === undefined) return undefined;
  const rec = recommended(catalog, provider);
  return rec?.model === tag ? rec.effort : undefined;
}

export type DefaultSource = "chosen" | "computed";

export interface DefaultAnswer {
  /** The default model now, or absent. */
  model?: string;
  /** Its effort: the settings' for a named one, the recommendation's for a computed one. */
  effort?: string;
  /** `chosen`: the settings file names it; `computed`: the one provider's recommended model, not written yet. */
  source?: DefaultSource;
}

/** The default now: the named model while its provider is had, else the one provider's recommended model, else none. */
export function effectiveDefault(stored: string | undefined, present: ReadonlySet<string>, recommend: (provider: string) => Recommendation | undefined, storedEffort?: string): DefaultAnswer {
  if (stored !== undefined && hasProviderOf(stored, present)) return { model: stored, source: "chosen", ...(storedEffort !== undefined ? { effort: storedEffort } : {}) };
  if (present.size === 1) {
    const only = [...present][0]!;
    const rec = recommend(only);
    if (rec !== undefined) return { model: rec.model, source: "computed", ...(rec.effort !== undefined ? { effort: rec.effort } : {}) };
  }
  return {};
}

/** What the engine writes as the default after the providers changed (or at boot), or `undefined` to write nothing: the
 *  one provider's recommended model when the named one isn't usable. Never removes anything. */
export function settledDefault(stored: string | undefined, present: ReadonlySet<string>, recommend: (provider: string) => Recommendation | undefined): Recommendation | undefined {
  const now = effectiveDefault(stored, present, recommend);
  return now.source === "computed" && now.model !== undefined ? { model: now.model, ...(now.effort !== undefined ? { effort: now.effort } : {}) } : undefined;
}

/** What is missing before a first reply can come: a provider, then a default model. */
export type SetupMissing = "provider" | "model";

export function setupMissing(present: ReadonlySet<string>, answer: DefaultAnswer): SetupMissing[] {
  if (present.size === 0 && answer.model === undefined) return ["provider", "model"];
  return answer.model === undefined ? ["model"] : [];
}

/** The plain sentence a turn that needs a model and has none is refused with: it leads to adding a provider or picking
 *  a model. */
export const NO_DEFAULT_MODEL_REASON = "There's no model to answer with yet: add a model provider (a key or a sign-in) or pick a default model, in Settings or the setup guide.";

/** The refusal's code, on the `agent_error` and the driver's typed refusal. */
export const NO_DEFAULT_MODEL_CODE = "no_default_model";
