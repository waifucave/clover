// The plugin index browser: a page in the main area (`main` keyed `plugins`). A search over the indexes the user
// added, each result with where it comes from, whether it is reviewed, and Install, which asks for the plugin's OK on a
// sealed card; then the indexes themselves. Opened from a placeholder (a panel no plugin fills), it says what it is
// looking for and starts with that search.
import { IconOfficial, IconPlugin, IconSearch } from "./icons";
import { S } from "./strings";
import type { IndexResult, InstallState, PluginIndexProps } from "./types";

function whenText(at: number, now: number, format: PluginIndexProps["format"]): string {
  const minutes = Math.round((now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Intl.DateTimeFormat(format?.locale ?? "en-US", { month: "short", day: "numeric", ...(format?.timeZone ? { timeZone: format.timeZone } : {}) }).format(at);
}

function lookingFor(looking: NonNullable<PluginIndexProps["looking"]>): string {
  if (looking.spot === "panel" && looking.key) return S.panelKey(looking.key);
  return looking.key ? S.spotKey(looking.spot, looking.key) : looking.spot;
}

function Result({ r, state, onInstall }: { r: IndexResult; state: InstallState | undefined; onInstall: () => void }) {
  const installed = r.installed !== undefined;
  const newer = installed && r.version !== undefined && r.version !== r.installed;
  return (
    <li className="cl-plugin-index__result">
      <span className="cl-plugin-index__icon">
        <IconPlugin />
      </span>
      <div className="cl-plugin-index__text">
        <span className="cl-plugin-index__name">
          {r.name}
          {r.adult && <span className="cl-plugin-index__badge" data-tone="danger">{S.adult}</span>}
          {!r.official && (
            <span className="cl-plugin-index__badge" data-tone="attention" title={S.notReviewedDetail}>
              {S.notReviewed}
            </span>
          )}
        </span>
        <span className="cl-plugin-index__meta">
          {[r.id, r.version, S.from(r.indexName)].filter(Boolean).join(" · ")}
        </span>
        {r.description && <span className="cl-plugin-index__description">{r.description}</span>}
      </div>
      <div className="cl-plugin-index__action">
        {installed && !state && <span className="cl-plugin-index__state">{newer ? S.update(r.version!) : S.installedVersion(r.installed!)}</span>}
        {state && (
          <span className="cl-plugin-index__state" data-state={state} role="status">
            {S.state[state]}
          </span>
        )}
        {!installed && (!state || state === "failed") && (
          <button type="button" className="cl-plugin-index__install" aria-label={S.installName(r.name)} onClick={onInstall}>
            {S.install}
          </button>
        )}
      </div>
    </li>
  );
}

export function PluginIndex(props: PluginIndexProps) {
  const { query, results, indexes } = props;
  return (
    <div className="cl-plugin-index">
      <div className="cl-plugin-index__page">
        <header className="cl-plugin-index__head">
          <h1 className="cl-plugin-index__title">{S.title}</h1>
          {props.onOpenInstalled && (
            <button type="button" className="cl-plugin-index__button" onClick={props.onOpenInstalled}>
              {S.installed}
            </button>
          )}
        </header>
        <p className="cl-plugin-index__intro">{S.intro}</p>

        <form
          className="cl-plugin-index__search"
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            props.onSearch(query.trim());
          }}
        >
          <IconSearch />
          <input className="cl-plugin-index__search-input" type="search" aria-label={S.search} placeholder={S.search} value={query} onChange={(e) => props.onQuery(e.target.value)} />
          <button type="submit" className="cl-plugin-index__button">
            {S.searchButton}
          </button>
        </form>

        {props.looking && (
          <div className="cl-plugin-index__looking" role="note">
            <p className="cl-plugin-index__looking-title">{S.looking(lookingFor(props.looking))}</p>
            <p className="cl-plugin-index__looking-detail">{S.lookingDetail}</p>
          </div>
        )}

        <h2 className="cl-plugin-index__subhead">{S.results}</h2>
        {props.searching ? (
          <p className="cl-plugin-index__note" role="status">
            {S.searching}
          </p>
        ) : results.length === 0 ? (
          <p className="cl-plugin-index__note">{S.none(query.trim())}</p>
        ) : (
          <ul className="cl-plugin-index__results" aria-label={S.results}>
            {results.map((r) => (
              <Result key={`${r.index}|${r.id}`} r={r} state={props.installs?.[r.id]} onInstall={() => props.onInstall(r)} />
            ))}
          </ul>
        )}

        <h2 className="cl-plugin-index__subhead">{S.indexes}</h2>
        <p className="cl-plugin-index__note">{S.indexesDetail}</p>
        <ul className="cl-plugin-index__indexes" aria-label={S.indexes}>
          {indexes.map((i) => (
            <li key={i.url} className="cl-plugin-index__index">
              <span className="cl-plugin-index__name">
                {i.name ?? i.url}
                {i.official ? (
                  <span className="cl-plugin-index__badge" data-tone="accent">
                    <IconOfficial />
                    {S.official}
                  </span>
                ) : (
                  <span className="cl-plugin-index__badge" data-tone="attention">
                    {S.notReviewed}
                  </span>
                )}
              </span>
              <span className="cl-plugin-index__meta">
                {i.name ? `${i.url} · ` : ""}
                {i.lastCheckedAt ? S.checked(whenText(i.lastCheckedAt, props.now, props.format)) : S.neverChecked}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
