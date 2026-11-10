// The tabs the shell ships: a bot's tab (the `bot.tab` entry with no key, which fills every bot without one of its own)
// and an agent's live tab (`main` keyed `agent`, and `panel` keyed `agent` for a bot's coding agent opened from its
// slim column). Each lays out the spots it declares: the conversation over the composer, and the stage above them
// when a plugin fills it. The column beside the conversation (`bot.side`, the session column) is the shell's frame's.
import type { BotRef, BotView, EntryProps, SessionView } from "../runtime/types";
import { useEffect, useState } from "react";
import { useLoad } from "./data";
import { Spot, usePluginApi } from "./sdk";
import { S } from "./strings";
import { BotTab } from "./Window";

/** A bot's tab: its main conversation, the composer, and the stage when an avatar plugin stands there. */
export function DefaultBotTab({ props }: EntryProps<{ bot: BotRef; onOpenAgent?: (session: string) => void }>) {
  const api = usePluginApi();
  const bot = useLoad(() => api.bots?.get(props.bot.id) ?? Promise.reject(new Error("no bots.read")), [api, props.bot.id]);
  if (!bot) return <div className="cl-shell-empty" role="status">{S.loading}</div>;
  const stage = bot.avatar !== undefined;
  const at = { bot: props.bot, session: bot.mainSession };
  return (
    <BotTab
      stage={stage ? <Spot name="bot.stage" props={{ bot: props.bot }} /> : undefined}
      conversation={<Spot name="conversation" props={{ ...at, onOpenAgent: props.onOpenAgent }} />}
      composer={<Spot name="composer" props={at} />}
    />
  );
}

/** The `bot.stage` entry: where the bot's avatar stands. It asks the `avatar` spot for the bot's file, keyed by its format
 *  (`vrm`, `live2d`, or a plugin's own); a bot with no avatar has nothing on its stage. */
export function BotStage({ props }: EntryProps<{ bot: BotRef }>) {
  const api = usePluginApi();
  const bot = useLoad(() => api.bots?.get(props.bot.id) ?? Promise.reject(new Error("no bots.read")), [api, props.bot.id]);
  const avatar = bot?.avatar;
  if (!bot || avatar === undefined) return null;
  const portrait = bot.portrait === undefined ? undefined : <img className="cl-bot-stage__portrait" src={bot.portrait} alt="" />;
  return (
    <div className="cl-bot-stage" data-format={avatar.format}>
      <Spot name="avatar" spotKey={avatar.format} props={{ bot: props.bot, src: avatar.src, name: bot.name, ...(bot.portrait === undefined ? {} : { portrait: bot.portrait }) }} fallback={portrait} />
    </div>
  );
}

/** The `bot.header` entry: the bot's name and model, then whatever plugins add through `bot.header.action`. */
export function BotHeader({ props }: EntryProps<{ bot: BotRef }>) {
  const api = usePluginApi();
  // Live: a model pick in the composer changes what the header says.
  // The bot's model changes when the user picks one in the composer. `bots.watch` is the live way; it is also read again every
  // two seconds, so the header never says a model the next turn won't run on for long.
  const [bot, setBot] = useState<BotView | undefined>(undefined);
  useEffect(() => {
    let live = true;
    const read = () => void api.bots?.get(props.bot.id).then((b) => live && setBot(b), () => undefined);
    read();
    const stop = api.bots?.watch((b) => { if (live && b.id === props.bot.id) setBot(b); });
    const timer = setInterval(read, 2000);
    return () => { live = false; clearInterval(timer); stop?.(); };
  }, [api, props.bot.id]);
  return (
    <header className="cl-bot-header">
      <span className="cl-bot-header__name">{props.bot.name}</span>
      {bot && <span className="cl-bot-header__model">{bot.model.slice(bot.model.indexOf("/") + 1)}</span>}
      <Spot name="bot.header.action" props={{ bot: props.bot }} />
    </header>
  );
}

/** Who speaks in an agent's transcript: its backend, or its bot for a side thread. */
const speaker = (s: SessionView): BotRef => ({ id: s.bot && s.kind === "side-thread" ? s.bot : (s.backend ?? s.id), name: s.backend ?? s.title ?? s.id });

/** An agent's live tab: watch it, type to it (spec §9.3). Its interrupt and stop buttons are hidden until the host callbacks cover them (backlog: agent-tab controls). In `main` for an agent or a coding
 *  session; in the panel for a bot's coding agent, without a column or code panels of its own (item 90). */
export function AgentTab({ props }: EntryProps<{ route?: string; params?: { session?: string }; app?: string; session?: string }>) {
  const id = props.params?.session ?? props.session;
  const api = usePluginApi();
  const session = useLoad(() => (id && api.conversation?.get ? api.conversation.get(id) : Promise.reject(new Error("no session"))), [api, id]);
  if (!id || !session) return <div className="cl-shell-empty" role="status">{S.loading}</div>;
  const at = { bot: speaker(session), session: id, sessionKind: session.kind };
  const status = (
      <div className="cl-agent-tab__status">
        <span className="cl-agent-tab__dot" data-status={session.status} aria-hidden="true" />
        <span className="cl-agent-tab__state">{S.agentStatus[session.status] ?? session.status}</span>
        {session.backend && <span className="cl-agent-tab__where">{S.agentOn(session.backend, session.computer)}</span>}
      </div>
  );
  // The status sits over the composer, clear of the title bar the conversation runs under.
  return (
    <div className="cl-agent-tab" data-place={props.app === "agent" ? "panel" : "main"} data-status={session.status}>
      <BotTab
        conversation={<Spot name="conversation" props={at} />}
        composer={
          <>
            {status}
            <Spot name="composer" props={at} />
          </>
        }
      />
    </div>
  );
}
