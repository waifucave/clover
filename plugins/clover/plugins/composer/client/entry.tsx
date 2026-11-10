// The composer on the runtime: the `composer` entry, for a bot's tab or an agent's live tab. It sends the user's
// message through `useUserSend` (the app counts it as the user's only from a real key press or click, §5.5),
// stops the turn (`session.interrupt`), switches the model (a bot's is its user layer, `bot.setUserLayer`; an agent's
// or a coding session's is `session.setModel`), and asks for a level change on the computer it runs on
// (`computer.setLevel`), which is always a sealed card: the pill keeps the old level and shows the one asked for until
// that card is answered. Each button draws through `composer.action`, keyed by action id, falling back to its own.
//
// The model list comes from the core's model catalog (`models.catalog`, the inherited method): its Clover shape is a
// question for lanes A and B.
import { useEffect, useState, type ReactNode } from "react";
import { Composer } from "./Composer";
import { CLOVER_LEVELS } from "./levels";
import type { Level } from "../../shell/runtime/types";
import { Spot, useApprovals, useCore, usePluginApi, useUserSend } from "./sdk";
import type { ComposerActionId, ComposerModel, ComposerModelChoice } from "./types";

type SessionKind = "bot" | "side-thread" | "agent" | "coding";

export interface ComposerEntryProps {
  bot: { id: string; name: string };
  session: string;
  sessionKind?: SessionKind;
}

function useLoad<T>(load: () => Promise<T> | undefined, deps: readonly unknown[]): T | undefined {
  const [value, setValue] = useState<T | undefined>(undefined);
  useEffect(() => {
    let live = true;
    load()?.then((v) => live && setValue(v), () => undefined);
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return value;
}

/** The catalog's models, read defensively: a qualified id, a label, the provider, the efforts. */
function modelsOf(catalog: unknown): ComposerModel[] {
  const list = (catalog as { models?: unknown[] } | undefined)?.models;
  if (!Array.isArray(list)) return [];
  return list.flatMap((m) => {
    const o = m as { id?: unknown; label?: unknown; name?: unknown; provider?: unknown; providerName?: unknown };
    if (typeof o.id !== "string") return [];
    const label = typeof o.label === "string" ? o.label : typeof o.name === "string" ? o.name : o.id;
    const detail = typeof o.providerName === "string" ? o.providerName : typeof o.provider === "string" ? o.provider : undefined;
    return [{ id: o.id, label, ...(detail !== undefined ? { detail } : {}) }];
  });
}

export function ComposerEntry({ props }: { props: ComposerEntryProps }) {
  const api = usePluginApi();
  const core = useCore();
  const send = useUserSend();
  const { cards } = useApprovals();
  const session = useLoad(() => api.conversation?.get?.(props.session), [api, props.session]);
  const kind = session?.kind ?? props.sessionKind;
  const bot = useLoad(() => (kind === "bot" ? api.bots?.get(props.bot.id) : undefined), [api, props.bot.id, kind]);
  const computers = useLoad(() => api.computers?.list?.(), [api]);
  const catalog = useLoad(() => core?.call("models.list", { session: props.session }), [core]);
  const [draft, setDraft] = useState("");
  // A level change asked for, and the card it waits on.
  const [asked, setAsked] = useState<{ level: string; card: string } | undefined>(undefined);
  useEffect(() => {
    if (asked && !cards.some((c) => c.id === asked.card)) setAsked(undefined);
  }, [asked, cards]);

  const where = session?.computer ?? bot?.computer;
  const computer = computers?.find((c) => c.name === where);
  const running = session?.status === "prompting" || session?.status === "starting" || session?.status === "cancelling";
  const cardPending = cards.some((c) => c.session === props.session);
  const current = kind === "bot" ? bot?.model : session?.model;
  const effort = kind === "bot" ? bot?.effort : session?.effort;
  const models = modelsOf(catalog);

  const model: ComposerModelChoice | undefined =
    core && current
      ? {
          model: current,
          ...(effort ? { effort } : {}),
          models: models.some((m) => m.id === current) ? models : [{ id: current, label: current }, ...models],
          onChange: ({ model: next, effort: nextEffort }) => {
            if (kind === "bot") void core.call("bot.setUserLayer", { id: props.bot.id, patch: { model: next, ...(nextEffort ? { effort: nextEffort } : {}) } }).catch(() => undefined);
            else void core.call("session.setModel", { id: props.session, model: next, ...(nextEffort ? { effort: nextEffort } : {}) }).catch(() => undefined);
          },
        }
      : undefined;

  return (
    <Composer
      botName={props.bot.name}
      value={draft}
      onChange={setDraft}
      onSend={(message) => {
        // The user's own words, from inside this key press or click: the app's one door for them (`pill.send`).
        if (!send) return;
        void send({ session: props.session }, { text: message.text }).then(() => setDraft(""), () => undefined);
      }}
      running={running}
      onStop={core ? () => void core.call("session.interrupt", { id: props.session }).catch(() => undefined) : undefined}
      cardPending={cardPending}
      {...(model ? { model } : {})}
      {...(computer && core
        ? {
            level: {
              computer: computer.name,
              level: computer.level,
              levels: CLOVER_LEVELS,
              ...(asked ? { requested: asked.level } : {}),
              onRequest: (level: string) =>
                void core.call("computer.setLevel", { name: computer.name, level: level as Level }).then((r) => {
                  if (!r.applied) setAsked({ level, card: r.card });
                }, () => undefined),
            },
          }
        : {})}
      renderAction={(id: ComposerActionId, standard: ReactNode) => (
        <Spot name="composer.action" spotKey={id} props={{ bot: props.bot, session: props.session }} fallback={standard} />
      )}
    />
  );
}
