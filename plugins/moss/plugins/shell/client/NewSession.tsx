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

/** The agents `agent.backends` lists, for this computer (`self`), MOSS's own first. */
export function agentsHere(backends: readonly { id: string; name: unknown; computers: readonly { computer: string; installed: boolean }[] }[], here: string | undefined): NewSessionAgent[] {
  const list = backends.map((b) => ({
    id: b.id,
    name: plain(b.name as never) || b.id,
    installed: b.computers.some((c) => c.installed && (here === undefined || c.computer === here)),
  }));
  return list.sort((a, b) => (a.id === "moss-code" ? -1 : b.id === "moss-code" ? 1 : a.name.localeCompare(b.name)));
}

export function NewSession({ onStarted }: { onStarted: (session: string) => void }) {
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

  return (
    <section className="cl-new-session" aria-label={S.newSession}>
      <h1 className="cl-new-session__title">{S.newSession}</h1>
      <p className="cl-new-session__detail">{S.newSessionDetail}</p>
      <fieldset className="cl-new-session__agents">
        <legend>{S.pickAgent}</legend>
        {agents === undefined ? <p role="status">{S.loading}</p> : agents.length === 0 ? <p role="status">{S.noAgents}</p> : agents.map((a) => (
          <label key={a.id} className="cl-new-session__agent" data-installed={a.installed}>
            <input type="radio" name="agent" value={a.id} checked={agent === a.id} disabled={!a.installed} onChange={() => setAgent(a.id)} />
            <span>{a.name}</span>
            {!a.installed && <span className="cl-new-session__note">{S.notInstalled}</span>}
          </label>
        ))}
      </fieldset>
      <div className="cl-new-session__folder">
        <button type="button" className="cl-new-session__pick" onClick={() => void pickFolder()}>{folder === undefined ? S.pickFolder : S.changeFolder}</button>
        {folder !== undefined && <span className="cl-new-session__folder-name">{folder.name}</span>}
      </div>
      <button type="button" className="cl-new-session__start" disabled={agent === undefined || folder === undefined || starting} onClick={() => void start()}>{S.startSession}</button>
      {error !== undefined && <p className="cl-new-session__error" role="alert">{error}</p>}
    </section>
  );
}
