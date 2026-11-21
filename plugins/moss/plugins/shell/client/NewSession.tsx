// A new session (spec §9.4): the person picks a coding agent, any installed one (an `agentBackends` entry a plugin
// brings, MOSS's own `moss-code` among them), and a folder in their own computer's home, and starts it; the window then
// shows its live tab. The folder is chosen in the app's own dialog (`ui.pick`, use `agent.start`): the page holds only a
// token and the folder's name, never a path; `agent.start` is the person's press (`sessions.start`, one call per press).
import { useCore } from "@waifucave/moss-plugin-sdk/ui";
import { useEffect, useState } from "react";
import { plain } from "./local";
import { S } from "./strings";

/** One agent the page offers: its id and name, and whether this computer has it. */
export interface NewSessionAgent {
  id: string;
  name: string;
  installed: boolean;
}

/** The agents `agent.backends` lists, for this computer (`self`), MOSS's own first. A backend that says a person can't start it (`userStartable: false`, MOSS's own subagents) is left out. */
export function agentsHere(backends: readonly { id: string; name: unknown; userStartable?: boolean; computers: readonly { computer: string; installed: boolean }[] }[], here: string | undefined): NewSessionAgent[] {
  const list = backends.filter((b) => b.userStartable !== false).map((b) => ({
    id: b.id,
    name: plain(b.name as never) || b.id,
    installed: b.computers.some((c) => c.installed && (here === undefined || c.computer === here)),
  }));
  // MOSS's own first, then the agents this computer has, then the rest, each group by name.
  const rank = (a: NewSessionAgent) => (a.id === "moss-code" ? 0 : a.installed ? 1 : 2);
  return list.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

/** `layout`: "page" fills the window's main column under the title bar and scrolls; "panel" lays out in whatever container it is put in (a panel or a dialog about 420 to 560 px wide), assuming nothing about the window. */
export function NewSession({ onStarted, layout = "page" }: { onStarted: (session: string) => void; layout?: "page" | "panel" }) {
  const core = useCore();
  const [agents, setAgents] = useState<NewSessionAgent[] | undefined>();
  const [agent, setAgent] = useState<string | undefined>();
  const [folder, setFolder] = useState<{ token: string; name: string } | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    let live = true;
    void Promise.all([
      core?.call("agent.backends", {}).catch(() => ({ backends: [] })),
      core?.call("computer.list", {}).catch(() => ({ computers: [] })),
    ]).then(([b, c]) => {
      if (!live) return;
      const here = ((c as { computers?: { name: string; link?: string }[] } | undefined)?.computers ?? []).find((x) => x.link === "self")?.name;
      const list = agentsHere(((b as { backends?: never[] } | undefined)?.backends ?? []), here);
      setAgents(list);
      setAgent((was) => was ?? list.find((a) => a.installed)?.id);
    });
    return () => { live = false; };
  }, [core]);

  const pickFolder = async () => {
    setError(undefined);
    try {
      const got = (await core?.call("ui.pick", { kind: "folder", use: "agent.start" })) as { token?: string; name?: string; cancelled?: boolean } | undefined;
      if (got?.token !== undefined) setFolder({ token: got.token, name: got.name ?? "" });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const start = async () => {
    if (agent === undefined || folder === undefined) return;
    setError(undefined);
    setStarting(true);
    try {
      const got = (await core?.call("agent.start", { backend: agent, root: folder.token })) as { session?: string } | undefined;
      if (got?.session !== undefined) onStarted(got.session);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  };

  const ready = agent !== undefined && folder !== undefined && !starting;
  return (
    <section className="cl-new-session" data-layout={layout} aria-label={S.newSession}>
      <div className="cl-new-session__page">
        <h1 className="cl-new-session__title">{S.newSession}</h1>
        <p className="cl-new-session__detail">{S.newSessionDetail}</p>
        <AgentList agents={agents} value={agent} onChange={setAgent} />
        <FolderRow folder={folder} onPick={() => void pickFolder()} />
        <div className="cl-new-session__actions">
          <StartButton disabled={!ready} onStart={() => void start()} />
        </div>
        {error !== undefined && <p className="cl-new-session__error" role="alert">{error}</p>}
      </div>
    </section>
  );
}

/** The agents as one row each, the chosen one marked; an agent this computer lacks is a muted row, not selectable. A step of its own. */
export function AgentList({ agents, value, onChange }: { agents: readonly NewSessionAgent[] | undefined; value: string | undefined; onChange: (id: string) => void }) {
  return (
    <div className="cl-new-session__section" role="radiogroup" aria-labelledby="cl-new-session-agents">
      <h2 className="cl-new-session__label" id="cl-new-session-agents">{S.pickAgent}</h2>
      {agents === undefined ? <p className="cl-new-session__status" role="status">{S.loading}</p> : agents.length === 0 ? <p className="cl-new-session__status" role="status">{S.noAgents}</p> : (
        <div className="cl-new-session__agents">
          {agents.map((a) => (
            <label key={a.id} className="cl-new-session__agent" data-installed={a.installed} data-selected={value === a.id}>
              <input type="radio" name="agent" value={a.id} checked={value === a.id} disabled={!a.installed} onChange={() => onChange(a.id)} />
              <span className="cl-new-session__agent-name">{a.name}</span>
              {!a.installed && <span className="cl-new-session__note">{S.notInstalled}</span>}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

/** The folder step: a button that opens the app's own dialog, and the chosen folder's name beside it. */
export function FolderRow({ folder, onPick }: { folder: { name: string } | undefined; onPick: () => void }) {
  return (
    <div className="cl-new-session__section">
      <h2 className="cl-new-session__label">{S.folder}</h2>
      <div className="cl-new-session__folder">
        <button type="button" className="cl-new-session__button" onClick={onPick}>{folder === undefined ? S.pickFolder : S.changeFolder}</button>
        {folder !== undefined && <span className="cl-new-session__folder-name" title={folder.name}>{folder.name}</span>}
      </div>
    </div>
  );
}

/** The one primary button. */
export function StartButton({ disabled, onStart }: { disabled: boolean; onStart: () => void }) {
  return <button type="button" className="cl-new-session__button cl-new-session__start" disabled={disabled} onClick={onStart}>{S.startSession}</button>;
}
