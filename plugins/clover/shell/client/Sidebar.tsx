// The shell's sidebar: the bots, each background agent as a live tab under its bot (spec §9.3), the
// coding sessions the user started directly, the app buttons (`sidebar.app`), and Plugins and
// Settings. Banners above say what the whole app is doing: safe mode, the pause switch, and the link
// to the main computer. Selection is carried by fill alone; the accent stays out of navigation.
import { useId, type ReactNode } from "react";
import { Glyph, IconCheck, IconClock, IconClover, IconCross, IconDash, IconDots, IconGear, IconLink, IconPause, IconPlus, IconPuzzle, IconShield, IconSidebar, IconTerminal, IconWarning } from "./icons";
import { S } from "./strings";
import type { AgentStatus, LinkState, SidebarAgent, SidebarApp, SidebarBot, SidebarProps, SidebarRoute } from "./types";

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

/** The line under a bot's name: what needs the user first, then why it can't answer, then what it
 *  is doing. */
export function botStatusLine(bot: SidebarBot): string {
  if (bot.status === "needs-you" || bot.status === "asleep" || bot.status === "paused") return S.botStatus[bot.status];
  if (bot.activity) return bot.activity;
  return S.botStatus[bot.status];
}

const FINISHED: ReadonlySet<AgentStatus> = new Set(["completed", "failed", "stopped", "stalled"]);

export function agentStatusLine(agent: SidebarAgent): string {
  const parts = [agent.backend];
  if (agent.computer) parts.push(agent.computer);
  if (agent.status !== "running") parts.push(S.agentStatus[agent.status]);
  return parts.join(" · ");
}

function AgentGlyph({ status }: { status: AgentStatus }) {
  const glyph = {
    running: <IconDots />,
    "needs-you": <IconPause />,
    completed: <IconCheck />,
    failed: <IconCross />,
    stopped: <IconDash />,
    stalled: <IconClock />,
  }[status];
  return (
    <span className="cl-sidebar__agent-glyph" data-status={status} role="img" aria-label={S.agentStatus[status]}>
      {glyph}
    </span>
  );
}

function Portrait({ bot }: { bot: SidebarBot }) {
  return (
    <span className="cl-sidebar__portrait" data-status={bot.status}>
      {bot.portraitUrl ? (
        <img className="cl-sidebar__portrait-image" src={bot.portraitUrl} alt="" />
      ) : (
        <span className="cl-sidebar__portrait-initial" aria-hidden="true">
          {bot.name.trim().charAt(0).toUpperCase()}
        </span>
      )}
      <span className="cl-sidebar__portrait-dot" aria-hidden="true" />
    </span>
  );
}

function Badge({ count }: { count: number }) {
  return (
    <span className="cl-sidebar__badge" title={S.needsYou(count)}>
      {count > 99 ? "99+" : count}
    </span>
  );
}

function BotRow({ bot, current, collapsed, onNavigate }: { bot: SidebarBot; current: boolean; collapsed: boolean; onNavigate: SidebarProps["onNavigate"] }) {
  const line = botStatusLine(bot);
  const label = [bot.name, line, bot.needsYou ? S.needsYou(bot.needsYou) : bot.unread ? S.unread : ""].filter(Boolean).join(", ");
  return (
    <button
      type="button"
      className="cl-sidebar__row"
      data-kind="bot"
      data-status={bot.status}
      aria-current={current ? "page" : undefined}
      aria-label={collapsed ? label : undefined}
      title={collapsed ? label : undefined}
      onClick={() => onNavigate({ kind: "bot", botId: bot.id })}
    >
      <Portrait bot={bot} />
      <span className="cl-sidebar__row-text">
        <span className="cl-sidebar__name">{bot.name}</span>
        {line && <span className="cl-sidebar__status">{line}</span>}
      </span>
      {bot.needsYou ? <Badge count={bot.needsYou} /> : bot.unread ? <span className="cl-sidebar__unread" title={S.unread} /> : null}
    </button>
  );
}

function AgentRow({
  agent,
  current,
  onNavigate,
  onClose,
}: {
  agent: SidebarAgent;
  current: boolean;
  onNavigate: SidebarProps["onNavigate"];
  onClose?: (id: string) => void;
}) {
  return (
    <li className="cl-sidebar__agent" data-status={agent.status}>
      <button
        type="button"
        className="cl-sidebar__row"
        data-kind="agent"
        aria-current={current ? "page" : undefined}
        onClick={() => onNavigate({ kind: "agent", agentId: agent.id })}
      >
        <AgentGlyph status={agent.status} />
        <span className="cl-sidebar__row-text">
          <span className="cl-sidebar__name">{agent.title}</span>
          <span className="cl-sidebar__status">{agentStatusLine(agent)}</span>
        </span>
      </button>
      {onClose && FINISHED.has(agent.status) && (
        <button type="button" className="cl-sidebar__close" aria-label={S.close(agent.title)} title={S.close(agent.title)} onClick={() => onClose(agent.id)}>
          <IconCross />
        </button>
      )}
    </li>
  );
}

function AppIcon({ app }: { app: SidebarApp }) {
  if (app.icon && "url" in app.icon) return <img className="cl-sidebar__app-image" src={app.icon.url} alt="" />;
  return <Glyph name={app.icon && "glyph" in app.icon ? app.icon.glyph : "grid"} />;
}

function Banner({ tone, icon, text, action }: { tone: "info" | "warning"; icon: ReactNode; text: string; action?: { label: string; onClick: () => void } }) {
  return (
    <div className="cl-sidebar__banner" data-tone={tone} role="status" title={text}>
      {icon}
      <span className="cl-sidebar__banner-text">{text}</span>
      {action && (
        <button type="button" className="cl-sidebar__banner-action" onClick={action.onClick}>
          {action.label}
        </button>
      )}
    </div>
  );
}

function linkBanner(link: LinkState | undefined): { tone: "info" | "warning"; text: string } | null {
  switch (link?.state) {
    case "unreachable":
      return { tone: "warning", text: S.unreachable(link.main) };
    case "takeover":
      return { tone: "info", text: S.takeover(link.main, link.here) };
    case "offline":
      return { tone: "warning", text: S.offline };
    default:
      return null;
  }
}

function Section({ title, children, collapsed }: { title: string; children: ReactNode; collapsed: boolean }) {
  const id = useId();
  return (
    <section className="cl-sidebar__section" aria-labelledby={id}>
      <h2 className="cl-sidebar__heading" id={id} data-hidden={collapsed || undefined}>
        {title}
      </h2>
      {children}
    </section>
  );
}

export function Sidebar(props: SidebarProps) {
  const {
    bots,
    sessions = [],
    apps = [],
    route,
    onNavigate,
    onNewBot,
    onNewSession,
    onCloseAgent,
    link,
    paused = false,
    onResume,
    safeMode = false,
    onOpenPluginManager,
    collapsed = false,
    onToggleCollapsed,
    renderBot,
  } = props;
  const current = (r: SidebarRoute) => sameRoute(route, r);
  const banner = linkBanner(link);
  const footer = (kind: "plugins" | "settings", label: string, icon: ReactNode) => (
    <button
      type="button"
      className="cl-sidebar__row"
      data-kind={kind}
      aria-current={current({ kind }) ? "page" : undefined}
      aria-label={collapsed ? label : undefined}
      title={collapsed ? label : undefined}
      onClick={() => onNavigate({ kind })}
    >
      <span className="cl-sidebar__app-icon">{icon}</span>
      <span className="cl-sidebar__name">{label}</span>
    </button>
  );
  return (
    <nav className="cl-sidebar" aria-label={S.nav} data-collapsed={collapsed || undefined}>
      <header className="cl-sidebar__header">
        <span className="cl-sidebar__wordmark">
          <IconClover />
          <span className="cl-sidebar__wordmark-text">{S.app}</span>
        </span>
        <span className="cl-sidebar__spacer" />
        {onToggleCollapsed && (
          <button
            type="button"
            className="cl-sidebar__tool"
            aria-label={collapsed ? S.expand : S.collapse}
            aria-expanded={!collapsed}
            title={collapsed ? S.expand : S.collapse}
            onClick={onToggleCollapsed}
          >
            <IconSidebar />
          </button>
        )}
        {onNewBot && !collapsed && (
          <button type="button" className="cl-sidebar__tool" aria-label={S.newBot} title={S.newBot} onClick={onNewBot}>
            <IconPlus />
          </button>
        )}
      </header>
      {!collapsed && (safeMode || paused || banner) && (
        <div className="cl-sidebar__banners">
          {safeMode && (
            <Banner
              tone="warning"
              icon={<IconShield />}
              text={S.safeMode}
              action={onOpenPluginManager ? { label: S.pluginManager, onClick: onOpenPluginManager } : undefined}
            />
          )}
          {paused && <Banner tone="warning" icon={<IconPause />} text={S.paused} action={onResume ? { label: S.resume, onClick: onResume } : undefined} />}
          {banner && <Banner tone={banner.tone} icon={banner.tone === "warning" ? <IconWarning /> : <IconLink />} text={banner.text} />}
        </div>
      )}
      <div className="cl-sidebar__scroll">
        <Section title={S.bots} collapsed={collapsed}>
          <ul className="cl-sidebar__list">
            {bots.map((bot) => {
              const standard = <BotRow bot={bot} current={current({ kind: "bot", botId: bot.id })} collapsed={collapsed} onNavigate={onNavigate} />;
              return (
                <li key={bot.id} className="cl-sidebar__bot">
                  {renderBot ? renderBot(bot, standard) : standard}
                  {!collapsed && bot.agents && bot.agents.length > 0 && (
                    <ul className="cl-sidebar__agents" aria-label={S.agentsOf(bot.name)}>
                      {bot.agents.map((agent) => (
                        <AgentRow
                          key={agent.id}
                          agent={agent}
                          current={current({ kind: "agent", agentId: agent.id })}
                          onNavigate={onNavigate}
                          onClose={onCloseAgent}
                        />
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </Section>
        {!collapsed && (sessions.length > 0 || onNewSession) && (
          <Section title={S.coding} collapsed={collapsed}>
            <ul className="cl-sidebar__list">
              {sessions.map((session) => (
                <AgentRow
                  key={session.id}
                  agent={session}
                  current={current({ kind: "agent", agentId: session.id })}
                  onNavigate={onNavigate}
                  onClose={onCloseAgent}
                />
              ))}
            </ul>
            {onNewSession && (
              <button type="button" className="cl-sidebar__row cl-sidebar__add" onClick={onNewSession}>
                <span className="cl-sidebar__app-icon">
                  <IconTerminal />
                </span>
                <span className="cl-sidebar__name">{S.newSession}</span>
              </button>
            )}
          </Section>
        )}
        {apps.length > 0 && (
          <Section title={S.apps} collapsed={collapsed}>
            <ul className="cl-sidebar__list">
              {apps.map((app) => (
                <li key={app.id}>
                  <button
                    type="button"
                    className="cl-sidebar__row"
                    data-kind="app"
                    aria-current={current({ kind: "app", appId: app.id }) ? "page" : undefined}
                    aria-label={collapsed ? app.title : undefined}
                    title={collapsed ? app.title : undefined}
                    onClick={() => onNavigate({ kind: "app", appId: app.id })}
                  >
                    <span className="cl-sidebar__app-icon">
                      <AppIcon app={app} />
                    </span>
                    <span className="cl-sidebar__name">{app.title}</span>
                    {app.badge ? <span className="cl-sidebar__badge">{app.badge > 99 ? "99+" : app.badge}</span> : null}
                  </button>
                </li>
              ))}
            </ul>
          </Section>
        )}
      </div>
      <footer className="cl-sidebar__footer">
        {footer("plugins", S.plugins, <IconPuzzle />)}
        {footer("settings", S.settings, <IconGear />)}
      </footer>
    </nav>
  );
}
