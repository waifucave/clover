// The settings window: a dialog over the app, with a searchable list of sections on the left and the
// chosen section's page of settings on the right. Pages with something to set now are drawn; the rest
// say they fill in later. It fills the shell's `settings.section` spot with its own sections; a
// plugin adds one there.
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { S } from "./strings";
import type { SettingsModalProps, SettingsSection } from "./types";

export const SECTIONS: readonly SettingsSection[] = [
  "account", "usage", "appearance", "bots", "capabilities", "notifications", "privacy", "customize", "code", "devices", "desktop",
];

/** Where the section list breaks into groups, as the dividers show. */
const GROUP_ENDS: ReadonlySet<SettingsSection> = new Set(["usage", "privacy", "devices"]);

/** The settings each page holds, for the search box. */
const INDEX: Record<SettingsSection, string[]> = {
  account: [S.name, S.main],
  usage: [],
  appearance: [S.theme, S.textSize, S.language],
  bots: [],
  capabilities: [],
  notifications: [S.notifyNeedsYou, S.notifyAgentDone, S.notifyRoutineFailed, S.notifySounds],
  privacy: [],
  customize: [S.plugins, S.appTheme],
  code: [S.branchPrefix, S.labelSessions, S.transcript, S.draftPrs, S.outputStyle],
  devices: [S.devices],
  desktop: [],
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

function Page({ props }: { props: SettingsModalProps }) {
  const { section, values, onChange } = props;
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
    case "customize":
      return (
        <>
          <Row label={S.appTheme}>
            <select className="cl-settings__select" aria-label={S.appTheme} value={values.theme} onChange={(e) => onChange("theme", e.target.value)}>
              {values.themes.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </Row>
          <h3 className="cl-settings__subhead">{S.plugins}</h3>
          <p className="cl-settings__note">{S.pluginsDetail}</p>
          {values.plugins.map((p) => (
            <Row key={p.id} label={p.name} detail={p.source}>
              <Toggle label={p.name} on={p.enabled} onChange={(v) => onChange(`plugins.${p.id}.enabled`, v)} />
            </Row>
          ))}
          {props.onOpenPluginManager && (
            <button type="button" className="cl-settings__button cl-settings__button--wide" onClick={props.onOpenPluginManager}>
              {S.pluginManager}
            </button>
          )}
        </>
      );
    case "code":
      return (
        <>
          <Row label={S.branchPrefix} detail={S.branchPrefixDetail}>
            <input className="cl-settings__input" aria-label={S.branchPrefix} value={values.code.branchPrefix} onChange={(e) => onChange("code.branchPrefix", e.target.value)} />
          </Row>
          <Row label={S.labelSessions} detail={S.labelSessionsDetail}>
            <Toggle label={S.labelSessions} on={values.code.labelSessions} onChange={(v) => onChange("code.labelSessions", v)} />
          </Row>
          <Row label={S.transcript} detail={S.transcriptDetail}>
            <Choice label={S.transcript} value={values.code.transcript} options={["normal", "thinking", "everything"] as const} labels={S.transcripts} onChange={(v) => onChange("code.transcript", v)} />
          </Row>
          <Row label={S.draftPrs} detail={S.draftPrsDetail}>
            <Toggle label={S.draftPrs} on={values.code.draftPrs} onChange={(v) => onChange("code.draftPrs", v)} />
          </Row>
          <Row label={S.outputStyle} detail={S.outputStyleDetail}>
            <select className="cl-settings__select" aria-label={S.outputStyle} value={values.code.outputStyle} onChange={(e) => onChange("code.outputStyle", e.target.value)}>
              {values.outputStyles.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </Row>
        </>
      );
    case "devices":
      return (
        <>
          <h3 className="cl-settings__subhead">{S.devices}</h3>
          <p className="cl-settings__note">{S.devicesDetail}</p>
          {values.devices.map((d) => (
            <Row key={d.id} label={d.name} detail={[d.here ? S.thisDevice : "", d.main ? S.mainDevice : ""].filter(Boolean).join(" · ") || undefined}>
              {!d.here && props.onRemoveDevice && (
                <button type="button" className="cl-settings__button" aria-label={S.remove(d.name)} onClick={() => props.onRemoveDevice?.(d.id)}>
                  {S.removeLabel}
                </button>
              )}
            </Row>
          ))}
        </>
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
          <svg width={14} height={14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true" focusable="false">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      </header>
      <div className="cl-settings__body">
        <nav className="cl-settings__nav" aria-label={S.sections}>
          <input ref={search} className="cl-settings__search" type="search" placeholder={S.search} aria-label={S.search} value={query} onChange={(e) => setQuery(e.target.value)} />
          <ul className="cl-settings__sections">
            {shown.map((s) => (
              <li key={s} data-group-end={(GROUP_ENDS.has(s) && query.length === 0) || undefined}>
                <button type="button" className="cl-settings__section" aria-current={s === section ? "page" : undefined} onClick={() => onSection(s)}>
                  {S.section[s]}
                </button>
              </li>
            ))}
            {shown.length === 0 && <li className="cl-settings__note">{S.noMatch}</li>}
          </ul>
        </nav>
        <section className="cl-settings__page" aria-label={S.section[section]}>
          <h3 className="cl-settings__page-title">{S.section[section]}</h3>
          <Page props={props} />
        </section>
      </div>
    </div>
  );
}

