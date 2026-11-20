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
// The recommended model comes from the catalog alone, never from a table here: the provider's own family (a family whose
// `vendorProviders` names it), in catalog order, and in it the first slot (the catalog's own ranking, best first) the
// provider serves with a row a session can run. A provider that is no family's vendor (an aggregator, a local server)
// recommends nothing, and the person picks.
import type { WinterCatalog } from "@waifucave/clover-provider-catalog";
import { toolsRefusedFor } from "./runtime-sdk/provider-selection";

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

/** A provider's recommended model from the catalog (see the header), or none. */
export function recommendedModel(catalog: Pick<WinterCatalog, "families" | "models">, providerId: string): string | undefined {
  for (const family of catalog.families ?? []) {
    if (!(family.vendorProviders ?? []).includes(providerId)) continue;
    for (const slot of family.slots) {
      const row = catalog.models.find((m) => m.providerId === providerId && m.canonicalModelId === slot.canonicalModelId
        && m.status !== "blocked" && m.status !== "deprecated" && !toolsRefusedFor(m));
      if (row !== undefined) return row.key;
    }
  }
  return undefined;
}

export type DefaultSource = "chosen" | "computed";

export interface DefaultAnswer {
  /** The default model now, or absent. */
  model?: string;
  /** `chosen`: the settings file names it; `computed`: the one provider's recommended model, not written yet. */
  source?: DefaultSource;
}

/** The default now: the named model while its provider is had, else the one provider's recommended model, else none. */
export function effectiveDefault(stored: string | undefined, present: ReadonlySet<string>, recommend: (provider: string) => string | undefined): DefaultAnswer {
  if (stored !== undefined && hasProviderOf(stored, present)) return { model: stored, source: "chosen" };
  if (present.size === 1) {
    const only = [...present][0]!;
    const rec = recommend(only);
    if (rec !== undefined) return { model: rec, source: "computed" };
  }
  return {};
}

/** What the engine writes as the default after the providers changed (or at boot), or `undefined` to write nothing: the
 *  one provider's recommended model when the named one isn't usable. Never removes anything. */
export function settledDefault(stored: string | undefined, present: ReadonlySet<string>, recommend: (provider: string) => string | undefined): string | undefined {
  const now = effectiveDefault(stored, present, recommend);
  return now.source === "computed" ? now.model : undefined;
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
