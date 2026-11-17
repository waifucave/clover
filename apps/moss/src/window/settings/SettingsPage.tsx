// MOSS's own Settings, built in (spec §6.10, R8): the account, the keys and sign-ins for models and voices, the approval
// level, the devices, and, drawn generically from each plugin's declared bot-scoped settings, a bot's own choices such
// as its voice. No plugin part is mounted here. A change that is sensitive (an approval level) becomes a sealed card the
// router places in this window.
import { useEffect, useState } from "react";
import { bridge } from "../bridge";
import type { BotRow, BotSetting, SettingsView } from "../../shared/view";

const LEVEL_WORDS: Record<string, string> = { "read-only": "Read only", ask: "Ask before every action", "ask-risky": "Ask before risky actions", "accept-edits": "Ask before risky actions, edits allowed", automatic: "Fully automatic" };

export function SettingsPage(props: { bots: BotRow[]; strip?: React.ReactNode }) {
  const [s, setS] = useState<SettingsView | undefined>(undefined);
  const [bot, setBot] = useState<string | undefined>(props.bots[0]?.id);
  useEffect(() => { void bridge().settings().then(setS); }, []);
  return (
    <main className="page" data-col="conversation" data-page="settings" aria-label="Settings">
      <header className="page__head"><h1>Settings</h1></header>
      {props.strip}
      <div className="page__body">
        <Section title="Account">
          {s === undefined ? null : s.account === "waiting" ? <Waiting what="the account" /> : s.account.signedIn
            ? <p>{s.account.name ?? s.account.email ?? "Signed in"}</p>
            : <p className="muted">Not signed in. Signing in links your computers and phone.</p>}
        </Section>
        <Section title="Keys and sign-ins">
          {s === undefined ? null : s.signIns === "waiting" ? <Waiting what="sign-ins" /> : s.signIns.length === 0 ? <p className="muted">No model or voice needs a key yet.</p> : (
            <ul className="kv">
              {s.signIns.map((x) => (
                <li key={`${x.pluginId}#${x.index}`}>
                  <span>{x.name}</span>
                  <span className={`chip${x.state === "signed-in" ? " chip--on" : " chip--paused"}`}>{x.state === "signed-in" ? (x.account ?? "Signed in") : x.method === "api-key" ? "No key" : "Signed out"}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>
        <Section title="Approval level">
          {s === undefined ? null : s.computers === "waiting" ? <Waiting what="computers" /> : (
            <ul className="kv">
              {s.computers.map((c) => <li key={c.name}><span>{c.name}</span><span className="muted">{LEVEL_WORDS[c.level] ?? c.level}</span></li>)}
            </ul>
          )}
        </Section>
        <Section title="Devices">
          {s === undefined ? null : s.devices === "waiting" ? <Waiting what="devices" /> : s.devices.length === 0 ? <p className="muted">Only this computer.</p> : (
            <ul className="kv">{s.devices.map((d) => <li key={d.id}><span>{d.name}</span><span className="muted">{d.kind}</span></li>)}</ul>
          )}
        </Section>
        <Section title="A bot's own choices">
          {props.bots.length === 0 ? <p className="muted">No bots yet.</p> : (
            <>
              <select value={bot} onChange={(e) => setBot(e.target.value)} aria-label="Which bot">
                {props.bots.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
              {bot !== undefined ? <BotSettings bot={bot} /> : null}
            </>
          )}
        </Section>
      </div>
    </main>
  );
}

function Section(props: { title: string; children: React.ReactNode }) {
  return <section className="settings-section"><h2>{props.title}</h2>{props.children}</section>;
}

function Waiting(props: { what: string }) {
  return <p className="muted">Waiting for the engine's {props.what}.</p>;
}

/** A plugin's declared bot-scoped settings, drawn from their schema: an enum as a choice, a boolean as a switch, a number
 *  or a string as a field. */
function BotSettings(props: { bot: string }) {
  const [rows, setRows] = useState<BotSetting[] | "waiting" | undefined>(undefined);
  const load = (): void => { void bridge().botSettings(props.bot).then((r) => setRows("waiting" in r ? "waiting" : r)); };
  useEffect(load, [props.bot]);
  const set = async (r: BotSetting, value: unknown): Promise<void> => {
    if (await bridge().setBotSetting(props.bot, r.pluginId, r.key, value)) load();
  };
  if (rows === undefined) return null;
  if (rows === "waiting") return <Waiting what="plugins" />;
  if (rows.length === 0) return <p className="muted">No plugin has a setting for this bot.</p>;
  return (
    <ul className="kv">
      {rows.map((r) => (
        <li key={`${r.pluginId}/${r.key}`} data-bot-setting={r.key}>
          <span>{r.title}<span className="muted small"> · {r.pluginName}</span></span>
          {r.type === "enum" ? (
            <select value={String(r.value ?? "")} onChange={(e) => void set(r, e.target.value)} aria-label={r.title}>
              {(r.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.title}</option>)}
            </select>
          ) : r.type === "boolean" ? (
            <input type="checkbox" checked={r.value === true} onChange={(e) => void set(r, e.target.checked)} aria-label={r.title} />
          ) : (
            <input type={r.type === "number" ? "number" : r.type === "color" ? "color" : "text"} defaultValue={String(r.value ?? "")} onBlur={(e) => void set(r, r.type === "number" ? Number(e.target.value) : e.target.value)} aria-label={r.title} />
          )}
        </li>
      ))}
    </ul>
  );
}
