// The settings window: a dialog over the app, with a searchable list of sections on the left and the
// chosen section's page of settings on the right. The sections are Clover's own (spec §5.8, §12): the
// account and devices, appearance and notifications, plugins with their states, OKs and logs, and each
// computer's level. Pages with nothing to set yet say so. It fills the shell's `settings.section` spot
// with its own sections; a plugin adds one there.
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { IconClose, IconPlugin, IconSearch, SECTION_ICONS } from "./icons";
import { S } from "./strings";
import type { SettingsModalProps, SettingsSection } from "./types";

export const SECTIONS: readonly SettingsSection[] = ["account", "devices", "appearance", "notifications", "plugins", "levels", "bots"];

/** Where the section list breaks into groups, as the dividers show. */
const GROUP_ENDS: ReadonlySet<SettingsSection> = new Set(["devices", "notifications", "levels"]);

/** The settings each page holds, for the search box. */
const INDEX: Record<SettingsSection, string[]> = {
  account: [S.name, S.main],
  devices: [S.devices],
  appearance: [S.theme, S.themePlugin, S.textSize, S.language],
  notifications: [S.notifyNeedsYou, S.notifyAgentDone, S.notifyRoutineFailed, S.notifySounds],
  plugins: [S.plugins, S.pluginManager, S.pluginLogs],
  levels: [S.levels],
  bots: [],
};

export function sectionsMatching(query: string): SettingsSection[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return [...SECTIONS];
  return SECTIONS.filter((s) => S.section[s].toLowerCase().includes(q) || INDEX[s].some((label) => label.toLowerCase().includes(q)));
}

function Row({ label, detail, children }: { label: string; detail?: string; children: ReactNode }) {
  const id = useId();
  return (
    <div className="cl-settings__row" role="group" aria-labelledby={id}>
      <div className="cl-settings__text">
        <span className="cl-settings__label" id={id}>
          {label}
        </span>
        {detail && <span className="cl-settings__detail">{detail}</span>}
      </div>
      <div className="cl-settings__control">{children}</div>
    </div>
  );
}

function Toggle({ label, on, onChange }: { label: string; on: boolean; onChange: (on: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} className="cl-settings__switch" onClick={() => onChange(!on)}>
      <span className="cl-settings__knob" />
    </button>
  );
}

function Choice<T extends string>({ label, value, options, labels, onChange }: { label: string; value: T; options: readonly T[]; labels: Record<T, string>; onChange: (value: T) => void }) {
  return (
    <div className="cl-settings__segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o} type="button" role="radio" aria-checked={o === value} className="cl-settings__segment" onClick={() => onChange(o)}>
          {labels[o]}
        </button>
      ))}
    </div>
  );
}

/** Pairing a device without an account (§8.1): show a code here, or enter the other device's; then check that both
 *  show the same four words. Adding the device is a sealed card. */
function Pairing({ props }: { props: SettingsModalProps }) {
  const [code, setCode] = useState("");
  const p = props.pairing;
  return (
    <section className="cl-settings__pairing" aria-label={S.pairTitle}>
      <h3 className="cl-settings__subhead">{S.pairTitle}</h3>
      {!p ? (
        <>
          <p className="cl-settings__note">{S.pairDetail}</p>
          <div className="cl-settings__control cl-settings__pair-row">
            {props.onPairBegin && (
              <button type="button" className="cl-settings__button" onClick={props.onPairBegin}>
                {S.pairBegin}
              </button>
            )}
            {props.onPairJoin && (
              <form
                className="cl-settings__control"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (code.trim()) props.onPairJoin?.(code.trim());
                }}
              >
                <input className="cl-settings__input" aria-label={S.pairJoinLabel} placeholder={S.pairJoinLabel} value={code} onChange={(e) => setCode(e.target.value)} />
                <button type="submit" className="cl-settings__button" disabled={code.trim() === ""}>
                  {S.pairJoin}
                </button>
              </form>
            )}
          </div>
        </>
      ) : (
        <div className="cl-settings__pair" role="status">
          {p.ended !== undefined ? (
            <p className="cl-settings__note">{p.ended}</p>
          ) : p.words ? (
            <>
              <p className="cl-settings__note">{S.pairWords}</p>
              <p className="cl-settings__pair-words">{p.words.join(" · ")}</p>
            </>
          ) : (
            p.code && (
              <>
                <p className="cl-settings__note">{S.pairCodeNote}</p>
                <p className="cl-settings__pair-code">{p.code}</p>
              </>
            )
          )}
          <div className="cl-settings__control">
            {p.ended === undefined && p.words && props.onPairConfirm && (
              <button type="button" className="cl-settings__button" disabled={p.confirming} onClick={props.onPairConfirm}>
                {p.confirming ? S.pairConfirming : S.pairConfirm}
              </button>
            )}
            <button type="button" className="cl-settings__button" onClick={props.onPairCancel}>
              {p.ended !== undefined ? S.pairClose : S.pairCancel}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function Page({ props }: { props: SettingsModalProps }) {
  const { section, values, onChange } = props;
  const extra = props.extraSections?.find((x) => x.id === section);
  if (extra) return <>{extra.render()}</>;
  if (section === "plugins" && props.logs) {
    const { name, lines, onBack } = props.logs;
    return (
      <>
        <div className="cl-settings__logs-head">
          <button type="button" className="cl-settings__button" onClick={onBack}>
            {S.back}
          </button>
          <h3 className="cl-settings__subhead">{S.pluginLogsFor(name)}</h3>
        </div>
        {lines.length === 0 ? (
          <p className="cl-settings__note">{S.noLogs}</p>
        ) : (
          <pre className="cl-settings__log" aria-label={S.pluginLogsFor(name)}>
            {lines.join("\n")}
          </pre>
        )}
      </>
    );
  }
  switch (section) {
    case "account":
      return (
        <>
          <Row label={S.name} detail={S.nameDetail}>
            <input className="cl-settings__input" aria-label={S.name} value={values.account.name} onChange={(e) => onChange("account.name", e.target.value)} />
          </Row>
          <Row label={S.main} detail={S.mainDetail}>
            <span className="cl-settings__value">{values.account.main}</span>
          </Row>
        </>
      );
    case "appearance":
      return (
        <>
          <Row label={S.theme} detail={S.themeDetail}>
            <Choice label={S.theme} value={values.appearance.theme} options={["light", "dark", "system"] as const} labels={S.themes} onChange={(v) => onChange("appearance.theme", v)} />
          </Row>
          <Row label={S.themePlugin} detail={S.themePluginDetail}>
            <select className="cl-settings__select" aria-label={S.themePlugin} value={values.theme} onChange={(e) => onChange("theme", e.target.value)}>
              {values.themes.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </Row>
          <Row label={S.textSize}>
            <Choice label={S.textSize} value={values.appearance.textSize} options={["small", "default", "large"] as const} labels={S.textSizes} onChange={(v) => onChange("appearance.textSize", v)} />
          </Row>
          <Row label={S.language} detail={S.languageDetail}>
            <span className="cl-settings__value">{values.language.name}</span>
            <button type="button" className="cl-settings__button" onClick={props.onOpenLanguage}>
              {S.change}
            </button>
          </Row>
        </>
      );
    case "notifications":
      return (
        <>
          <Row label={S.notifyNeedsYou} detail={S.notifyNeedsYouDetail}>
            <Toggle label={S.notifyNeedsYou} on={values.notifications.needsYou} onChange={(v) => onChange("notifications.needsYou", v)} />
          </Row>
          <Row label={S.notifyAgentDone}>
            <Toggle label={S.notifyAgentDone} on={values.notifications.agentDone} onChange={(v) => onChange("notifications.agentDone", v)} />
          </Row>
          <Row label={S.notifyRoutineFailed}>
            <Toggle label={S.notifyRoutineFailed} on={values.notifications.routineFailed} onChange={(v) => onChange("notifications.routineFailed", v)} />
          </Row>
          <Row label={S.notifySounds}>
            <Toggle label={S.notifySounds} on={values.notifications.sounds} onChange={(v) => onChange("notifications.sounds", v)} />
          </Row>
        </>
      );
    case "plugins":
      return (
        <>
          <h3 className="cl-settings__subhead">{S.plugins}</h3>
          <p className="cl-settings__note">{S.pluginsDetail}</p>
          {values.plugins.map((p) => (
            <div key={p.id} className="cl-settings__row cl-settings__plugin" role="group" aria-label={p.name} data-state={p.state}>
              <div className="cl-settings__text">
                <span className="cl-settings__label">
                  {p.name}
                  <span className="cl-settings__state" data-state={p.state}>
                    {S.pluginState[p.state]}
                  </span>
                </span>
                <span className="cl-settings__detail">{p.source}</span>
                {p.reason && <span className="cl-settings__detail cl-settings__reason">{p.reason}</span>}
                <span className="cl-settings__detail cl-settings__oks">{S.pluginOks(p.oks)}</span>
              </div>
              <div className="cl-settings__control">
                {props.onOpenPluginLogs && (
                  <button type="button" className="cl-settings__button" aria-label={S.pluginLogsFor(p.name)} onClick={() => props.onOpenPluginLogs?.(p.id)}>
                    {S.pluginLogs}
                  </button>
                )}
                <Toggle label={p.name} on={p.enabled} onChange={(v) => onChange(`plugins.${p.id}.enabled`, v)} />
              </div>
            </div>
          ))}
          {props.onOpenPluginManager && (
            <button type="button" className="cl-settings__button cl-settings__button--wide" onClick={props.onOpenPluginManager}>
              {S.pluginManager}
            </button>
          )}
        </>
      );
    case "levels":
      return (
        <>
          <h3 className="cl-settings__subhead">{S.levels}</h3>
          <p className="cl-settings__note">{S.levelsDetail}</p>
          {values.levels.map((l) => {
            const name = (id: string) => values.levelOptions.find((o) => o.id === id)?.label ?? id;
            const asked = l.requested && l.requested !== l.level ? l.requested : undefined;
            return (
              <Row key={l.computer} label={l.computer} detail={[l.here ? S.thisDevice : "", asked ? S.levelAsked(name(asked)) : ""].filter(Boolean).join(" · ") || undefined}>
                <select
                  className="cl-settings__select"
                  aria-label={S.levelFor(l.computer)}
                  value={l.level}
                  data-requested={asked}
                  disabled={!props.onRequestLevel}
                  onChange={(e) => {
                    // A pick only asks: the select stays at the level that holds until the card is answered.
                    if (e.target.value !== l.level) props.onRequestLevel?.(l.computer, e.target.value);
                  }}
                >
                  {values.levelOptions.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </Row>
            );
          })}
        </>
      );
    case "devices":
      return (
        <>
          <h3 className="cl-settings__subhead">{S.devices}</h3>
          <p className="cl-settings__note">{S.devicesDetail}</p>
          {values.devices.map((d) => (
            <Row key={d.id} label={d.name} detail={[d.here ? S.thisDevice : "", d.main ? S.mainDevice : ""].filter(Boolean).join(" · ") || undefined}>
              {d.kind === "computer" && !d.main && props.onMakeMain && (
                <button type="button" className="cl-settings__button" aria-label={S.makeMain(d.name)} onClick={() => props.onMakeMain?.(d.id)}>
                  {S.makeMainLabel}
                </button>
              )}
              {!d.here && props.onRemoveDevice && (
                <button type="button" className="cl-settings__button" aria-label={S.remove(d.name)} onClick={() => props.onRemoveDevice?.(d.id)}>
                  {S.removeLabel}
                </button>
              )}
            </Row>
          ))}
          {(props.onPairBegin || props.onPairJoin) && <Pairing props={props} />}
        </>
      );
    case "bots":
      if (values.bots && values.bots.length > 0) {
        return (
          <>
            <h3 className="cl-settings__subhead">{S.botsTitle}</h3>
            <p className="cl-settings__note">{S.botsDetail}</p>
            {values.bots.map((b) => (
              <Row key={b.id} label={b.name}>
                {props.onEditBot && (
                  <button type="button" className="cl-settings__button" aria-label={S.editBot(b.name)} onClick={() => props.onEditBot?.(b.id)}>
                    {S.edit}
                  </button>
                )}
              </Row>
            ))}
          </>
        );
      }
      return (
        <div className="cl-settings__later">
          <p className="cl-settings__later-title">{S.later}</p>
          <p className="cl-settings__note">{S.laterDetail}</p>
        </div>
      );
    default:
      return (
        <div className="cl-settings__later">
          <p className="cl-settings__later-title">{S.later}</p>
          <p className="cl-settings__note">{S.laterDetail}</p>
        </div>
      );
  }
}

export function SettingsModal(props: SettingsModalProps) {
  const { section, onSection, onClose } = props;
  const [query, setQuery] = useState("");
  const search = useRef<HTMLInputElement>(null);
  const titleId = useId();
  useEffect(() => search.current?.focus(), []);
  const shown = sectionsMatching(query);
  const q = query.trim().toLowerCase();
  const extras = (props.extraSections ?? []).filter((x) => q.length === 0 || x.title.toLowerCase().includes(q));
  const title = (SECTIONS as readonly string[]).includes(section) ? S.section[section as SettingsSection] : (props.extraSections?.find((x) => x.id === section)?.title ?? "");
  return (
    <div
      className="cl-settings"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <header className="cl-settings__head">
        <h2 className="cl-settings__title" id={titleId}>
          {S.title}
        </h2>
        <button type="button" className="cl-settings__close" aria-label={S.close} onClick={onClose}>
          <IconClose />
        </button>
      </header>
      <div className="cl-settings__body">
        <nav className="cl-settings__nav" aria-label={S.sections}>
          <label className="cl-settings__search">
            <IconSearch />
            <input ref={search} className="cl-settings__search-input" type="search" placeholder={S.search} aria-label={S.search} value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
          <ul className="cl-settings__sections">
            {shown.map((s) => {
              const Icon = SECTION_ICONS[s];
              return (
                <li key={s} data-group-end={(GROUP_ENDS.has(s) && query.length === 0) || undefined}>
                  <button type="button" className="cl-settings__section" aria-current={s === section ? "page" : undefined} onClick={() => onSection(s)}>
                    <Icon />
                    <span>{S.section[s]}</span>
                  </button>
                </li>
              );
            })}
            {extras.map((x) => (
              <li key={x.id}>
                <button type="button" className="cl-settings__section" aria-current={x.id === section ? "page" : undefined} onClick={() => onSection(x.id)}>
                  <IconPlugin />
                  <span>{x.title}</span>
                </button>
              </li>
            ))}
            {shown.length === 0 && extras.length === 0 && <li className="cl-settings__note">{S.noMatch}</li>}
          </ul>
        </nav>
        <section className="cl-settings__page" aria-label={title}>
          <h3 className="cl-settings__page-title">{title}</h3>
          <Page props={props} />
        </section>
      </div>
    </div>
  );
}

