// The setup guide (the owner, 2026-11-20: "we should have a setup guide as soon the user opens the app"): what gets a
// person to a first working reply, in three steps: add a model provider (its terms first, then a key or a sign-in),
// the default model (already chosen when one provider was added, with the picker a click away; a picker when several),
// and done, which lands in the default bot's conversation ready to type. Skippable at every step. The engine holds what is
// set up and whether the guide was skipped (`setup.state`), so finishing or skipping it here holds for MOSS Code too.
// MOSS's plain look: neutral greys, the primary action black (light) or near-white (dark), no tint.
import { useEffect, useMemo, useState } from "react";
import { orderProviders, SEARCH_FROM } from "@waifucave/moss-protocol/provider-order";
import { bridge } from "../bridge";
import { SignInRow } from "../settings/SettingsPage";
import type { ModelRow, ProviderRow, SetupRow } from "../../shared/view";

export type SetupStep = "providers" | "model" | "done";

/** A model as the guide names it: "Claude Opus 5.5 · medium" when it has an effort. */
function withEffort(name: string, effort: string | undefined): string {
  return effort === undefined || effort === "" ? name : `${name} · ${effort}`;
}

/** The guide's words (MOSS ships English; its other text is written in place the same way). */
const WORDS = {
  step: (n: number) => `Step ${n} of 3`,
  skip: "Skip for now",
  next: "Next",
  back: "Back",
  welcome: "Welcome to MOSS",
  intro: "MOSS needs a model to talk to. Add a provider: sign in to a subscription you have, or paste an API key.",
  noClaude: "Claude subscriptions can't be used here; an Anthropic Console sign-in (billed to your API account) can.",
  search: "Search providers",
  loading: "Looking for model providers…",
  none: "No model provider is installed. Add a model plugin from Plugins, then come back here.",
  noMatch: "No provider matches that.",
  added: "Added",
  terms: (name: string) => `Read ${name}'s terms`,
  accept: (name: string) => `I accept ${name}'s terms`,
  needOne: "Add one provider to go on.",
  ready: (n: number) => (n === 1 ? "1 provider is added." : `${n} providers are added.`),
  modelTitle: "Your default model",
  modelIntro: "Your bots use this model unless you pick another for one of them in its settings.",
  chosen: "MOSS will use",
  change: "Change",
  pick: "You added more than one provider: pick the model MOSS uses by default.",
  noModels: "None of your providers has a model MOSS can use yet. Go back and add another provider.",
  modelLabel: "Default model",
  doneTitle: "You're set up",
  doneIntro: (model: string, bot: string) => `${model} answers ${bot}'s first message. You can change it, or add providers, in Settings at any time.`,
  talk: (bot: string) => `Talk to ${bot}`,
  failed: "That didn't work. Try again.",
};

export function SetupGuide(props: { setup: SetupRow | undefined; botName: string; initialStep?: SetupStep; onClose: () => void; onDone: () => void }) {
  const [step, setStep] = useState<SetupStep>(props.initialStep ?? "providers");
  const [model, setModel] = useState<{ row: ModelRow; effort?: string } | undefined>(undefined);
  const [note, setNote] = useState<string | undefined>(undefined);
  useEffect(() => { if (props.initialStep !== undefined) setStep(props.initialStep); }, [props.initialStep]);
  const skip = async (): Promise<void> => {
    if (await bridge().skipSetup()) props.onClose();
    else setNote(WORDS.failed);
  };
  const n = step === "providers" ? 1 : step === "model" ? 2 : 3;
  return (
    <div className="setup" role="dialog" aria-modal="true" aria-labelledby="setup-title" data-setup-step={step}>
      <section className="setup__card">
        <p className="setup__step muted small">{WORDS.step(n)}</p>
        {step === "providers" ? <Providers setup={props.setup} onNext={() => { setNote(undefined); setStep("model"); }} onSkip={() => void skip()} />
          : step === "model" ? <Model setup={props.setup} onBack={() => setStep("providers")} onSkip={() => void skip()} onNext={(m, effort) => { setModel({ row: m, ...(effort !== undefined ? { effort } : {}) }); setNote(undefined); setStep("done"); }} />
          : <Done model={withEffort(model?.row.title ?? props.setup?.default?.model ?? "", model !== undefined ? model.effort : props.setup?.default?.effort)} bot={props.botName} onBack={() => setStep("model")} onDone={props.onDone} />}
        {note !== undefined ? <p className="add__note" role="status">{note}</p> : null}
      </section>
    </div>
  );
}

function Actions(props: { onBack?: () => void; onSkip?: () => void; next: { label: string; disabled?: boolean; run: () => void; data: string } }) {
  return (
    <footer className="setup__actions">
      {props.onBack !== undefined ? <button type="button" className="text-button" onClick={props.onBack} data-setup="back">{WORDS.back}</button> : null}
      <span className="setup__gap" />
      {props.onSkip !== undefined ? <button type="button" className="text-button setup__skip" onClick={props.onSkip} data-setup="skip">{WORDS.skip}</button> : null}
      <button type="button" className="text-button text-button--solid" disabled={props.next.disabled === true} onClick={props.next.run} data-setup={props.next.data}>{props.next.label}</button>
    </footer>
  );
}

const added = (p: ProviderRow) => p.auth.some((a) => a.state === "signed-in" || a.state === "refreshing");

/** Step 1: the model providers the installed model plugins offer, each opened to its own way in. */
function Providers(props: { setup: SetupRow | undefined; onNext: () => void; onSkip: () => void }) {
  const [rows, setRows] = useState<ProviderRow[] | "waiting" | undefined>(undefined);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<string | undefined>(undefined);
  const load = (): void => { void bridge().setupProviders().then((r) => setRows("waiting" in r ? "waiting" : r)); };
  useEffect(load, []);
  // A key or a sign-in finished elsewhere (the browser, MOSS Code): read the rows again.
  useEffect(load, [props.setup?.providers.join(",")]);
  // The order both apps' guides share (added, sign-ins, the big API-key providers, then by name); search over all.
  const shown = useMemo(() => (rows === undefined || rows === "waiting" ? [] : orderProviders(rows.map((r) => ({ ...r, id: r.pluginId })), query)), [rows, query]);
  const count = rows === undefined || rows === "waiting" ? 0 : rows.filter(added).length;
  return (
    <>
      <h1 id="setup-title">{WORDS.welcome}</h1>
      <p>{WORDS.intro}</p>
      <p className="muted small">{WORDS.noClaude}</p>
      {rows === undefined ? <p className="muted">{WORDS.loading}</p> : rows === "waiting" || rows.length === 0 ? <p className="muted">{WORDS.none}</p> : (
        <>
          {rows.length >= SEARCH_FROM ? (
            <label className="search setup__search">
              <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3 3" /></svg>
              <input type="search" placeholder={WORDS.search} aria-label={WORDS.search} value={query} onChange={(e) => setQuery(e.target.value)} data-setup-search />
            </label>
          ) : null}
          <ul className="setup__providers">
            {shown.length === 0 ? <li className="muted">{WORDS.noMatch}</li> : shown.map((p) => (
              <Provider key={p.pluginId} row={p} open={open === p.pluginId || shown.length === 1} onToggle={() => setOpen((o) => (o === p.pluginId ? undefined : p.pluginId))} onChanged={load} />
            ))}
          </ul>
        </>
      )}
      <p className="muted small" role="status" data-setup-ready={count}>{count > 0 ? WORDS.ready(count) : WORDS.needOne}</p>
      <Actions onSkip={props.onSkip} next={{ label: WORDS.next, disabled: count === 0, run: props.onNext, data: "next" }} />
    </>
  );
}

function Provider(props: { row: ProviderRow; open: boolean; onToggle: () => void; onChanged: () => void }) {
  const p = props.row;
  const [accepted, setAccepted] = useState(p.terms === undefined || added(p));
  return (
    <li className={`setup__provider${props.open ? " is-open" : ""}`} data-setup-provider={p.pluginId}>
      <button type="button" className="setup__provider-head" onClick={props.onToggle} aria-expanded={props.open}>
        <span>{p.name}</span>
        {added(p) ? <span className="chip chip--on">{WORDS.added}</span> : null}
      </button>
      {props.open ? (
        <div className="setup__provider-body">
          {p.terms !== undefined ? (
            <>
              {"link" in p.terms
                ? <button type="button" className="setup__link" onClick={() => void bridge().openTerms(p.pluginId)}>{WORDS.terms(p.name)}</button>
                : <blockquote className="setup__terms">{p.terms.text}</blockquote>}
              <label className="setup__check"><input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} data-setup-terms={p.pluginId} />{WORDS.accept(p.name)}</label>
            </>
          ) : null}
          <fieldset className="setup__ways" disabled={!accepted}>
            <ul className="kv ma2-keys">
              {p.auth.map((a) => (
                <SignInRow key={a.index} row={{ pluginId: p.pluginId, name: p.name, index: a.index, method: a.method, state: a.state, ...(a.account !== undefined ? { account: a.account } : {}) }} onChanged={props.onChanged} />
              ))}
            </ul>
            {p.auth.map((a) => (a.help !== undefined && a.state !== "signed-in" ? <p key={`h${a.index}`} className="muted small">{a.help}</p> : null))}
          </fieldset>
        </div>
      ) : null}
    </li>
  );
}

/** Step 2: the default model. One provider added: its model is already chosen, the picker a click away. Several: pick. */
function Model(props: { setup: SetupRow | undefined; onBack: () => void; onSkip: () => void; onNext: (m: ModelRow, effort: string | undefined) => void }) {
  const [models, setModels] = useState<ModelRow[] | undefined>(undefined);
  const [setup, setSetup] = useState<SetupRow | undefined>(props.setup);
  const [picking, setPicking] = useState(false);
  const [value, setValue] = useState("");
  const [why, setWhy] = useState<string | undefined>(undefined);
  useEffect(() => {
    void Promise.all([bridge().models(), bridge().setup()]).then(([m, s]) => {
      const ready = "waiting" in m ? [] : m.filter((x) => x.ready);
      const st = "waiting" in s ? props.setup : s;
      setModels(ready);
      setSetup(st);
      const first = st?.default?.model ?? (st?.providers ?? []).map((p) => st?.recommended?.[p]?.model).find((x) => x !== undefined && ready.some((r) => r.id === x)) ?? ready[0]?.id ?? "";
      setValue(first);
    });
  }, []);
  const current = setup?.default?.model;
  const row = (id: string | undefined) => models?.find((m) => m.id === id);
  const groups = useMemo(() => {
    const out = new Map<string, ModelRow[]>();
    for (const m of models ?? []) out.set(m.provider, [...(out.get(m.provider) ?? []), m]);
    return [...out];
  }, [models]);
  const next = async (): Promise<void> => {
    const m = row(value);
    if (m === undefined) return;
    let effort = setup?.default?.effort;
    if (value !== current) {
      const r = await bridge().setDefaultModel(value);
      if (!r.ok) { setWhy(r.why); return; }
      effort = r.setup.default?.effort;
    }
    props.onNext(m, effort);
  };
  const picker = (
    <label className="setup__field">
      <span className="muted small">{WORDS.modelLabel}</span>
      <select className="ma2-field" value={value} onChange={(e) => setValue(e.target.value)} aria-label={WORDS.modelLabel} data-setup-model-picker>
        {groups.map(([provider, ms]) => (
          <optgroup key={provider} label={provider}>
            {ms.map((m) => <option key={m.id} value={m.id}>{m.title}</option>)}
          </optgroup>
        ))}
      </select>
    </label>
  );
  return (
    <>
      <h1 id="setup-title">{WORDS.modelTitle}</h1>
      <p>{WORDS.modelIntro}</p>
      {models === undefined ? <p className="muted">{WORDS.loading}</p> : models.length === 0 ? <p className="muted">{WORDS.noModels}</p>
        : current !== undefined && !picking ? (
          <div className="setup__chosen" data-setup-default={current}>
            <span><span className="muted">{WORDS.chosen} </span><strong>{withEffort(row(current)?.title ?? current, setup?.default?.effort)}</strong><span className="muted"> · {row(current)?.provider ?? current.slice(0, current.indexOf("/"))}</span></span>
            <button type="button" className="text-button" onClick={() => setPicking(true)} data-setup="change">{WORDS.change}</button>
          </div>
        ) : (
          <>
            {current === undefined ? <p className="muted small">{WORDS.pick}</p> : null}
            {picker}
          </>
        )}
      {why !== undefined ? <p className="ma2-why small" role="status">{why}</p> : null}
      <Actions onBack={props.onBack} onSkip={props.onSkip} next={{ label: WORDS.next, disabled: models === undefined || models.length === 0 || value === "", run: () => void next(), data: "next" }} />
    </>
  );
}

/** Step 3: done: the default bot's conversation, ready to type. */
function Done(props: { model: string; bot: string; onBack: () => void; onDone: () => void }) {
  return (
    <>
      <h1 id="setup-title">{WORDS.doneTitle}</h1>
      <p>{WORDS.doneIntro(props.model, props.bot)}</p>
      <Actions onBack={props.onBack} next={{ label: WORDS.talk(props.bot), run: props.onDone, data: "start" }} />
    </>
  );
}
