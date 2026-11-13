// `models.list` (protocol sessions area, owner A; lane B pinned the method on `lane/b-m1-registry` with lane A's
// mapping): the models a session can switch to, read-only, for a model picker in the app, the CLI and the phone (the
// remote role). Built from the model plugins' catalog (`activeCatalog()`, the installed plugins' or the SDK's compiled
// one they are generated from), so a provider whose plugin is off is gone from the picker too.
//
// * **Every model of a provider plugin that is on,** signed in or not (`signedIn` says which), less blocked and
//   vendor-retired rows and every row of a blocked provider: a picker never offers what `session.setModel` refuses.
// * **Only models a session can run:** `llm` providers, and never a row a real turn would refuse tools on
//   (`toolsRefusedFor`), since every Clover session offers tools.
// * **`plugin`** is the plugin that contributes the provider (the installed one's id from its install record, else the
//   bundled `clover/model-<provider>`), and **`providerName`** the name its manifest gives (a `Text`, in the user's
//   locale), else the catalog's.
// * **With `session`,** only the models that session's runtime takes: an agent backend lists its own (lane K), a bot or
//   a coding session on the embedded runtime the whole catalog. An unknown session is `not_found`.
//
// Owner: lane A. The method's spec is the protocol's (`SESSIONS_METHODS.modelsList`).
import { z } from "zod";
import { ModelListing, SESSIONS_METHODS, Text } from "@waifucave/clover-protocol";
import type { WinterCatalog, WinterModelDescriptor } from "@waifucave/clover-provider-catalog";
import { ContractError } from "../contracts/common";
import { handler, type MethodHandler } from "../rpc/handler";
import { activeCatalog } from "./model-plugins/catalog-source";
import { modelPluginId } from "./model-plugins/bundled";
import { installedModelPlugins } from "./model-plugins";
import { effortVocabularyOf, imagesAcceptedBy, toolsRefusedFor } from "./provider-selection";

/** A model as a picker lists it, and the method: the protocol's own (`SESSIONS_METHODS.modelsList`). */
export { ModelListing };
export const MODELS_LIST = SESSIONS_METHODS.modelsList;

export type ModelsListResult = z.infer<typeof MODELS_LIST.result>;

/** What a session's runtime takes: the catalog (the embedded runtime: bots, side threads, coding sessions), or its own
 *  list (an agent backend's models, lane K). `undefined`: no such session. */
export type SessionModels = { kind: "catalog" } | { kind: "own"; models: readonly ModelListing[] };

export interface ModelsListDeps {
  /** Which providers hold a credential now (`credentialPresenceFrom(secrets).byProvider`); read per call. */
  signedIn(): Promise<ReadonlySet<string>> | ReadonlySet<string>;
  /** The user's default model (§6.1), a qualified catalog id. */
  defaultModel?(): string | undefined;
  /** What a session's runtime takes (lanes D and K); without it every session takes the catalog. */
  sessionModels?(session: string): SessionModels | undefined;
  /** Test seam: the catalog. */
  catalog?: () => WinterCatalog;
}

/** The longest effort list and name the protocol carries; the catalog's are inside both (the test pins it). */
const MAX_EFFORTS = 16;
const MAX_EFFORT_CHARS = 32;

/** The provider's contributing plugin and its name, from the installed model plugins, else the bundled tree's. */
function providerFacts(providerId: string, displayName: string): { plugin: string; providerName: Text } {
  const entry = installedModelPlugins()?.snapshot?.set.byProvider.get(providerId);
  if (entry === undefined) return { plugin: modelPluginId(providerId), providerName: displayName };
  const name = (entry.input.entry as { name?: unknown }).name;
  const parsed = Text.safeParse(name);
  return { plugin: entry.input.pluginId, providerName: parsed.success ? parsed.data : displayName };
}

function effortsOf(row: WinterModelDescriptor): { efforts: string[]; defaultEffort?: string } {
  const vocabulary = (effortVocabularyOf(row) ?? []).filter((e) => e.length > 0 && e.length <= MAX_EFFORT_CHARS).slice(0, MAX_EFFORTS);
  const d = row.reasoning?.defaultEffort;
  return { efforts: vocabulary, ...(d !== undefined && vocabulary.includes(d) ? { defaultEffort: d } : {}) };
}

/** Every model a picker may offer, in catalog order. */
export function catalogModelListings(catalog: WinterCatalog, signedIn: ReadonlySet<string>): ModelListing[] {
  const out: ModelListing[] = [];
  for (const p of catalog.providers) {
    if (p.risk.class === "blocked" || p.scope !== "llm") continue;
    const facts = providerFacts(p.id, p.displayName);
    for (const row of catalog.models) {
      if (row.providerId !== p.id) continue;
      if (row.status === "blocked" || row.status === "deprecated") continue;
      if (toolsRefusedFor(row)) continue;
      out.push({
        id: row.key,
        name: row.displayName.length > 0 ? row.displayName : row.upstreamId,
        provider: p.id,
        providerName: facts.providerName,
        plugin: facts.plugin,
        ...effortsOf(row),
        images: imagesAcceptedBy(row),
        signedIn: signedIn.has(p.id),
      });
    }
  }
  return out;
}

/** Whether a model can be set for a bot (`bot.setUserLayer`): `offered` when the picker lists it now; `starting` when
 *  it isn't listed yet but a plugin that is on contributes its provider and the model plugins haven't finished taking
 *  it in (their start or a rebuild still running: the session reopens on their catalog once it lands); else `absent`. */
export type ModelOffer = "offered" | "starting" | "absent";

export function modelOffer(model: string, o: {
  catalog: WinterCatalog;
  /** Whether the model plugins are still starting or rebuilding (not installed yet, or a rebuild running). */
  settling: boolean;
  /** The providers the plugins that are on contribute, by their manifests. */
  contributed(): Iterable<string>;
}): ModelOffer {
  if (catalogModelListings(o.catalog, new Set()).some((m) => m.id === model)) return "offered";
  const slash = model.indexOf("/");
  const provider = slash > 0 ? model.slice(0, slash) : "";
  if (o.settling && provider !== "" && [...o.contributed()].includes(provider)) return "starting";
  return "absent";
}

/** The providers the plugins that are on contribute (`contributes.models[].provider`), by their records. */
export function contributedProviders(records: Iterable<{ enabled?: boolean; manifest?: unknown }>): string[] {
  const out: string[] = [];
  for (const r of records) {
    if (r.enabled === false) continue;
    const models = (r.manifest as { contributes?: { models?: { provider?: unknown }[] } } | undefined)?.contributes?.models ?? [];
    for (const m of models) if (typeof m.provider === "string") out.push(m.provider);
  }
  return out;
}

/** `models.list`'s answer. */
export async function listModels(deps: ModelsListDeps, params: { session?: string }): Promise<ModelsListResult> {
  const def = deps.defaultModel?.();
  const withDefault = (models: readonly ModelListing[]): ModelsListResult => ({
    models: models.slice(0, 10_000),
    ...(def !== undefined && def.length > 0 && def.length <= 200 ? { default: def } : {}),
  });
  if (params.session !== undefined && deps.sessionModels !== undefined) {
    const takes = deps.sessionModels(params.session);
    if (takes === undefined) throw new ContractError("not_found", `no session ${params.session}`);
    if (takes.kind === "own") return withDefault(takes.models);
  }
  const catalog = (deps.catalog ?? activeCatalog)();
  return withDefault(catalogModelListings(catalog, await deps.signedIn()));
}

/** The handler lane C's server mounts. */
export function modelsMethods(deps: ModelsListDeps): Record<string, MethodHandler> {
  return {
    [MODELS_LIST.name]: handler(MODELS_LIST, (params) => listModels(deps, params)),
  };
}
