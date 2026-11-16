// The column beside the conversation, in quiet folding cards.
// - In a code session: its agents and tasks, where it runs (the computer and that computer's level, the
//   folders, the branch), how much context it uses, its connectors, its outputs, and its changes (lane
//   D's) with the pull requests they became.
// - In a bot's tab, the slim column: its agents and tasks, its context and its outputs. Nothing about a
//   folder: no changes, files or terminal. One of its coding agents opens in the panel (`onOpenAgent`).
// Every device already sees every bot live (spec §6.4), so nothing here switches a device on.
import { useState, type ReactNode } from "react";
import {
  IconAgent,
  IconBranch,
  IconChevronDown,
  IconChevronRight,
  IconComputer,
  IconDiffRow,
  IconFile,
  IconFolderRow,
  IconImage,
  IconLevel,
  IconPage,
  IconPullRequest,
} from "./icons";
import { S } from "./strings";
import type { SessionViewProps } from "./types";

function Section({
  title,
  summary,
  initiallyOpen = true,
  children,
}: {
  title: string;
  /** Shown at the end of the heading, open or folded. */
  summary?: ReactNode;
  initiallyOpen?: boolean;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  const canOpen = children !== undefined && children !== null && children !== false;
  return (
    <section className="cl-session__section" data-open={(open && canOpen) || undefined}>
      <h3 className="cl-session__heading">
        <button
          type="button"
          className="cl-session__toggle"
          aria-expanded={canOpen ? open : undefined}
          disabled={!canOpen}
          aria-label={canOpen ? (open ? S.fold(title) : S.unfold(title)) : title}
          onClick={() => setOpen((o) => !o)}
        >
          <span>{title}</span>
          {canOpen && (open ? <IconChevronDown /> : <IconChevronRight />)}
        </button>
        {summary !== undefined && <span className="cl-session__summary">{summary}</span>}
      </h3>
      {open && canOpen && <div className="cl-session__content">{children}</div>}
    </section>
  );
}

export function SessionView(props: SessionViewProps) {
  const { kind = "coding", agents, context, outputs } = props;
  // A bot's tab and a side thread are slim: whatever the host passes, they never show a folder's things.
  const code = kind === "coding" || kind === "agent";
  const environment = code ? props.environment : undefined;
  const connectors = code ? props.connectors : undefined;
  const changes = code ? props.changes : undefined;
  const pct = context ? Math.round(Math.min(1, Math.max(0, context.used)) * 100) : 0;
  return (
    <div className="cl-session" data-kind={kind}>
      {agents && agents.length > 0 && (
        <Section title={S.agents}>
          <ul className="cl-session__list">
            {agents.map((a) => (
              <li key={a.id}>
                <button
                  type="button"
                  className="cl-session__row"
                  aria-current={props.openAgent === a.id || undefined}
                  onClick={() => props.onOpenAgent?.(a.id)}
                  title={`${a.title} · ${a.backend}`}
                >
                  <IconAgent />
                  <span className="cl-session__name">{a.title}</span>
                  <span className="cl-session__meta" data-status={a.status}>
                    {S.agentStatus[a.status]}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {environment && (
        <Section title={S.environment}>
          <ul className="cl-session__list">
            <li className="cl-session__row cl-session__row--static">
              <IconComputer />
              <span className="cl-session__name">{environment.here ? S.here : environment.computer}</span>
            </li>
            {environment.level && (
              <li className="cl-session__row cl-session__row--static" data-requested={environment.level.requested ? "" : undefined}>
                <IconLevel />
                <span className="cl-session__name">{S.level(environment.level.label)}</span>
                {environment.level.requested ? (
                  <span className="cl-session__meta cl-session__requested" title={S.levelRequestedTitle(environment.level.requested)}>
                    {S.levelRequested(environment.level.requested)}
                  </span>
                ) : (
                  environment.level.onChange && (
                    <button type="button" className="cl-session__link" title={S.changeLevelTitle(environment.here ? S.here : environment.computer)} onClick={environment.level.onChange}>
                      {S.changeLevel}
                    </button>
                  )
                )}
              </li>
            )}
            {environment.folders.map((f) => (
              <li key={f.path} className="cl-session__row cl-session__row--static" title={f.path}>
                <IconFolderRow />
                <span className="cl-session__name">{f.name}</span>
              </li>
            ))}
            {environment.branch && (
              <li className="cl-session__row cl-session__row--static">
                <IconBranch />
                <span className="cl-session__name">{environment.branch}</span>
              </li>
            )}
          </ul>
        </Section>
      )}

      {context && (
        <Section
          title={S.context}
          initiallyOpen={false}
          summary={
            <span className="cl-session__context" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={S.contextLabel(pct)}>
              <span>{S.contextUsed(pct)}</span>
              <span className="cl-session__bar">
                <span className="cl-session__bar-fill" style={{ width: `${pct}%` }} />
              </span>
            </span>
          }
        >
          {context.detail ? <p className="cl-session__note">{context.detail}</p> : null}
        </Section>
      )}

      {connectors && (
        <Section
          title={S.connectors}
          initiallyOpen={false}
          summary={
            <button type="button" className="cl-session__link" data-attention={connectors.needSignIn > 0 || undefined} onClick={connectors.onOpen}>
              {S.connectorsState(connectors.total, connectors.needSignIn)}
            </button>
          }
        />
      )}

      {outputs && outputs.items.length > 0 && (
        <Section title={S.outputs}>
          <ul className="cl-session__list">
            {outputs.items.map((o) => (
              <li key={o.id}>
                <button type="button" className="cl-session__row" onClick={() => outputs.onOpen(o.id)} title={o.name}>
                  {o.kind === "page" ? <IconPage /> : o.kind === "image" ? <IconImage /> : <IconFile />}
                  <span className="cl-session__name">{o.name}</span>
                  <span className="cl-session__meta">{S.outputKind[o.kind]}</span>
                </button>
              </li>
            ))}
          </ul>
          {outputs.more && outputs.onShowMore ? (
            <button type="button" className="cl-session__more" onClick={outputs.onShowMore}>
              {S.showMore(outputs.more)}
            </button>
          ) : null}
        </Section>
      )}

      {changes && (
        <Section title={S.changes}>
          <div className="cl-session__changes">
            <button type="button" className="cl-session__row cl-session__diffstat" onClick={changes.onOpenDiff} aria-label={`${changes.label}: ${S.diffStatLabel(changes.files, changes.added, changes.removed)}`}>
              <IconDiffRow />
              <span className="cl-session__name">{changes.label}</span>
              <span className="cl-session__added">+{changes.added}</span>
              <span className="cl-session__removed">−{changes.removed}</span>
            </button>
            {changes.onCreatePr && (
              <button type="button" className="cl-session__button" onClick={changes.onCreatePr}>
                {S.createPr}
              </button>
            )}
          </div>
          {changes.prs.length > 0 && (
            <ul className="cl-session__list">
              {changes.prs.map((pr) => (
                <li key={pr.id}>
                  <button type="button" className="cl-session__row cl-session__pr" onClick={() => changes.onOpenPr?.(pr.id)} title={pr.title}>
                    <span className="cl-session__pr-icon" data-state={pr.state}>
                      <IconPullRequest />
                    </span>
                    <span className="cl-session__pr-text">
                      <span className="cl-session__name">{pr.title}</span>
                      <span className="cl-session__meta">
                        {S.pr(pr.repo, pr.number)} · {S.prState[pr.state]}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}
    </div>
  );
}
