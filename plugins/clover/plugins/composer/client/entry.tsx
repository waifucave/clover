// The composer on the runtime: the `composer` entry, for a bot's tab or an agent's live tab. It sends the user's
// message through `useUserSend` (the app counts it as the user's only from a real key press or click, §5.5),
// stops the turn, switches the model (the `composer` spot's host callbacks, `useComposerHost`: what any entry in the
// spot gets), and shows the level of the computer it runs on
// (the computer's level shows as a label: a change is a sealed card, which the core can't raise for the app yet).
// Each button draws through `composer.action`, keyed by action id, falling back to its own.
//
// Push-to-talk (spec §6.6): the hold-to-talk control shows only while the bot's voice listens (`host.listenStatus`). A press
// (the button, or Ctrl+Shift+Space in the box) asks the app to record, inside that press (`host.listenStart`); the app records and
// hands the audio to the voice plugin, never this plugin, and the release (`host.listenStop`) answers with the words heard,
// which land in the box after what is there, to edit and send (§6.6 has the app hand audio over; nothing says the words go
// straight to the bot). A refusal or an empty hearing says why in a few words by the box.
//
// The model list comes from the core's `models.list` (the models a session can switch to).
//
// The slash menu lists the running plugins' commands (the host's `commands`, the bundled composer's only) for this kind
// of session, and runs one as the user (`runCommand`) inside the key press or click that picked it. The rest of the line
// goes to that plugin alone, as the command's args (`argsFor`); the line never goes to the bot. The result, or why it
// didn't run, shows as a row above the box, here only: it isn't added to the conversation, so neither the bot nor any
// other plugin reads it.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Composer } from "./Composer";
import { argsFor, inScope, refusalText, resultText, type SlashCommand } from "./slash";
import { CLOVER_LEVELS } from "./levels";
import { appendHeard } from "./keys";
import { S } from "./strings";
import { Spot, useApprovals, useComposerHost, useKept, usePluginApi, useTokens, useUserSend } from "./sdk";
import type { ComposerActionId, ComposerModel, ComposerModelChoice, ComposerSlash, ComposerVoice } from "./types";

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
    const o = m as { id?: unknown; label?: unknown; name?: unknown; provider?: unknown; providerName?: unknown; plugin?: unknown; signedIn?: unknown; efforts?: unknown; defaultEffort?: unknown };
    if (typeof o.id !== "string") return [];
    const label = typeof o.label === "string" ? o.label : typeof o.name === "string" ? o.name : o.id;
    const provider = typeof o.providerName === "string" ? o.providerName : typeof o.provider === "string" ? o.provider : undefined;
    // A model a third-party plugin brings says which plugin it comes from; Clover's own (the `clover` tree) don't.
    const from = typeof o.plugin === "string" && o.plugin.split("/")[0] !== "clover" ? o.plugin : undefined;
    const detail = from === undefined ? provider : provider === undefined ? S.modelFrom(from) : `${provider} · ${S.modelFrom(from)}`;
    const efforts = Array.isArray(o.efforts) ? o.efforts.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
    return [{
      id: o.id, label, ...(detail !== undefined ? { detail } : {}), ...(typeof o.signedIn === "boolean" ? { signedIn: o.signedIn } : {}),
      ...(efforts.length > 0 ? { efforts } : {}),
      ...(typeof o.defaultEffort === "string" && efforts.includes(o.defaultEffort) ? { defaultEffort: o.defaultEffort } : {}),
    }];
  });
}

export function ComposerEntry({ props }: { props: ComposerEntryProps }) {
  const api = usePluginApi();
  const host = useComposerHost();
  const send = useUserSend();
  const { cards } = useApprovals();
  // A pick changes the model the daemon holds (a bot's user layer, or the session's own): the bot and the session are read again
  // after it, so the label says what the next turn runs on.
  const [rev, setRev] = useState(0);
  const session = useLoad(() => api.conversation?.get?.(props.session), [api, props.session, rev]);
  const kind = session?.kind ?? props.sessionKind;
  // The bot's own changes (its voice set or cleared in its settings, the user's layer) reload it, so the talk control follows them.
  const [botRev, setBotRev] = useState(0);
  useEffect(() => {
    if (kind !== "bot") return;
    return api.bots?.watch?.((b) => {
      if (b.id === props.bot.id) setBotRev((n) => n + 1);
    });
  }, [api, props.bot.id, kind]);
  const bot = useLoad(() => (kind === "bot" ? api.bots?.get(props.bot.id) : undefined), [api, props.bot.id, kind, rev, botRev]);
  const computers = useLoad(() => api.computers?.list?.(), [api]);
  const catalog = useLoad(() => host?.models(), [host]);
  // The draft is the user's: it outlives a reload of the window's document (installing or turning on a plugin with
  // its own layer loads it again), per conversation.
  const [draft, setDraft] = useKept<string>(`composer.draft:${props.session}`, "");
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const where = session?.computer ?? bot?.computer;
  const computer = computers?.find((c) => c.name === where);
  const running = session?.status === "prompting" || session?.status === "starting" || session?.status === "cancelling";
  const cardPending = cards.some((c) => c.session === props.session);
  const current = kind === "bot" ? bot?.model : session?.model;
  const effort = kind === "bot" ? bot?.effort : session?.effort;
  const models = modelsOf(catalog);
  const currentModel = models.find((m) => m.id === current);
  const [commands, setCommands] = useState<SlashCommand[] | undefined>(undefined);
  const [slashResult, setSlashResult] = useState<ComposerSlash["result"]>(undefined);

  const slash: ComposerSlash | undefined =
    host?.commands && host.runCommand
      ? {
          commands,
          onOpen: () => {
            setCommands(undefined);
            host.commands!().then(
              (r) => setCommands((Array.isArray(r?.commands) ? r.commands : []).filter((c) => inScope(c, kind))),
              () => setCommands([]),
            );
          },
          onRun: (command, rest, display) => {
            const args = argsFor(command.args, rest, display);
            if (!args.ok) {
              setSlashResult({ name: display, text: args.why, refused: true });
              return;
            }
            setSlashResult(undefined);
            const ran = draft;
            // Called inside the key press or click: the host counts it as the user's only then.
            host.runCommand!(command.name, args.args).then(
              (r) => {
                setSlashResult({ name: display, text: resultText(r?.result), refused: false });
                // The line went to the plugin; anything typed since stays.
                setDraft((d) => (d === ran ? "" : d));
              },
              (err: unknown) => setSlashResult({ name: display, text: refusalText(err), refused: true }),
            );
          },
          ...(slashResult ? { result: slashResult } : {}),
          onDismissResult: () => setSlashResult(undefined),
        }
      : undefined;

  const model: ComposerModelChoice | undefined =
    host && current
      ? {
          model: current,
          ...(effort ? { effort } : {}),
          models: models.some((m) => m.id === current) ? models : [{ id: current, label: current }, ...models],
          ...(currentModel?.efforts ? { efforts: currentModel.efforts } : {}),
          ...(currentModel?.defaultEffort ? { defaultEffort: currentModel.defaultEffort } : {}),
          onChange: ({ model: next, effort: asked }) => {
            // The core's composer spot decides what a switch is (a bot's user layer, or the session's own model).
            setNotice(undefined);
            // A level goes with the model only when that model takes it; one that doesn't gets its own default.
            const to = models.find((m) => m.id === next);
            const nextEffort = to?.efforts !== undefined && asked !== undefined && !to.efforts.includes(asked) ? to.defaultEffort : asked;
            host.setModel(next, nextEffort).then(() => setRev((n) => n + 1), () => setNotice(S.modelRefused));
          },
        }
      : undefined;

  // Does the bot's voice listen now? Read again when its voice changes and when the window comes back (the user may have changed it).
  const [listens, setListens] = useState(false);
  const voiceKey = bot?.voice === undefined ? "" : `${bot.voice.provider}/${bot.voice.voice}`;
  useEffect(() => {
    if (host?.listenStatus === undefined || kind !== "bot") {
      setListens(false);
      return;
    }
    let live = true;
    const read = () => host.listenStatus!().then((r) => live && setListens(r?.listens === true), () => live && setListens(false));
    void read();
    window.addEventListener("focus", read);
    return () => {
      live = false;
      window.removeEventListener("focus", read);
    };
  }, [host, props.bot.id, kind, voiceKey, botRev]);
  const [listening, setListening] = useState(false);
  // A release that answers after a newer press began must not undo it.
  const hold = useRef(0);
  const voice: ComposerVoice | undefined =
    listens && host?.listenStart && host.listenStop
      ? {
          listening,
          onPressStart: () => {
            const mine = ++hold.current;
            setListening(true);
            setNotice(undefined);
            // Called inside the press: the host counts it as the user's only then.
            host.listenStart!().then(
              (r) => {
                if (r?.note !== undefined && hold.current === mine) {
                  setListening(false);
                  setNotice(r.note);
                }
              },
              () => {
                if (hold.current === mine) {
                  setListening(false);
                  setNotice(S.listenRefused);
                }
              },
            );
          },
          onPressEnd: () => {
            const mine = hold.current;
            setListening(false);
            host.listenStop!().then(
              (r) => {
                if (typeof r?.text === "string" && r.text !== "") setDraft((d) => appendHeard(d, r.text!));
                else if (r?.note !== undefined && hold.current === mine) setNotice(r.note);
              },
              () => undefined,
            );
          },
        }
      : undefined;

  // The theme can set the row under the text inside the box (`composer.controls.inside`).
  const tokens = useTokens();
  const controlsInside = Number(tokens["composer.controls.inside"] ?? 0) === 1;

  return (
    <Composer
      controlsInside={controlsInside}
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
      {...(slash ? { slash } : {})}
      {...(model ? { model } : {})}
      {...(voice ? { voice } : {})}
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
