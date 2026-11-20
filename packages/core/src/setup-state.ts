// What the home's setup needs, held by the engine (the setup guide, 2026-11-20): the providers the person added, the
// default model computed from them (`default-model.ts`), and whether the person skipped the guide. Any client asks it
// (`setup.state`) and hears when it changes (`setup_changed`); the apps only draw it. General: nothing here knows a
// window, an app or a plugin.
//
// The providers the person has are read from the credential store and the plugins' sign-ins (`readPresent`), once at
// boot and again whenever a key or a sign-in changes (`refresh`). After each read the default is settled: with exactly
// one provider and no usable named model, its recommended model is written down as the default, so a second provider
// added later never takes it away. A read that fails keeps the last set, so a locked store never wipes anything.
import { SESSIONS_METHODS, type SetupState } from "@waifucave/moss-protocol";
import { ContractError } from "./contracts/common";
import { effectiveDefault, hasProviderOf, settledDefault, setupMissing } from "./default-model";
import { handler, type MethodHandler } from "./rpc/handler";

export interface SetupDeps {
  /** The providers the person added now (a stored key or a plugin sign-in), by catalog provider id. */
  readPresent(): Promise<ReadonlySet<string>>;
  /** The model the settings name as the default, if any. */
  storedModel(): string | undefined;
  /** A provider's recommended model (the catalog's, `recommendedModel`). */
  recommend(provider: string): string | undefined;
  /** Writes the default model into the settings. */
  writeModel(model: string): void;
  dismissed(): boolean;
  writeDismissed(dismissed: boolean): void;
  /** Whether a model is one a picker offers (`models.list`'s rows), for `models.setDefault`. */
  offered(model: string): boolean;
  emit(state: SetupState): void;
  log(line: string): void;
  /** The first set, from the boot's own presence read. */
  seed?: ReadonlySet<string>;
}

export class SetupService {
  #present: ReadonlySet<string>;
  #last: string | undefined;
  #reading: Promise<void> | undefined;

  constructor(private readonly deps: SetupDeps) {
    this.#present = deps.seed ?? new Set();
  }

  /** The providers as last read. */
  present(): ReadonlySet<string> {
    return this.#present;
  }

  /** The default model now, or none. */
  defaultModel(): string | undefined {
    return effectiveDefault(this.deps.storedModel(), this.#present, (p) => this.deps.recommend(p)).model;
  }

  state(): SetupState {
    const answer = effectiveDefault(this.deps.storedModel(), this.#present, (p) => this.deps.recommend(p));
    const providers = [...this.#present].sort();
    const recommended: Record<string, string> = {};
    for (const p of providers) {
      const r = this.deps.recommend(p);
      if (r !== undefined) recommended[p] = r;
    }
    const missing = setupMissing(this.#present, answer);
    return {
      ready: missing.length === 0,
      missing,
      providers,
      ...(answer.model !== undefined && answer.source !== undefined ? { default: { model: answer.model, source: answer.source } } : {}),
      ...(Object.keys(recommended).length > 0 ? { recommended } : {}),
      dismissed: this.deps.dismissed(),
    };
  }

  /** Reads the providers again, settles the default and says so if anything changed. One read at a time; a refresh
   *  asked while one runs waits for it and reads again, so it never misses the change it is for. */
  async refresh(): Promise<SetupState> {
    if (this.#reading !== undefined) await this.#reading.catch(() => undefined);
    this.#reading = this.#read();
    try {
      await this.#reading;
    } finally {
      this.#reading = undefined;
    }
    return this.state();
  }

  async #read(): Promise<void> {
    try {
      this.#present = new Set(await this.deps.readPresent());
    } catch (err) {
      this.deps.log(`[setup] the providers weren't read (${err instanceof Error ? err.name : typeof err}); keeping the last set`);
    }
    this.settle();
  }

  /** Writes the one provider's recommended model when the named one isn't usable, then says what changed. */
  settle(): void {
    const write = settledDefault(this.deps.storedModel(), this.#present, (p) => this.deps.recommend(p));
    if (write !== undefined) {
      try {
        this.deps.writeModel(write);
        this.deps.log(`[setup] the default model is now ${write}, the one provider's recommended model`);
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
    this.deps.writeModel(model);
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
