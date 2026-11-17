// The sidebar (the `sidebar` spot, spec §5.5), laid out the way a desktop agent app's is: room for the
// window's controls at the top, then New, Search, Outputs, Plugins and More, then the code sessions grouped
// by project folder (MOSS Code's window has no bots, spec §9.4), banners for safe mode, the pause switch and the link to the main computer, and the
// account with the settings gear at the bottom. Collapsed, it is a rail of icons, each with its
// accessible name. It paints no background of its own: the window frame puts the sidebar's material
// (or its solid colour) behind it.
import { useId, useState, type ReactNode } from "react";
import {
  MossMark,
  IconArchive,
  IconArrow,
  IconBranch,
  IconChart,
  IconChevronDown,
  IconChevronRight,
  IconClose,
  IconFolder,
  IconGear,
  IconGlobe,
  IconGrid,
  IconLink,
  IconMore,
  IconOutputs,
  IconPause,
  IconPlugins,
  IconPlus,
  IconPlusSmall,
  IconSearch,
  IconShield,
  IconSidebar,
} from "./icons";
import { S } from "./strings";
import { needsYouCount } from "./types";
import type { AgentStatus, SidebarApp, SidebarProject, SidebarProps, SidebarRoute, SidebarSession } from "./types";

const FINISHED: ReadonlySet<AgentStatus | "idle"> = new Set(["completed", "failed", "stopped"]);

export function sameRoute(a: SidebarRoute, b: SidebarRoute): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "agent":
      return a.agentId === (b as typeof a).agentId;
    case "app":
      return a.appId === (b as typeof a).appId;
    default:
      return true;
  }
}


const SAFE_ASSET = /^(blob:|data:image\/|moss-asset:)/i;


function Count({ count, label }: { count: number | undefined; label: (n: number) => string }) {
  if (!count) return null;
  return (
    <span className="cl-sidebar__count" aria-label={label(count)} title={label(count)}>
      {count}
    </span>
  );
}


function SessionRow({ session, props }: { session: SidebarSession; props: SidebarProps }) {
  const target: SidebarRoute = { kind: "agent", agentId: session.id };
  const selected = sameRoute(props.route, target);
  const finished = FINISHED.has(session.status);
  return (
    <li className="cl-sidebar__agent" data-status={session.status}>
      <button
        type="button"
        className="cl-sidebar__row cl-sidebar__row--nested"
        aria-current={selected ? "page" : undefined}
        title={session.title}
        onClick={() => props.onNavigate(target)}
      >
        <span className="cl-sidebar__title">{session.title}</span>
        {session.branch && (
          <span className="cl-sidebar__branch" aria-label={S.branch(session.branch, session.changes)} title={S.branch(session.branch, session.changes)}>
            <IconBranch />
            {session.changes !== undefined && <span>{session.changes}</span>}
          </span>
        )}
        <Count count={needsYouCount(session.needsYou)} label={S.needsYou} />
        {session.status !== "idle" && session.status !== "completed" && session.status !== "stopped" && (
          <span className="cl-sidebar__dot" data-status={session.status} role="img" aria-label={S.agentStatus[session.status]} title={S.agentStatus[session.status]} />
        )}
      </button>
      {finished && props.onCloseAgent && (
        <button type="button" className="cl-sidebar__close" aria-label={S.close(session.title)} title={S.close(session.title)} onClick={() => props.onCloseAgent?.(session.id)}>
          <IconClose />
        </button>
      )}
    </li>
  );
}

function ProjectGroup({ project, folded, onFold, props }: { project: SidebarProject; folded: boolean; onFold: () => void; props: SidebarProps }) {
  // An id from React, never from the project's own id: a space or a quote in it would break `aria-controls`.
  const listId = useId();
  return (
    <li className="cl-sidebar__project" data-folded={folded || undefined}>
      <div className="cl-sidebar__project-head">
        <button
          type="button"
          className="cl-sidebar__project-toggle"
          aria-expanded={!folded}
          aria-controls={folded ? undefined : listId}
          aria-label={folded ? S.unfold(project.name) : S.fold(project.name)}
          title={project.path}
          onClick={onFold}
        >
          <span className="cl-sidebar__project-name">{project.name}</span>
          {folded ? <IconChevronRight /> : <IconChevronDown />}
        </button>
        {props.onNewSession && (
          <button type="button" className="cl-sidebar__icon-button" aria-label={S.newSessionIn(project.name)} title={S.newSessionIn(project.name)} onClick={() => props.onNewSession?.(project.id)}>
            <IconPlusSmall />
          </button>
        )}
      </div>
      {!folded &&
        (project.sessions.length > 0 ? (
          <ul className="cl-sidebar__sessions" id={listId}>
            {project.sessions.map((session) => (
              <SessionRow key={session.id} session={session} props={props} />
            ))}
          </ul>
        ) : (
          <div className="cl-sidebar__empty" id={listId}>
            {S.noSessions}
          </div>
        ))}
    </li>
  );
}

function AppIcon({ app }: { app: SidebarApp }) {
  if (app.icon && "url" in app.icon && SAFE_ASSET.test(app.icon.url)) return <img className="cl-sidebar__app-icon" src={app.icon.url} alt="" />;
  const glyph = app.icon && "glyph" in app.icon ? app.icon.glyph : "grid";
  return glyph === "globe" ? <IconGlobe /> : glyph === "archive" ? <IconArchive /> : glyph === "chart" ? <IconChart /> : <IconGrid />;
}

interface Banner {
  key: string;
  icon: ReactNode;
  text: string;
  short: string;
  action?: { label: string; onClick: () => void };
  tone: "attention" | "info";
}

function banners(props: SidebarProps): Banner[] {
  const out: Banner[] = [];
  if (props.safeMode) {
    out.push({
      key: "safe",
      icon: <IconShield />,
      text: S.safeMode,
      short: S.safeModeShort,
      action: props.onOpenPluginManager ? { label: S.pluginManager, onClick: props.onOpenPluginManager } : undefined,
      tone: "attention",
    });
  }
  if (props.paused) {
    out.push({
      key: "paused",
      icon: <IconPause />,
      text: S.paused,
      short: S.pausedShort,
      action: props.onResume ? { label: S.resume, onClick: props.onResume } : undefined,
      tone: "attention",
    });
  }
  const link = props.link;
  if (link && link.state !== "connected") {
    const text = link.state === "unreachable" ? S.unreachable(link.main) : link.state === "takeover" ? S.takeover(link.main, link.here) : S.offline;
    out.push({ key: "link", icon: <IconLink />, text, short: S.linkShort, tone: link.state === "takeover" ? "info" : "attention" });
  }
  return out;
}

export function Sidebar(props: SidebarProps) {
  const { collapsed = false } = props;
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set(props.initialFoldedProjects ?? []));
  const fold = (id: string) =>
    setFolded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const list = banners(props);

  const action = (key: string, icon: ReactNode, label: string, onClick: (() => void) | undefined) =>
    onClick ? (
      <li key={key}>
        <button type="button" className="cl-sidebar__row cl-sidebar__action" aria-label={collapsed ? label : undefined} title={collapsed ? label : undefined} onClick={onClick}>
          {icon}
          {!collapsed && <span className="cl-sidebar__title">{label}</span>}
        </button>
      </li>
    ) : null;

  const toggle = props.onToggleCollapsed && (
    <button
      type="button"
      className="cl-sidebar__icon-button cl-sidebar__toggle"
      aria-label={collapsed ? S.expand : S.collapse}
      title={collapsed ? S.expand : S.collapse}
      aria-expanded={!collapsed}
      onClick={props.onToggleCollapsed}
    >
      <IconSidebar />
    </button>
  );

  return (
    <nav className="cl-sidebar" aria-label={S.nav} data-collapsed={collapsed || undefined} data-side="code">
      {/* The window's own controls (the traffic lights on macOS) draw over this row's start. */}
      <div className="cl-sidebar__top">
        <span className="cl-sidebar__controls" aria-hidden="true" />
        {!collapsed && toggle}
        {!collapsed && (
          <span className="cl-sidebar__brand" title={S.app}>
            <MossMark size={16} />
          </span>
        )}
      </div>
      {collapsed && toggle && <div className="cl-sidebar__rail-toggle">{toggle}</div>}

      <ul className="cl-sidebar__actions">
        {action("new", <IconPlus />, S.newSession, props.onNew)}
        {action("search", <IconSearch />, S.search, props.onSearch)}
        {action("outputs", <IconOutputs />, S.outputs, props.onOutputs)}
        {action("plugins", <IconPlugins />, S.plugins, props.onPlugins)}
        {action("more", <IconMore />, S.more, props.onMore)}
      </ul>

      <div className="cl-sidebar__scroll">
        {(
          <section className="cl-sidebar__section" aria-label={S.projects}>
            {collapsed ? (
              <ul className="cl-sidebar__list">
                {(props.projects ?? []).map((project) => (
                  <li key={project.id}>
                    <button
                      type="button"
                      className="cl-sidebar__row cl-sidebar__action"
                      aria-label={`${project.name}: ${project.sessions.length}`}
                      title={project.name}
                      onClick={() => {
                        const first = project.sessions[0];
                        if (first) props.onNavigate({ kind: "agent", agentId: first.id });
                      }}
                    >
                      <IconFolder />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <ul className="cl-sidebar__list cl-sidebar__projects">
                {(props.projects ?? []).map((project) => (
                  <ProjectGroup key={project.id} project={project} folded={folded.has(project.id)} onFold={() => fold(project.id)} props={props} />
                ))}
              </ul>
            )}
          </section>
        )}

        {props.apps && props.apps.length > 0 && (
          <section className="cl-sidebar__section" aria-label={S.apps}>
            {!collapsed && <h2 className="cl-sidebar__heading">{S.apps}</h2>}
            <ul className="cl-sidebar__list">
              {props.apps.map((app) => {
                const target: SidebarRoute = { kind: "app", appId: app.id };
                return (
                  <li key={app.id}>
                    <button
                      type="button"
                      className="cl-sidebar__row cl-sidebar__action"
                      aria-current={sameRoute(props.route, target) ? "page" : undefined}
                      aria-label={collapsed ? app.title : undefined}
                      title={collapsed ? app.title : undefined}
                      onClick={() => props.onNavigate(target)}
                    >
                      <AppIcon app={app} />
                      {!collapsed && <span className="cl-sidebar__title">{app.title}</span>}
                      {!collapsed && app.badge ? <span className="cl-sidebar__count">{app.badge}</span> : null}
                      {!collapsed && app.badgeRef !== undefined && props.renderAppBadge ? <span className="cl-sidebar__app-badge">{props.renderAppBadge(app)}</span> : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </div>

      {list.length > 0 &&
        (collapsed ? (
          <ul className="cl-sidebar__marks">
            {list.map((b) => (
              <li key={b.key}>
                <button type="button" className="cl-sidebar__mark" data-tone={b.tone} aria-label={b.text} title={b.text} onClick={b.action?.onClick}>
                  {b.icon}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="cl-sidebar__banners">
            {list.map((b) => (
              <div key={b.key} className="cl-sidebar__banner" data-tone={b.tone} role="status">
                {b.icon}
                <span className="cl-sidebar__banner-text">{b.text}</span>
                {b.action && (
                  <button type="button" className="cl-sidebar__banner-action" onClick={b.action.onClick}>
                    {b.action.label}
                    <IconArrow />
                  </button>
                )}
              </div>
            ))}
          </div>
        ))}

      <div className="cl-sidebar__footer">
        <button
          type="button"
          className="cl-sidebar__row cl-sidebar__account"
          aria-label={S.account(props.account.name)}
          title={S.account(props.account.name)}
          onClick={props.onOpenAccount ?? props.onOpenSettings}
        >
          <span className="cl-sidebar__avatar" aria-hidden="true">
            {props.account.name.slice(0, 1).toUpperCase()}
          </span>
          {!collapsed && (
            <span className="cl-sidebar__account-names">
              <span className="cl-sidebar__title">{props.account.name}</span>
              {props.account.detail && <span className="cl-sidebar__account-detail">· {props.account.detail}</span>}
              <IconChevronDown />
            </span>
          )}
        </button>
        <button type="button" className="cl-sidebar__icon-button" aria-label={S.settings} title={S.settings} onClick={props.onOpenSettings}>
          <IconGear />
        </button>
      </div>
    </nav>
  );
}
