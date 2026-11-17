// The tab the shell ships: a session's live tab (`main` keyed `agent`, and `panel` keyed `agent` for a coding agent
// opened in the panel): the conversation over the composer. MOSS Code's window has no bot's tab (spec §9.4, G8).
import type { BotRef } from "./local";
import type { EntryProps, SessionView } from "@waifucave/moss-plugin-sdk";
import { Spot, usePluginApi } from "@waifucave/moss-plugin-sdk/ui";
import { useLoad } from "./data";
import { S } from "./strings";
import { BotTab } from "./Window";

/** Who speaks in an agent's transcript: its backend, or its bot for a side thread. */
const speaker = (s: SessionView): BotRef => ({ id: s.bot && s.kind === "side-thread" ? s.bot : (s.backend ?? s.id), name: s.backend ?? s.title ?? s.id });

/** An agent's live tab: watch it, type to it (spec §9.3). Its interrupt and stop buttons are hidden until the host callbacks cover them (backlog: agent-tab controls). In `main` for an agent or a coding
 *  session; in the panel for a bot's coding agent, without a column or code panels of its own (item 90). */
export function AgentTab({ props }: EntryProps<{ route?: string; params?: { session?: string }; app?: string; session?: string }>) {
  const id = props.params?.session ?? props.session;
  const api = usePluginApi();
  const session = useLoad(() => (id && api.sessions?.get ? api.sessions.get(id) : Promise.reject(new Error("no session"))), [api, id]);
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
