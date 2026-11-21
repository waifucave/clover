// The person's default model, computed from the providers they added (the owner, 2026-11-20: "we should kind of compute
// the default model by the providers the user added, if he added just one we either compute it from there or give him a
// picker to chose right there"). Pure: the providers the person has come in as a set, read by the caller from the
// credential store and the plugins' sign-ins; nothing here reads a key.
//
// The rule (the reviewer's, 2026-11-21): a model the settings file names is the person's, and the engine never changes it
// on its own, with exactly three exceptions, each written only after a COMPLETE read of the providers (the plugins
// started and their sign-ins read, and no credential slot's probe failed):
//   (i)   no model is named at all;
//   (ii)  the named model is the old fixed default every older build wrote into a fresh home (`LEGACY_DEFAULT_MODEL`)
//         and no Codex credential is there: that file was never a choice;
//   (iii) the person removed the named model's provider in this run (`credential.remove`, a plugin's sign-out).
// In each the default becomes the one provider's recommended model, or none when there isn't exactly one provider.
// Otherwise a named model whose provider isn't seen stays on disk: the state says the default's provider isn't signed
// in (not ready), turns are refused with the sentence that leads back, and once the credential is there again the
// named model is simply the default again. A read that isn't complete honours a named model (it may be one whose
// provider the read missed) and writes nothing. A keyless local provider (a bundled model plugin that takes no key) and
// a plugin-served provider count as had for a named model.
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
  /** A named model kept on disk whose provider a complete read didn't see (no `model` then). */
  signedOut?: string;
}

/** The old fixed default every build before the setup guide wrote into a fresh home, chosen or not. */
export const LEGACY_DEFAULT_MODEL = "codex-oauth/gpt-5.6-sol";

/** What a read of the providers saw. `complete`: the plugins had started and their sign-ins were read, and no slot's
 *  probe failed; only a complete read may write. `keyless`: providers that need no key (a bundled local model plugin),
 *  had for a named model only, never counted as an added provider. */
export interface ProvidersRead {
  present: ReadonlySet<string>;
  complete: boolean;
  keyless?: ReadonlySet<string>;
}

export interface DefaultOptions {
  storedEffort?: string;
  /** Whether the read is complete (default true). */
  complete?: boolean;
  keyless?: ReadonlySet<string>;
}

/** Whether a named model is the untouched older default: the legacy tag with no Codex credential. */
export function isUntouchedLegacy(stored: string | undefined, present: ReadonlySet<string>): boolean {
  return stored === LEGACY_DEFAULT_MODEL && !present.has("codex-oauth");
}

function namedIsHad(stored: string, present: ReadonlySet<string>, keyless: ReadonlySet<string> | undefined): boolean {
  if (hasProviderOf(stored, present)) return true;
  const p = providerOfTag(stored);
  return p !== undefined && keyless !== undefined && keyless.has(p);
}

/** The one provider's recommended model, or none. */
function computed(present: ReadonlySet<string>, recommend: (provider: string) => Recommendation | undefined): DefaultAnswer {
  if (present.size !== 1) return {};
  const rec = recommend([...present][0]!);
  return rec === undefined ? {} : { model: rec.model, source: "computed", ...(rec.effort !== undefined ? { effort: rec.effort } : {}) };
}

/** The default now (see the header). `signedOut` names a named model kept on disk whose provider a complete read didn't
 *  see: there is no default to answer with until it is back. */
export function effectiveDefault(stored: string | undefined, present: ReadonlySet<string>, recommend: (provider: string) => Recommendation | undefined, o: DefaultOptions = {}): DefaultAnswer {
  const complete = o.complete ?? true;
  if (stored !== undefined && !isUntouchedLegacy(stored, present)) {
    if (!complete || namedIsHad(stored, present, o.keyless)) return { model: stored, source: "chosen", ...(o.storedEffort !== undefined ? { effort: o.storedEffort } : {}) };
    return { signedOut: stored };
  }
  return computed(present, recommend);
}

/** What the engine writes as the default after a read, or `undefined` to write nothing. `removed`: providers the
 *  person removed in this run (exception iii). Only a complete read writes; `clear` takes the named model away when
 *  its provider was removed and no single provider's recommendation replaces it. */
export type SettleAction = { kind: "write"; model: string; effort?: string } | { kind: "clear" };

export function settledDefault(stored: string | undefined, read: ProvidersRead, recommend: (provider: string) => Recommendation | undefined, removed: ReadonlySet<string> = new Set()): SettleAction | undefined {
  if (!read.complete) return undefined;
  const p = stored === undefined ? undefined : providerOfTag(stored);
  const removedNamed = stored !== undefined && p !== undefined && removed.has(p) && !namedIsHad(stored, read.present, read.keyless);
  if (stored !== undefined && !isUntouchedLegacy(stored, read.present) && !removedNamed) return undefined;
  const next = computed(read.present, recommend);
  if (next.model !== undefined) return next.model === stored ? undefined : { kind: "write", model: next.model, ...(next.effort !== undefined ? { effort: next.effort } : {}) };
  return removedNamed ? { kind: "clear" } : undefined;
}

/** What is missing before a first reply can come: a provider, then a default model; or the named default's provider
 *  isn't signed in. */
export type SetupMissing = "provider" | "model" | "default-provider";

export function setupMissing(present: ReadonlySet<string>, answer: DefaultAnswer): SetupMissing[] {
  if (answer.signedOut !== undefined) return ["default-provider"];
  if (present.size === 0 && answer.model === undefined) return ["provider", "model"];
  return answer.model === undefined ? ["model"] : [];
}

/** The plain sentence a turn that needs a model and has none is refused with: it leads to adding a provider or picking
 *  a model. */
export const NO_DEFAULT_MODEL_REASON = "There's no model to answer with yet: add a model provider (a key or a sign-in), sign in again to your default model's provider, or pick a default model, in Settings or the setup guide.";

/** The refusal's code, on the `agent_error` and the driver's typed refusal. */
export const NO_DEFAULT_MODEL_CODE = "no_default_model";
