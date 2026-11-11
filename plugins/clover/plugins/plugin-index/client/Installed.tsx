// The Plugins page's first tab: what is installed, grouped (what needs the user, what is on, what is off) and
// searchable, and one plugin opened: what it is, where it came from, what its OK lets it do, the tools it gives, its
// settings (a key only as saved or not, entered in the app's own key dialog), its sign-ins and its log. Removing it,
// signing out and running a revoked one anyway ask on a sealed card the core raises; the page says so.
import { IconPlugin, IconSearch } from "./icons";
import { S } from "./strings";
import type { DetailProps, InstalledGroup, InstalledPlugin, InstalledProps } from "./types";

const GROUP_OF: Record<InstalledPlugin["state"], InstalledGroup> = {
  found: "attention", refused: "attention", invalid: "attention", stopped: "attention", blocked: "attention",
  running: "on", waiting: "on", off: "off",
};
const GROUPS: InstalledGroup[] = ["attention", "on", "off"];

/** The plugins that match a search (name or id, any case), by group, each group by name. */
export function groupInstalled(plugins: readonly InstalledPlugin[], query: string): { group: InstalledGroup; plugins: InstalledPlugin[] }[] {
  const q = query.trim().toLowerCase();
  const hit = (p: InstalledPlugin) => q === "" || p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q) || p.children.some((c) => c.toLowerCase().includes(q));
  return GROUPS.map((group) => ({
    group,
    plugins: plugins.filter((p) => GROUP_OF[p.state] === group && hit(p)).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
  })).filter((g) => g.plugins.length > 0);
}

function Row({ p, onOpen }: { p: InstalledPlugin; onOpen: () => void }) {
  return (
    <li className="cl-plugin-index__result" data-state={p.state}>
      <span className="cl-plugin-index__icon">
        <IconPlugin />
      </span>
      <div className="cl-plugin-index__text">
        <span className="cl-plugin-index__name">
          {p.name}
          {p.dev && <span className="cl-plugin-index__badge" data-tone="attention">{S.dev}</span>}
        </span>
        <span className="cl-plugin-index__meta">
          {[p.id, p.version, p.source, p.children.length > 0 ? S.children(p.children.length) : undefined].filter(Boolean).join(" · ")}
        </span>
        {(GROUP_OF[p.state] === "attention" || p.state === "waiting") && (
          <span className="cl-plugin-index__description" data-tone={p.state === "blocked" || p.state === "invalid" ? "danger" : "attention"}>
            {S.stateWords[p.state]}
            {p.reason ? `: ${p.reason}` : ""}
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

export function Detail(props: DetailProps) {
  const p = props.plugin;
  const on = p.state === "running" || p.state === "waiting";
  return (
    <div className="cl-plugin-index__detail" data-plugin={p.id}>
      <button type="button" className="cl-plugin-index__back" onClick={props.onBack}>
        ‹ {S.back}
      </button>
      <header className="cl-plugin-index__head">
        <h1 className="cl-plugin-index__title">{p.name}</h1>
        <div className="cl-plugin-index__actions">
          {p.state === "blocked" ? (
            p.revoked && (
              <button type="button" className="cl-plugin-index__button" onClick={props.onRunAnyway}>
                {S.runAnyway}
              </button>
            )
          ) : (
            p.state !== "found" && p.state !== "invalid" && (
              <button type="button" className="cl-plugin-index__button" onClick={() => props.onSwitch(!p.enabled)}>
                {p.enabled ? S.turnOff : S.turnOn}
              </button>
            )
          )}
          {(on || p.state === "stopped") && (
            <button type="button" className="cl-plugin-index__button" onClick={props.onRestart}>
              {S.restart}
            </button>
          )}
          {p.updates && props.onPin && (
            <button type="button" className="cl-plugin-index__button" onClick={() => props.onPin!(!p.pinned)}>
              {p.pinned ? S.letThrough : S.holdBack}
            </button>
          )}
          <button type="button" className="cl-plugin-index__button" data-tone="danger" onClick={props.onRemove}>
            {S.remove}
          </button>
        </div>
      </header>
      <p className="cl-plugin-index__meta">{[p.id, p.version, p.source, p.pinned ? S.pinned : undefined].filter(Boolean).join(" · ")}</p>
      <p className="cl-plugin-index__intro">{p.provenance}</p>
      {p.description && <p className="cl-plugin-index__intro">{p.description}</p>}
      <p className="cl-plugin-index__state-line" data-state={p.state} role="status">
        {S.stateWords[p.state]}
        {p.reason ? `: ${p.reason}` : ""}
      </p>
      {p.state === "blocked" && <p className="cl-plugin-index__note">{S.blockedNote}</p>}
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

      <Section title={S.settings}>
        {p.settings.length === 0 ? <p className="cl-plugin-index__note">{S.settingsNone}</p> : (
          <ul className="cl-plugin-index__indexes">
            {p.settings.map((s) => (
              <li key={s.key} className="cl-plugin-index__index cl-plugin-index__setting" data-setting={s.key}>
                <span className="cl-plugin-index__name">{s.title}</span>
                <span className="cl-plugin-index__meta">{s.secret ? (s.set ? S.keySet : S.keyUnset) : (s.value ?? "")}</span>
                {s.secret && (
                  <button type="button" className="cl-plugin-index__button" onClick={() => props.onKey({ key: s.key })}>
                    {s.set ? S.keyReplace : S.keyEnter}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>

      {p.signIns.length > 0 && (
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

      <Section title={S.log}>
        {p.log.length === 0 ? <p className="cl-plugin-index__note">{S.logNone}</p> : <pre className="cl-plugin-index__log">{p.log.join("\n")}</pre>}
      </Section>
    </div>
  );
}
