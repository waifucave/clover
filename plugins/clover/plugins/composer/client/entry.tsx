// The composer on the runtime: the `composer` entry, for a bot's tab or an agent's live tab. It sends the user's
// message through `useUserSend` (the app counts it as the user's only from a real key press or click, §5.5),
// stops the turn, switches the model (the `composer` spot's host callbacks, `useComposerHost`: what any entry in the
// spot gets), and shows the level of the computer it runs on
// (the computer's level shows as a label: a change is a sealed card, which the core can't raise for the app yet).
// Each button draws through `composer.action`, keyed by action id, falling back to its own.
//
// The model list comes from the core's `models.list` (the models a session can switch to).
import { useEffect, useState, type ReactNode } from "react";
import { Composer } from "./Composer";
import { CLOVER_LEVELS } from "./levels";
import { S } from "./strings";
import { Spot, useApprovals, useComposerHost, usePluginApi, useUserSend } from "./sdk";
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
    const o = m as { id?: unknown; label?: unknown; name?: unknown; provider?: unknown; providerName?: unknown; signedIn?: unknown };
    if (typeof o.id !== "string") return [];
    const label = typeof o.label === "string" ? o.label : typeof o.name === "string" ? o.name : o.id;
    const detail = typeof o.providerName === "string" ? o.providerName : typeof o.provider === "string" ? o.provider : undefined;
    return [{ id: o.id, label, ...(detail !== undefined ? { detail } : {}), ...(typeof o.signedIn === "boolean" ? { signedIn: o.signedIn } : {}) }];
  });
}

export function ComposerEntry({ props }: { props: ComposerEntryProps }) {
  const api = usePluginApi();
  const host = useComposerHost();
  const send = useUserSend();
  const { cards } = useApprovals();
  const session = useLoad(() => api.conversation?.get?.(props.session), [api, props.session]);
  const kind = session?.kind ?? props.sessionKind;
  const bot = useLoad(() => (kind === "bot" ? api.bots?.get(props.bot.id) : undefined), [api, props.bot.id, kind]);
  const computers = useLoad(() => api.computers?.list?.(), [api]);
  const catalog = useLoad(() => host?.models(), [host]);
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const where = session?.computer ?? bot?.computer;
  const computer = computers?.find((c) => c.name === where);
  const running = session?.status === "prompting" || session?.status === "starting" || session?.status === "cancelling";
  const cardPending = cards.some((c) => c.session === props.session);
  const current = kind === "bot" ? bot?.model : session?.model;
  const effort = kind === "bot" ? bot?.effort : session?.effort;
  const models = modelsOf(catalog);

  const model: ComposerModelChoice | undefined =
    host && current
      ? {
          model: current,
          ...(effort ? { effort } : {}),
          models: models.some((m) => m.id === current) ? models : [{ id: current, label: current }, ...models],
          onChange: ({ model: next, effort: nextEffort }) => {
            // The core's composer spot decides what a switch is (a bot's user layer, or the session's own model).
            void host.setModel(next, nextEffort).catch(() => undefined);
          },
        }
      : undefined;

  return (
    <Composer
      botName={props.bot.name}
      value={draft}
      onChange={(v) => { setNotice(undefined); setDraft(v); }}
      onSend={(message) => {
        // The user's own words, from inside this key press or click: the app's one door for them (`pill.send`).
        if (!send) return;
        setNotice(undefined);
        void send({ session: props.session }, { text: message.text }).then(() => setDraft(""), (err: unknown) => {
          // The send was refused: the draft stays, and the person is told why in a few words (the reason is in the app's log).
          const text = err instanceof Error ? err.message : "";
          setNotice(/isn't running/.test(text) ? S.sendRefusedStopped : /key press or click/.test(text) ? S.sendRefusedGesture : S.sendRefused);
        });
      }}
      notice={notice}
      running={running}
      onStop={host ? () => void host.interrupt().catch(() => undefined) : undefined}
      cardPending={cardPending}
      {...(model ? { model } : {})}
      {...(computer
        ? {
            level: {
              computer: computer.name,
              level: computer.level,
              levels: CLOVER_LEVELS,
              // No onRequest: the core's way to ask for a level change through a sealed card isn't there yet, so the
              // level is a label (computer.setLevel is never called around a card).
            },
          }
        : {})}
      renderAction={(id: ComposerActionId, standard: ReactNode) => (
        <Spot name="composer.action" spotKey={id} props={{ bot: props.bot, session: props.session }} fallback={standard} />
      )}
    />
  );
}
