// The Plugins page's first tab: what is installed, grouped (what needs the user, what is on, what is off) and
// searchable, and one plugin opened: what it is, where it came from, what its OK lets it do, the tools it gives, its
// settings (a key only as saved or not, entered in the app's own key dialog), its sign-ins and its log. Removing it and
// signing out ask on a sealed card the core raises; the page says so.
import { useEffect, useState } from "react";
import { CloverMark, IconPlugin, IconSearch } from "./icons";
import { S } from "./strings";
import type { DetailProps, DetailSetting, InstalledGroup, InstalledPlugin, InstalledProps } from "./types";

const GROUP_OF: Record<InstalledPlugin["state"], InstalledGroup> = {
  found: "attention", refused: "attention", invalid: "attention", stopped: "attention",
  running: "on", waiting: "on", off: "off",
};
const GROUPS: InstalledGroup[] = ["attention", "on", "off"];

/** A state in words, with its reason when the reason says more ("Waiting for your OK: waiting for your OK" doesn't). */
export function stateText(state: InstalledPlugin["state"], reason: string | undefined): string {
  const words = S.stateWords[state];
  return reason && reason.trim().toLowerCase() !== words.toLowerCase() ? `${words}: ${reason}` : words;
}

/** The plugins that match a search (name or id, any case), by group, each group by name. */
export function groupInstalled(plugins: readonly InstalledPlugin[], query: string): { group: InstalledGroup; plugins: InstalledPlugin[] }[] {
  const q = query.trim().toLowerCase();
  const hit = (p: InstalledPlugin) => q === "" || p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q) || p.children.some((c) => c.toLowerCase().includes(q));
  return GROUPS.map((group) => ({
    group,
    plugins: plugins.filter((p) => GROUP_OF[p.state] === group && hit(p)).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
  })).filter((g) => g.plugins.length > 0);
}

/** A plugin's picture: its own (an image of its files), Clover's mark for the app's tree, else the puzzle. */
export function PluginIcon({ icon }: { icon: InstalledPlugin["icon"] }) {
  // A picture that doesn't load (none to show, or not a picture the app serves) is the puzzle.
  const [failed, setFailed] = useState<string | undefined>(undefined);
  const url = icon !== undefined && icon !== "clover" ? icon.url : undefined;
  const mayFail = icon !== undefined && icon !== "clover" && icon.mayFail === true;
  return (
    <span className="cl-plugin-index__icon">
      {icon === "clover" ? <CloverMark /> : url !== undefined && failed !== url ? <img src={url} alt="" {...(mayFail ? { onError: () => setFailed(url) } : {})} /> : <IconPlugin />}
    </span>
  );
}

/** The state as a badge, in the list groups' words. */
function StateBadge({ state }: { state: InstalledPlugin["state"] }) {
  const group = GROUP_OF[state];
  return (
    <span className="cl-plugin-index__badge" data-state={state} data-tone={group === "attention" ? "attention" : group === "on" ? "accent" : undefined}>
      {S.groups[group]}
    </span>
  );
}

function Row({ p, onOpen }: { p: InstalledPlugin; onOpen: () => void }) {
  return (
    <li className="cl-plugin-index__result" data-state={p.state}>
      <PluginIcon icon={p.icon} />
      <div className="cl-plugin-index__text">
        <span className="cl-plugin-index__name">
          {p.name}
          {p.dev && <span className="cl-plugin-index__badge" data-tone="attention">{S.dev}</span>}
        </span>
        <span className="cl-plugin-index__meta">
          {[p.id, p.version, p.source, p.children.length > 0 ? S.children(p.children.length) : undefined].filter(Boolean).join(" · ")}
        </span>
        {p.description && <span className="cl-plugin-index__line" title={p.description}>{p.description}</span>}
        {p.notYet && <span className="cl-plugin-index__description" data-not-yet="">{S.notYet}</span>}
        {!p.notYet && p.notYetParts !== undefined && p.notYetParts.length > 0 && <span className="cl-plugin-index__line" data-not-yet-parts="">{S.notYetPartsLine(p.notYetParts.length)}</span>}
        {(GROUP_OF[p.state] !== "on" && GROUP_OF[p.state] !== "off" || p.state === "waiting") && (
          <span className="cl-plugin-index__description" data-tone={p.state === "invalid" ? "danger" : "attention"}>
            {stateText(p.state, p.reason)}
          </span>
        )}
      </div>
      <div className="cl-plugin-index__action">
        <button type="button" className="cl-plugin-index__button" aria-label={S.open(p.name)} onClick={onOpen}>
          {S.openButton}
        </button>
      </div>
    </li>
  );
}

export function Installed(props: InstalledProps) {
  const groups = groupInstalled(props.plugins, props.query);
  return (
    <>
      <form className="cl-plugin-index__search" role="search" onSubmit={(e) => e.preventDefault()}>
        <IconSearch />
        <input className="cl-plugin-index__search-input" type="search" aria-label={S.installedSearch} placeholder={S.installedSearch} value={props.query} onChange={(e) => props.onQuery(e.target.value)} />
      </form>
      {props.loading ? (
        <p className="cl-plugin-index__note" role="status">
          {S.loading}
        </p>
      ) : props.plugins.length === 0 ? (
        <p className="cl-plugin-index__note">{S.installedEmpty}</p>
      ) : groups.length === 0 ? (
        <p className="cl-plugin-index__note">{S.installedNone(props.query.trim())}</p>
      ) : (
        groups.map((g) => (
          <section key={g.group} aria-label={S.groups[g.group]}>
            <h2 className="cl-plugin-index__subhead">{S.groups[g.group]}</h2>
            <ul className="cl-plugin-index__results" aria-label={S.groups[g.group]}>
              {g.plugins.map((p) => (
                <Row key={p.id} p={p} onOpen={() => props.onOpen(p.id)} />
              ))}
            </ul>
          </section>
        ))
      )}
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="cl-plugin-index__section" aria-label={title}>
      <h2 className="cl-plugin-index__subhead">{title}</h2>
      {children}
    </section>
  );
}

/** A plain setting's control. A switch or a choice is saved on the user's click; text and a number on Save or Enter.
 *  What shows is what the core holds: after a save the page reads again, so a refused one goes back, with why on the
 *  page's status line (a card's no or failed yes too, by `plugin_card_note`). */
function SettingEditor({ s, onSetting }: { s: DetailSetting; onSetting: NonNullable<DetailProps["onSetting"]> }) {
  const c = s.control!;
  const held = c.kind === "number" ? (c.value === undefined ? "" : String(c.value)) : c.kind === "text" ? c.value : "";
  const [draft, setDraft] = useState(held);
  useEffect(() => setDraft(held), [held, s]);
  const asks = s.asks === true;
  if (c.kind === "switch") {
    return (
      <button type="button" role="switch" aria-checked={c.value} aria-label={s.title} className="cl-plugin-index__button" onClick={() => onSetting(s.key, !c.value, asks)}>
        {c.value ? S.settingOn : S.settingOff}
      </button>
    );
  }
  if (c.kind === "select") {
    return (
      <select className="cl-plugin-index__field cl-plugin-index__field--short" aria-label={s.title} value={c.value} onChange={(e) => e.target.value !== c.value && onSetting(s.key, e.target.value, asks)}>
        {c.options.some((o) => o.value === c.value) ? null : <option value={c.value} disabled>{c.value}</option>}
        {c.options.map((o) => (
          <option key={o.value} value={o.value}>{o.title}</option>
        ))}
      </select>
    );
  }
  const value = c.kind === "number" ? (draft.trim() === "" ? null : Number(draft)) : draft;
  const changed = draft !== held;
  return (
    <form className="cl-plugin-index__setting-edit" onSubmit={(e) => {
      e.preventDefault();
      if (changed) onSetting(s.key, value, asks);
    }}>
      <input
        className="cl-plugin-index__field"
        aria-label={s.title}
        spellCheck={false}
        {...(c.kind === "number" ? { type: "number", inputMode: "decimal" as const, ...(c.min !== undefined ? { min: c.min } : {}), ...(c.max !== undefined ? { max: c.max } : {}), step: "any" } : {})}
        {...(c.kind === "text" && c.color ? { placeholder: "#rrggbb" } : {})}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
      />
      <button type="submit" className="cl-plugin-index__button" disabled={!changed}>
        {S.settingSave}
      </button>
    </form>
  );
}

export function Detail(props: DetailProps) {
  const p = props.plugin;
  const on = p.state === "running" || p.state === "waiting";
  return (
    <div className="cl-plugin-index__detail" data-plugin={p.id}>
      <button type="button" className="cl-plugin-index__back" onClick={props.onBack}>
        ‹ {S.back}
      </button>
      <header className="cl-plugin-index__head">
        <div className="cl-plugin-index__title-row">
          <PluginIcon icon={p.icon} />
          <h1 className="cl-plugin-index__title">{p.name}</h1>
          <StateBadge state={p.state} />
        </div>
        <div className="cl-plugin-index__actions">
          {
            // Not available in this build yet: no switch, no restart, pin or remove (the state line says why).
            p.state !== "found" && p.state !== "invalid" && !p.notYet && (
              <button type="button" className="cl-plugin-index__button" onClick={() => props.onSwitch(!p.enabled)}>
                {p.enabled ? S.turnOff : S.turnOn}
              </button>
            )
          }
          {(on || p.state === "stopped") && (
            <button type="button" className="cl-plugin-index__button" onClick={props.onRestart}>
              {S.restart}
            </button>
          )}
          {p.updates && props.onPin && !p.notYet && (
            <button type="button" className="cl-plugin-index__button" onClick={() => props.onPin!(!p.pinned)}>
              {p.pinned ? S.letThrough : S.holdBack}
            </button>
          )}
          {!p.notYet && (
            <button type="button" className="cl-plugin-index__button" data-tone="danger" onClick={props.onRemove}>
              {S.remove}
            </button>
          )}
        </div>
      </header>
      <p className="cl-plugin-index__meta">{[p.id, p.version, p.source, p.pinned ? S.pinned : undefined].filter(Boolean).join(" · ")}</p>
      <p className="cl-plugin-index__intro">{p.provenance}</p>
      {p.description && <p className="cl-plugin-index__intro">{p.description}</p>}
      {p.notYet ? (
        <p className="cl-plugin-index__state-line" data-state={p.state} data-not-yet="" role="status">{S.notYet}</p>
      ) : (GROUP_OF[p.state] === "attention" || p.state === "waiting" || p.reason) && (
        <p className="cl-plugin-index__state-line" data-state={p.state} role="status">
          {stateText(p.state, p.reason)}
        </p>
      )}
      {p.notYetParts !== undefined && p.notYetParts.length > 0 && (
        <Section title={S.notYetParts}>
          <ul className="cl-plugin-index__facts" data-not-yet-parts="">
            {p.notYetParts.map((n) => <li key={n}>{n}</li>)}
          </ul>
        </Section>
      )}
      {props.status && (
        <p className="cl-plugin-index__status" data-tone={props.status.tone} role="status">
          {props.status.text}
        </p>
      )}

      <Section title={S.what}>
        {p.oks.length === 0 ? <p className="cl-plugin-index__note">{S.whatNone}</p> : (
          <ul className="cl-plugin-index__facts">
            {p.oks.map((o) => <li key={o}>{o}</li>)}
          </ul>
        )}
      </Section>

      {p.agents.length > 0 && (
        <Section title={S.agents}>
          <ul className="cl-plugin-index__facts">
            {p.agents.map((a) => <li key={a}>{S.agentLine(a)}</li>)}
          </ul>
        </Section>
      )}

      {p.notifies && props.onMute && !p.notYet && (
        <Section title={S.notifications}>
          <div className="cl-plugin-index__index cl-plugin-index__setting">
            <span className="cl-plugin-index__name">{p.muted ? S.muted : S.notMuted}</span>
            <button type="button" role="switch" aria-checked={!p.muted} aria-label={S.notificationsFor(p.name)} className="cl-plugin-index__button" onClick={() => props.onMute!(!p.muted)}>
              {p.muted ? S.unmute : S.mute}
            </button>
          </div>
        </Section>
      )}

      <Section title={S.tools}>
        {p.tools.length === 0 && p.servers.length === 0 ? <p className="cl-plugin-index__note">{S.toolsNone}</p> : (
          <>
            {p.tools.length > 0 && (
              <ul className="cl-plugin-index__facts" aria-label={S.tools}>
                {p.tools.map((t) => <li key={t} className="cl-plugin-index__tool">{t}</li>)}
              </ul>
            )}
            {p.servers.length > 0 && <p className="cl-plugin-index__note">{S.servers(p.servers.join(", "))}</p>}
          </>
        )}
      </Section>

      {!p.notYet && <Section title={S.settings}>
        {p.settings.length === 0 ? <p className="cl-plugin-index__note">{S.settingsNone}</p> : (
          <ul className="cl-plugin-index__indexes">
            {p.settings.map((s) => (
              <li key={s.key} className="cl-plugin-index__index cl-plugin-index__setting" data-setting={s.key}>
                <span className="cl-plugin-index__name">{s.title}</span>
                {s.secret ? (
                  <>
                    <span className="cl-plugin-index__meta">{s.set ? S.keySet : S.keyUnset}</span>
                    <button type="button" className="cl-plugin-index__button" onClick={() => props.onKey({ key: s.key })}>
                      {s.set ? S.keyReplace : S.keyEnter}
                    </button>
                  </>
                ) : s.control && props.onSetting ? (
                  <SettingEditor s={s} onSetting={props.onSetting} />
                ) : (
                  <span className="cl-plugin-index__meta">{s.value ?? ""}</span>
                )}
                {!s.secret && !s.control && <span className="cl-plugin-index__setting-note">{S.settingPerBot}</span>}
                {s.asks && s.control && props.onSetting && <span className="cl-plugin-index__setting-note">{S.settingAsks}</span>}
              </li>
            ))}
          </ul>
        )}
      </Section>}

      {!p.notYet && p.signIns.length > 0 && (
        <Section title={S.signIns}>
          <ul className="cl-plugin-index__indexes">
            {p.signIns.map((a) => (
              <li key={a.index} className="cl-plugin-index__index" data-sign-in={a.index}>
                <span className="cl-plugin-index__name">{a.signedIn ? S.signedIn(a.account) : S.signedOut}</span>
                {a.signedIn ? (
                  <button type="button" className="cl-plugin-index__button" onClick={() => props.onSignOut(a.index)}>
                    {S.signOut}
                  </button>
                ) : (
                  <button type="button" className="cl-plugin-index__button" onClick={() => (a.method === "api-key" ? props.onKey({ index: a.index }) : props.onSignIn(a.index))}>
                    {a.method === "api-key" ? S.keyEnter : S.signIn}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {!p.notYet && (
        <Section title={S.log}>
          {p.log.length === 0 ? <p className="cl-plugin-index__note">{S.logNone}</p> : <pre className="cl-plugin-index__log">{p.log.join("\n")}</pre>}
        </Section>
      )}
    </div>
  );
}
