// The tab the shell ships: a session's live tab (`main` keyed `agent`, and `panel` keyed `agent` for a coding agent
// opened in the panel): the conversation over the composer. MOSS Code's window has no bot's tab (spec §9.4, G8).
import type { BotRef } from "./local";
import type { EntryProps, SessionView } from "@waifucave/moss-plugin-sdk";
import { Spot, useBackendNames, usePluginApi } from "@waifucave/moss-plugin-sdk/ui";
import { useLoad } from "./data";
import { S } from "./strings";
import { BotTab } from "./Window";

/** Who speaks in an agent's transcript: its backend, or its bot for a side thread. */
const speaker = (s: SessionView, nameOf: (backend: string | undefined) => string | undefined): BotRef => ({ id: s.bot && s.kind === "side-thread" ? s.bot : (s.backend ?? s.id), name: nameOf(s.backend) ?? s.title ?? s.id });

/** A session's state and where it runs (its backend on its computer): over the composer in the panel, in the title bar
 *  beside the panel toggles in `main` (so it takes none of the conversation's height and a pinned card fits a short
 *  window). */
export function AgentStatus({ session }: { session: SessionView }) {
  const nameOf = useBackendNames();
  return (
    <div className="cl-agent-tab__status">
      <span className="cl-agent-tab__dot" data-status={session.status} aria-hidden="true" />
      <span className="cl-agent-tab__state">{S.agentStatus[session.status] ?? session.status}</span>
      {session.backend && <span className="cl-agent-tab__where">{S.agentOn(nameOf(session.backend) ?? session.backend, session.computer)}</span>}
    </div>
  );
}

/** An agent's live tab: watch it, type to it (spec §9.3). Its interrupt and stop buttons are hidden until the host callbacks cover them (backlog: agent-tab controls). In `main` for an agent or a coding
 *  session; in the panel for a bot's coding agent, without a column or code panels of its own (item 90). */
export function AgentTab({ props }: EntryProps<{ route?: string; params?: { session?: string }; app?: string; session?: string }>) {
  const id = props.params?.session ?? props.session;
  const api = usePluginApi();
  const nameOf = useBackendNames();
  const session = useLoad(() => (id && api.sessions?.get ? api.sessions.get(id) : Promise.reject(new Error("no session"))), [api, id]);
  if (!id || !session) return <div className="cl-shell-empty" role="status">{S.loading}</div>;
  const at = { bot: speaker(session, nameOf), session: id, sessionKind: session.kind };
  const inPanel = props.app === "agent";
  // In the panel the status sits over the composer; in `main` the shell draws it in the title bar.
  const status = inPanel ? <AgentStatus session={session} /> : null;
  return (
    <div className="cl-agent-tab" data-place={inPanel ? "panel" : "main"} data-status={session.status}>
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
