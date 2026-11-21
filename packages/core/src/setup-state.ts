// What the home's setup needs, held by the engine (the setup guide, 2026-11-20): the providers the person added, the
// default model computed from them (`default-model.ts`), and whether the person skipped the guide. Any client asks it
// (`setup.state`) and hears when it changes (`setup_changed`); the apps only draw it. General: nothing here knows a
// window, an app or a plugin.
//
// The providers the person has are read from the credential store and the plugins' sign-ins (`readPresent`), once at
// boot, again once the plugins have started, and whenever a key or a sign-in changes (`refresh`). After each read the
// default is settled by `settledDefault` (default-model.ts has the rule): a named model is never changed by the engine
// on its own except when none is named, when it is the untouched older default, or when the person removed its
// provider (`providerRemoved`), and then only after a COMPLETE read. A read that isn't complete, or that fails, writes
// nothing.
import { SESSIONS_METHODS, type SetupState } from "@waifucave/moss-protocol";
import { ContractError } from "./contracts/common";
import { effectiveDefault, hasProviderOf, settledDefault, setupMissing, type DefaultAnswer, type ProvidersRead, type Recommendation } from "./default-model";
import { handler, type MethodHandler } from "./rpc/handler";
import type { CredentialPresence } from "./runtime-sdk/host/selection/runtime-selection";
import type { PluginAuth } from "./runtime-sdk/plugin-auth";

/** The daemon's read of the providers: the credential slots, then the plugins' sign-ins and keyless providers. It is
 *  complete only once the plugins' sign-ins can be read (the registry open, the model plugins started), that read
 *  worked, and no slot's probe failed. */
export async function readProviders(deps: {
  presence(): Promise<Pick<CredentialPresence, "byProvider" | "failedProbes">>;
  auth(): Pick<PluginAuth, "signedInProviders" | "keylessProviders" | "modelPluginsReady"> | undefined;
}): Promise<ProvidersRead & { incomplete?: string }> {
  const presence = await deps.presence();
  const present = new Set(Object.keys(presence.byProvider));
  let incomplete: string | undefined;
  if (presence.failedProbes !== undefined && presence.failedProbes > 0) incomplete = `${presence.failedProbes} credential slot probe(s) failed`;
  const auth = deps.auth();
  let keyless: Set<string> | undefined;
  if (auth === undefined) incomplete ??= "the plugins haven't opened yet";
  else {
    if (!auth.modelPluginsReady()) incomplete ??= "the model plugins haven't started yet";
    try {
      for (const p of await auth.signedInProviders()) present.add(p);
    } catch (err) {
      incomplete ??= `the plugins' sign-ins weren't read (${err instanceof Error ? err.name : typeof err})`;
    }
    keyless = auth.keylessProviders();
  }
  return { present, complete: incomplete === undefined, ...(incomplete !== undefined ? { incomplete } : {}), ...(keyless !== undefined ? { keyless } : {}) };
}

export interface SetupDeps {
  /** The providers the person added now (a stored key or a plugin sign-in), by catalog provider id; whether the read
   *  is complete (`incomplete` says why not, an error's class at most), and the keyless providers. */
  readPresent(): Promise<ProvidersRead & { incomplete?: string }>;
  /** The model the settings name as the default, if any, and its effort. */
  storedModel(): string | undefined;
  storedEffort(): string | undefined;
  /** A provider's recommended default (its family's, `recommended`). */
  recommend(provider: string): Recommendation | undefined;
  /** The effort a picked model starts with (its family's default effort when it is the family's default model). */
  effortFor(model: string): string | undefined;
  /** Writes the default model and its effort (absent: none) into the settings. */
  writeModel(model: string, effort: string | undefined): void;
  /** Takes the default model (and its effort) out of the settings. */
  clearModel(): void;
  dismissed(): boolean;
  writeDismissed(dismissed: boolean): void;
  /** Whether a model is one a picker offers (`models.list`'s rows), for `models.setDefault`. */
  offered(model: string): boolean;
  emit(state: SetupState): void;
  log(line: string): void;
  /** The first set, from the boot's own presence read (never complete: the plugins haven't started). */
  seed?: ReadonlySet<string>;
}

export class SetupService {
  #read: ProvidersRead;
  #last: string | undefined;
  #lastIncomplete: string | undefined;
  /** The read running now, if any: one at a time. */
  #reading: Promise<void> | undefined;
  /** Refreshes asked so far, and the newest of them a finished read covers (each read covers every refresh asked
   *  before it started). */
  #asked = 0;
  #covered = 0;
  /** Providers the person removed in this run, until a complete read settles the default for it (exception iii). */
  readonly #removed = new Set<string>();

  constructor(private readonly deps: SetupDeps) {
    this.#read = { present: deps.seed ?? new Set(), complete: false };
  }

  get #present(): ReadonlySet<string> {
    return this.#read.present;
  }

  #answer(): DefaultAnswer {
    return effectiveDefault(this.deps.storedModel(), this.#present, (p) => this.deps.recommend(p), {
      ...(this.deps.storedEffort() !== undefined ? { storedEffort: this.deps.storedEffort()! } : {}),
      complete: this.#read.complete,
      ...(this.#read.keyless !== undefined ? { keyless: this.#read.keyless } : {}),
    });
  }

  /** The providers as last read. */
  present(): ReadonlySet<string> {
    return this.#present;
  }

  /** The default model now, or none. */
  defaultModel(): string | undefined {
    return this.#answer().model;
  }

  /** Whether the last read was complete. */
  complete(): boolean {
    return this.#read.complete;
  }

  state(): SetupState {
    const answer = this.#answer();
    const providers = [...this.#present].sort();
    const recommended: Record<string, Recommendation> = {};
    for (const p of providers) {
      const r = this.deps.recommend(p);
      if (r !== undefined) recommended[p] = r;
    }
    const missing = setupMissing(this.#present, answer);
    return {
      ready: missing.length === 0,
      missing,
      providers,
      ...(answer.model !== undefined && answer.source !== undefined ? { default: { model: answer.model, source: answer.source, ...(answer.effort !== undefined ? { effort: answer.effort } : {}) } } : {}),
      ...(answer.signedOut !== undefined ? { signedOut: answer.signedOut } : {}),
      ...(Object.keys(recommended).length > 0 ? { recommended } : {}),
      dismissed: this.deps.dismissed(),
    };
  }

  /** Reads the providers again, settles the default and says so if anything changed. One read at a time: a refresh
   *  asked while one runs waits for it, and then ONE more read runs for every refresh asked meanwhile; a read during
   *  which a newer refresh was asked doesn't settle (its set may be old already), the newest read does. */
  async refresh(): Promise<SetupState> {
    const mine = ++this.#asked;
    while (this.#covered < mine) {
      if (this.#reading !== undefined) {
        await this.#reading.catch(() => undefined);
        continue;
      }
      const covers = this.#asked;
      this.#reading = this.#readNow(covers).finally(() => {
        this.#covered = Math.max(this.#covered, covers);
        this.#reading = undefined;
      });
      await this.#reading.catch(() => undefined);
    }
    return this.state();
  }

  async #readNow(covers: number): Promise<void> {
    try {
      const read = await this.deps.readPresent();
      this.#read = { present: new Set(read.present), complete: read.complete, ...(read.keyless !== undefined ? { keyless: new Set(read.keyless) } : {}) };
      const why = read.complete ? undefined : read.incomplete;
      if (why !== undefined && why !== this.#lastIncomplete) this.deps.log(`[setup] the providers' read isn't complete (${why}): the default model is left as it is`);
      this.#lastIncomplete = why;
    } catch (err) {
      // The last set is kept, and it no longer counts as complete: nothing is written from it.
      this.#read = { ...this.#read, complete: false };
      this.deps.log(`[setup] the providers weren't read (${err instanceof Error ? err.name : typeof err}); keeping the last set`);
    }
    // A newer refresh was asked while this read ran: the read after this one settles, from the newer set.
    if (this.#asked > covers) return;
    this.settle();
  }

  /** The person removed a provider (`credential.remove`, a plugin's sign-out): when it served the named default, the
   *  next complete read replaces it (the one provider's recommended model) or takes it away. */
  async providerRemoved(provider: string): Promise<SetupState> {
    this.#removed.add(provider);
    return this.refresh();
  }

  /** Writes what `settledDefault` says after a complete read, then says what changed. */
  settle(): void {
    const action = settledDefault(this.deps.storedModel(), this.#read, (p) => this.deps.recommend(p), this.#removed);
    if (this.#read.complete) this.#removed.clear();
    if (action !== undefined) {
      try {
        if (action.kind === "write") {
          this.deps.writeModel(action.model, action.effort);
          this.deps.log(`[setup] the default model is now ${action.model}${action.effort !== undefined ? ` at ${action.effort}` : ""}, the one provider's recommended model`);
        } else {
          this.deps.clearModel();
          this.deps.log("[setup] the default model's provider was removed: there is no default model until one is picked");
        }
      } catch (err) {
        this.deps.log(`[setup] the default model wasn't written (${err instanceof Error ? err.name : typeof err})`);
      }
    }
    this.#announce();
  }

  #announce(): void {
    const state = this.state();
    const key = JSON.stringify(state);
    if (key === this.#last) return;
    this.#last = key;
    this.deps.emit(state);
  }

  /** The person picks the default model: one a picker offers, whose provider they added. */
  async setDefault(model: string): Promise<SetupState> {
    await this.refresh();
    if (!this.deps.offered(model) && !model.startsWith("winter-test/")) throw new ContractError("invalid", `${model} isn't a model MOSS offers: pick another`);
    if (!hasProviderOf(model, this.#present)) throw new ContractError("invalid", `add ${model.slice(0, model.indexOf("/"))} first (a key or a sign-in), then pick its model`);
    this.deps.writeModel(model, this.deps.effortFor(model));
    this.#announce();
    return this.state();
  }

  dismiss(dismissed: boolean): SetupState {
    this.deps.writeDismissed(dismissed);
    this.#announce();
    return this.state();
  }
}

/** `setup.state`, `setup.dismiss` and `models.setDefault`. */
export function setupMethods(service: SetupService): Record<string, MethodHandler> {
  return {
    [SESSIONS_METHODS.setupState.name]: handler(SESSIONS_METHODS.setupState, () => service.refresh()),
    [SESSIONS_METHODS.setupDismiss.name]: handler(SESSIONS_METHODS.setupDismiss, (p) => service.dismiss(p.dismissed)),
    [SESSIONS_METHODS.modelsSetDefault.name]: handler(SESSIONS_METHODS.modelsSetDefault, async (p) => ({ setup: await service.setDefault(p.model) })),
  };
}
