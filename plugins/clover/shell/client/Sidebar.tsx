// The sidebar, laid out the way a desktop agent app's is: a switch between the bots and the code at the
// top, then New, Search, Outputs, Customize and More, then the bots (with their live agents and what
// needs the user) or the coding sessions grouped by project folder, and the account with the settings
// gear at the bottom. Banners for safe mode, the pause switch and the link to the main computer sit
// under the actions. Collapsed, it is a rail of icons, each with its accessible name.
import { useState, type ReactNode } from "react";
import {
  CloverMark,
  IconArchive,
  IconBots,
  IconBranch,
  IconChart,
  IconChevronDown,
  IconChevronRight,
  IconClose,
  IconCode,
  IconCustomize,
  IconFolder,
  IconGear,
  IconGlobe,
  IconGrid,
  IconLink,
  IconMore,
  IconOutputs,
  IconPause,
  IconPlus,
  IconSearch,
  IconShield,
  IconSidebar,
} from "./icons";
import { S } from "./strings";
import { needsYouCount } from "./types";
import type { AgentStatus, SidebarAgent, SidebarApp, SidebarBot, SidebarProject, SidebarProps, SidebarRoute, SidebarSession } from "./types";

const FINISHED: ReadonlySet<AgentStatus | "idle"> = new Set(["completed", "failed", "stopped"]);

export function sameRoute(a: SidebarRoute, b: SidebarRoute): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "bot":
      return a.botId === (b as typeof a).botId;
    case "agent":
      return a.agentId === (b as typeof a).agentId;
    case "app":
      return a.appId === (b as typeof a).appId;
    default:
      return true;
  }
}

/** The line under a bot's name: what it is doing, else nothing. */
export function botStatusLine(bot: SidebarBot): string {
  if (bot.state === "idle") return bot.activity ?? "";
  return S.botStatus[bot.state];
}

function Portrait({ bot }: { bot: SidebarBot }) {
  const url = bot.portraitUrl && /^(blob:|data:image\/|clover-asset:)/i.test(bot.portraitUrl) ? bot.portraitUrl : undefined;
  return (
    <span className="cl-sidebar__portrait" data-status={bot.state} aria-hidden="true">
      {url ? <img src={url} alt="" /> : <span className="cl-sidebar__initial">{bot.name.slice(0, 1).toUpperCase()}</span>}
    </span>
  );
}

function Count({ count, label }: { count: number | undefined; label: (n: number) => string }) {
  if (!count) return null;
  return (
    <span className="cl-sidebar__count" aria-label={label(count)} title={label(count)}>
      {count}
    </span>
  );
}

/** A status dot that says what a live tab is doing; its text sits beside it, never cut. */
function State({ status }: { status: AgentStatus | "idle" }) {
  const text = S.agentStatus[status];
  if (!text) return null;
  return (
    <span className="cl-sidebar__state" data-status={status}>
      {text}
    </span>
  );
}

function AgentRow({ agent, route, onNavigate, onClose }: { agent: SidebarAgent; route: SidebarRoute; onNavigate: SidebarProps["onNavigate"]; onClose?: (id: string) => void }) {
  const target: SidebarRoute = { kind: "agent", agentId: agent.id };
  const selected = sameRoute(route, target);
  const finished = FINISHED.has(agent.status);
  return (
    <li className="cl-sidebar__agent" data-status={agent.status}>
      <button
        type="button"
        className="cl-sidebar__row cl-sidebar__row--nested"
        aria-current={selected ? "page" : undefined}
        title={`${agent.title} · ${agent.backend}${agent.computer ? ` · ${agent.computer}` : ""}`}
        onClick={() => onNavigate(target)}
      >
        <span className="cl-sidebar__dot" data-status={agent.status} aria-hidden="true" />
        <State status={agent.status} />
        <span className="cl-sidebar__title">{agent.title}</span>
      </button>
      {finished && onClose && (
        <button type="button" className="cl-sidebar__close" aria-label={S.close(agent.title)} title={S.close(agent.title)} onClick={() => onClose(agent.id)}>
          <IconClose />
        </button>
      )}
    </li>
  );
}

function BotRow({ bot, props }: { bot: SidebarBot; props: SidebarProps }) {
  const target: SidebarRoute = { kind: "bot", botId: bot.id };
  const selected = sameRoute(props.route, target);
  const line = botStatusLine(bot);
  const standard = (
    <button
      type="button"
      className="cl-sidebar__row cl-sidebar__bot"
      aria-current={selected ? "page" : undefined}
      onClick={() => props.onNavigate(target)}
    >
      <Portrait bot={bot} />
      <span className="cl-sidebar__names">
        <span className="cl-sidebar__title">{bot.name}</span>
        {line && (
          <span className="cl-sidebar__line" data-status={bot.state}>
            {line}
          </span>
        )}
      </span>
      {bot.unread && <span className="cl-sidebar__unread" aria-label={S.unread} title={S.unread} />}
      <Count count={needsYouCount(bot.needsYou)} label={S.needsYou} />
    </button>
  );
  return (
    <li className="cl-sidebar__bot-item">
      {props.renderBot ? props.renderBot(bot, standard) : standard}
      {bot.agents && bot.agents.length > 0 && (
        <ul className="cl-sidebar__agents" aria-label={S.agentsOf(bot.name)}>
          {bot.agents.map((agent) => (
            <AgentRow key={agent.id} agent={agent} route={props.route} onNavigate={props.onNavigate} onClose={props.onCloseAgent} />
          ))}
        </ul>
      )}
    </li>
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
        {(session.status === "running" || session.status === "needs-you") && (
          <span className="cl-sidebar__dot" data-status={session.status} role="img" aria-label={S.agentStatus[session.status]} />
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
  const listId = `cl-sidebar-project-${project.id}`;
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
            <IconPlus />
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
          <div className="cl-sidebar__empty">{S.noSessions}</div>
        ))}
    </li>
  );
}

function AppIcon({ app }: { app: SidebarApp }) {
  if (app.icon && "url" in app.icon && /^(blob:|data:image\/|clover-asset:)/i.test(app.icon.url)) return <img className="cl-sidebar__app-icon" src={app.icon.url} alt="" />;
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
  const { side, collapsed = false } = props;
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

  return (
    <nav className="cl-sidebar" aria-label={S.nav} data-collapsed={collapsed || undefined} data-side={side}>
      <div className="cl-sidebar__top">
        {props.onToggleCollapsed && (
          <button
            type="button"
            className="cl-sidebar__icon-button"
            aria-label={collapsed ? S.expand : S.collapse}
            title={collapsed ? S.expand : S.collapse}
            aria-expanded={!collapsed}
            onClick={props.onToggleCollapsed}
          >
            <IconSidebar />
          </button>
        )}
        <span className="cl-sidebar__brand" aria-hidden={collapsed || undefined}>
          <CloverMark size={18} />
          {!collapsed && <span>{S.app}</span>}
        </span>
      </div>

      <div className="cl-sidebar__switch" role="radiogroup" aria-label={S.sides}>
        {(["bots", "code"] as const).map((key) => (
          <button
            key={key}
            type="button"
            role="radio"
            aria-checked={side === key}
            className="cl-sidebar__switch-option"
            aria-label={collapsed ? (key === "bots" ? S.sideBots : S.sideCode) : undefined}
            onClick={() => props.onSideChange(key)}
          >
            {key === "bots" ? <IconBots /> : <IconCode />}
            {!collapsed && <span>{key === "bots" ? S.sideBots : S.sideCode}</span>}
          </button>
        ))}
      </div>

      <ul className="cl-sidebar__actions">
        {action("new", <IconPlus />, side === "bots" ? S.newChat : S.new, props.onNew)}
        {action("search", <IconSearch />, S.search, props.onSearch)}
        {action("outputs", <IconOutputs />, S.outputs, props.onOutputs)}
        {action("customize", <IconCustomize />, S.customize, props.onCustomize)}
        {action("more", <IconMore />, S.more, props.onMore)}
      </ul>

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
                  </button>
                )}
              </div>
            ))}
          </div>
        ))}

      <div className="cl-sidebar__scroll">
        {side === "bots" ? (
          <section className="cl-sidebar__section" aria-label={S.bots}>
            {!collapsed && <h2 className="cl-sidebar__heading">{S.bots}</h2>}
            <ul className="cl-sidebar__list">
              {props.bots.map((bot) =>
                collapsed ? (
                  <li key={bot.id}>
                    <button
                      type="button"
                      className="cl-sidebar__row cl-sidebar__bot"
                      aria-current={sameRoute(props.route, { kind: "bot", botId: bot.id }) ? "page" : undefined}
                      aria-label={[bot.name, botStatusLine(bot), needsYouCount(bot.needsYou) ? S.needsYou(needsYouCount(bot.needsYou)) : ""].filter(Boolean).join(", ")}
                      title={bot.name}
                      onClick={() => props.onNavigate({ kind: "bot", botId: bot.id })}
                    >
                      <Portrait bot={bot} />
                      {needsYouCount(bot.needsYou) ? <span className="cl-sidebar__count cl-sidebar__count--corner">{needsYouCount(bot.needsYou)}</span> : null}
                    </button>
                  </li>
                ) : (
                  <BotRow key={bot.id} bot={bot} props={props} />
                ),
              )}
            </ul>
          </section>
        ) : (
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
              <ul className="cl-sidebar__list">
                {(props.projects ?? []).map((project) => (
                  <ProjectGroup key={project.id} project={project} folded={folded.has(project.id)} onFold={() => fold(project.id)} props={props} />
                ))}
              </ul>
            )}
          </section>
        )}

        {props.apps && props.apps.length > 0 && (
          <section className="cl-sidebar__section" aria-label={S.apps}>
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
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </div>

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
              {props.account.detail && <span className="cl-sidebar__account-detail">{props.account.detail}</span>}
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
