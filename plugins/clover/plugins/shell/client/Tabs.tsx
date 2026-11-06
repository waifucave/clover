// The tabs the shell ships: a bot's tab (the `bot.tab` entry with no key, which fills every bot without one of its own)
// and an agent's live tab (`main` keyed `agent`, and `panel` keyed `agent` for a bot's coding agent opened from its
// slim column). Each lays out the spots it declares: the conversation over the composer, and the stage above them
// when a plugin fills it. The column beside the conversation (`bot.side`, the session column) is the shell's frame's.
import type { BotRef, EntryProps, SessionView } from "../runtime/types";
import { useLoad } from "./data";
import { Spot, useCore, usePluginApi, useSpotEntries } from "./sdk";
import { S } from "./strings";
import { BotTab } from "./Window";

/** A bot's tab: its main conversation, the composer, and the stage when an avatar plugin stands there. */
export function DefaultBotTab({ props }: EntryProps<{ bot: BotRef; onOpenAgent?: (session: string) => void; onOpenFile?: (path: string) => void }>) {
  const api = usePluginApi();
  const bot = useLoad(() => api.bots?.get(props.bot.id) ?? Promise.reject(new Error("no bots.read")), [api, props.bot.id]);
  const stage = useSpotEntries("bot.stage", undefined, { bot: props.bot }).entries.length > 0;
  if (!bot) return <div className="cl-shell-empty" role="status">{S.loading}</div>;
  const at = { bot: props.bot, session: bot.mainSession };
  return (
    <BotTab
      stage={stage ? <Spot name="bot.stage" props={{ bot: props.bot }} /> : undefined}
      conversation={<Spot name="conversation" props={{ ...at, onOpenAgent: props.onOpenAgent, ...(props.onOpenFile ? { onOpenFile: props.onOpenFile } : {}) }} />}
      composer={<Spot name="composer" props={at} />}
    />
  );
}

/** Who speaks in an agent's transcript: its backend, or its bot for a side thread. */
const speaker = (s: SessionView): BotRef => ({ id: s.bot && s.kind === "side-thread" ? s.bot : (s.backend ?? s.id), name: s.backend ?? s.title ?? s.id });

/** An agent's live tab: watch it, type to it, interrupt it and stop it (spec §9.3). In `main` for an agent or a coding
 *  session; in the panel for a bot's coding agent, without a column or code panels of its own (item 90). */
export function AgentTab({ props }: EntryProps<{ route?: string; params?: { session?: string }; app?: string; session?: string; onOpenFile?: (path: string) => void }>) {
  const id = props.params?.session ?? props.session;
  const api = usePluginApi();
  const core = useCore();
  const session = useLoad(() => (id && api.conversation?.get ? api.conversation.get(id) : Promise.reject(new Error("no session"))), [api, id]);
  if (!id || !session) return <div className="cl-shell-empty" role="status">{S.loading}</div>;
  const at = { bot: speaker(session), session: id, sessionKind: session.kind };
  const running = session.status === "prompting" || session.status === "starting";
  const status = (
      <div className="cl-agent-tab__status">
        <span className="cl-agent-tab__dot" data-status={session.status} aria-hidden="true" />
        <span className="cl-agent-tab__state">{S.agentStatus[session.status] ?? session.status}</span>
        {session.backend && <span className="cl-agent-tab__where">{S.agentOn(session.backend, session.computer)}</span>}
        {core && running && (
          <button type="button" className="cl-agent-tab__action" onClick={() => void core.call("session.interrupt", { id })}>
            {S.interrupt}
          </button>
        )}
        {core && session.status !== "stopped" && session.status !== "failed" && (
          <button type="button" className="cl-agent-tab__action" onClick={() => void core.call("session.stop", { id })}>
            {S.stop}
          </button>
        )}
      </div>
  );
  // The status sits over the composer, clear of the title bar the conversation runs under.
  return (
    <div className="cl-agent-tab" data-place={props.app === "agent" ? "panel" : "main"} data-status={session.status}>
      <BotTab
        conversation={<Spot name="conversation" props={{ ...at, ...(props.onOpenFile ? { onOpenFile: props.onOpenFile } : {}) }} />}
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
