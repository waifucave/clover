// The default shell: the `app.root` entry. It holds the route (what `main` shows) and the panels open on each tab, and
// it places every spot it declares (spec §5.5): the sidebar, `main` keyed by route, the panel host keyed by panel, the
// column beside the conversation, the status bar, and a dialog layer for Settings. What fills each spot is another
// entry, mounted through `<Spot>`; the shell draws only the frame (`Window`), the panel host and its toggles.
//
// Routes (`main`'s keys): `bot` (a bot's tab, which `bot.tab` holds), `agent` (an agent's or a coding session's live
// tab), `settings` (a dialog over the tab under it), `plugins`, and the keys app buttons open (`archive`), plus
// `bot-editor`. Panels by tab (the owner's item 90): a coding session has its column, the terminal, the changes, the
// files and the browser; a bot's tab has its slim column (`bot.side`) and the browser, and one of its coding agents
// opens in the panel as a live tab of its own.
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ShellApp, ShellState } from "@waifucave/clover-plugin-sdk";
import type { ShellAct } from "@waifucave/clover-plugin-sdk/ui/bridge";
import type { BotRef, EntryProps, SessionKind, SessionView } from "../runtime/types";
import { useLiveList, useLoad } from "./data";
import { PanelEmpty, PanelHost } from "./PanelHost";
import { belongsIn, PanelToggles, toggleView, VIEWS_BY_KIND } from "./PanelToggles";
import type { PanelViewId } from "./panel-types";
import type { PanelView } from "./panel-types";
import { Spot, useApprovals, useCore, useKept, usePluginApi, useSpotEntries, useTokens } from "./sdk";
import { S } from "./strings";
import { fieldText, plain } from "../runtime/views";
import { Window, shapeOf, skinOf } from "./Window";
import { KeptTab } from "./KeptTab";
import { ReplacedPanel } from "./ReplacedPanel";
import type { ChromeApi } from "./chrome";

/** The panel keys besides the session column, each a `panel` entry's key. */
const PANEL_KEYS = ["terminal", "diff", "browser", "files", "agent"] as const;
/** The panels a bot's plugin may replace on its own tab and that fall back to the stock one when the replacement does not draw. */
const REPLACEABLE = ["browser", "agent"] as const;

/** What `main` shows: B's `main` props (`route`, `params`). */
export interface ShellRoute {
  route: string;
  params: Record<string, string>;
}

/** Where the shell starts, for the gallery and the tests: not part of `app.root`'s props in the app. */
export interface ShellStart {
  route?: ShellRoute;
  /** The tab under Settings, when `route` is Settings. */
  under?: ShellRoute;
  /** The panels open on the tab shown; `session` is the column beside the conversation. */
  panels?: string[];
  /** A bot's coding agent open in the panel. */
  agent?: string;
}

export interface ShellProps {
  /** The window has a system material behind it (lane E): the sidebar lets it through. */
  translucent?: boolean;
  start?: ShellStart;
  /** An act of the window a bot's own plugin asked for through `shell.*` (main checked the capability, the user's press and whose tab shows): applied once per `n`. */
  act?: { n: number; act: ShellAct };
  /** Where the window is, for the plugin frames that read it (`shell.state`); the app's own layer hands it to the core. */
  /** The essential handles the shown bot's own controls offer (`shell.provide`). */
  provides?: { sidebar: boolean; drag: boolean };
  report?: (report: { state: ShellState; apps: readonly ShellApp[]; account?: { name: string; detail?: string } }) => void;
}

const tabKey = (r: ShellRoute | undefined) => (r ? `${r.route}:${r.params.bot ?? r.params.session ?? ""}` : "");

/** The `bot.tab` spot for a bot, with the props every bot tab gets: the bot, and its main session (a bot's own layout draws the
 *  conversation and the composer from them). */
function BotTabSpot({ bot, onOpenAgent }: { bot: BotRef; onOpenAgent: (session: string) => void }) {
  const api = usePluginApi();
  const full = useLoad(() => api.bots?.get(bot.id) ?? Promise.reject(new Error("no bots.read")), [api, bot.id]);
  if (!full) return <NothingHere title={S.loading} />;
  return <Spot name="bot.tab" spotKey={bot.id} props={{ bot, session: full.mainSession, onOpenAgent }} fallback={<NothingHere title={S.nothingHere} />} />;
}

function NothingHere({ title }: { title: string }) {
  return (
    <div className="cl-shell-empty" role="status">
      <p className="cl-shell-empty__title">{title}</p>
      <p className="cl-shell-empty__detail">{S.nothingHereDetail}</p>
    </div>
  );
}

export function Shell({ props }: EntryProps<ShellProps>) {
  const api = usePluginApi();
  const bots = useLiveList(api.bots ? () => api.bots!.list() : undefined, api.bots?.watch, (a, b) => a.id === b.id, [api]);
  // Where the user is (the route, the tab under Settings, each tab's open panels and agent) outlives a reload of this
  // document: installing, turning on or updating a plugin with its own layer loads it again, and the window shows the
  // same place from its first frame (`useKept`, the window's own session storage).
  const [keptRoute, setRoute] = useKept<ShellRoute | null>("shell.route", () => props.start?.route ?? null);
  const route = keptRoute ?? undefined;
  // Settings opens over the tab the user was on, which stays under it.
  const [keptUnder, setUnder] = useKept<ShellRoute | null>("shell.under", () => props.start?.under ?? null);
  const under = keptUnder ?? undefined;
  const startTab = props.start?.route?.route === "settings" ? props.start.under : props.start?.route;
  const [panels, setPanels] = useKept<Record<string, string[]>>("shell.panels", () => (startTab && props.start?.panels ? { [tabKey(startTab)]: props.start.panels } : {}));
  const [agents, setAgents] = useKept<Record<string, string | undefined>>("shell.agents", () => (startTab && props.start?.agent ? { [tabKey(startTab)]: props.start.agent } : {}));

  useEffect(() => {
    if (!route && bots && bots[0]) setRoute({ route: "bot", params: { bot: bots[0].id } });
  }, [route, bots]);

  const dialog = route?.route === "settings" ? route : undefined;
  const shown = dialog ? under : route;
  const sessions = useLoad(() => api.conversation?.list?.() ?? Promise.resolve([] as SessionView[]), [api, tabKey(shown)]);
  const bot = shown?.route === "bot" ? bots?.find((b) => b.id === shown.params.bot) : undefined;
  const botRef: BotRef | undefined = bot ? { id: bot.id, name: plain(bot.name) } : undefined;
  const session = shown?.route === "agent" ? sessions?.find((s) => s.id === shown.params.session) : undefined;
  const kind: SessionKind | undefined = shown?.route === "bot" ? "bot" : shown?.route === "agent" ? (session?.kind ?? "agent") : undefined;
  const tabSession = bot?.mainSession ?? session?.id;
  const key = tabKey(shown);
  const open = panels[key] ?? [];
  const agent = agents[key];
  const agentSession = agent ? sessions?.find((s) => s.id === agent) : undefined;

  const navigate = (next: ShellRoute) => {
    if (next.route === "settings" && route?.route !== "settings") setUnder(route ?? null);
    setRoute(next);
  };
  const closeDialog = () => setRoute(under ?? null);
  const setOpen = (next: string[]) => setPanels((p) => ({ ...p, [key]: next }));
  const openAgent = (id: string) => {
    setAgents((a) => ({ ...a, [key]: id }));
    if (!open.includes("agent")) setOpen(toggleView(open, "agent"));
  };

  // Any card this window will draw: one in a session it shows (the tab's, the agent's in the panel), or one raised
  // from a dialog (a level change, removing a device), which has no session.
  const { cards } = useApprovals();
  const showing = new Set([tabSession, agent].filter((s): s is string => s !== undefined));
  const cardPending = cards.some((c) => c.session === undefined || showing.has(c.session));

  const appButtons = useSpotEntries("sidebar.app").entries;
  const title = (() => {
    if (!shown) return "";
    if (shown.route === "bot") return plain(bot?.name);
    if (shown.route === "agent") return session?.title ?? S.views.agent!;
    if (shown.route === "plugins") return S.plugins;
    if (shown.route === "bot-editor") return S.editBot(plain(bots?.find((b) => b.id === shown.params.bot)?.name));
    const app = appButtons.find((e) => e.fields?.opens === shown.route);
    return fieldText(app?.fields?.title) ?? (shown.params.title !== undefined ? plain(shown.params.title) : undefined) ?? shown.route;
  })();

  // A bot's tab says whose it is (`bot`, its id: the browser shows that bot's tabs, a code session the person's own).
  const panelProps = (id: string): Record<string, unknown> =>
    id === "agent" && agentSession
      ? { app: id, session: agentSession.id, sessionKind: agentSession.kind, ...(botRef ? { bot: botRef.id } : {}) }
      : { app: id, session: tabSession, sessionKind: kind, ...(botRef ? { bot: botRef.id } : {}) };
  // Which panels anything fills (the `panel` spot by key; a bot's column is `bot.side`): a toggle is offered only for one that
  // does, and an open panel whose filler goes away closes. A constant list of hooks, whatever the tab.
  const entriesOf = (spot: string, key: string | undefined, props: Record<string, unknown>) => useSpotEntries(spot, key, props).entries;
  const entryLists = [
    kind === "bot" ? entriesOf("bot.side", undefined, botRef ? { bot: botRef, session: tabSession, sessionKind: "bot" } : {}) : entriesOf("panel", "session", panelProps("session")),
    ...PANEL_KEYS.map((id) => entriesOf("panel", id, panelProps(id))),
  ];
  const filledList = entryLists.map((l) => l.length > 0);
  // A bot's own plugin may fill the Browser or its agent's panel on its tab (the winner is not a shipped part): such a panel is watched, and
  // when it does not draw the stock one shows in its place until the person asks to try the bot's again.
  const replacedOnTab = (id: string): boolean => {
    const i = PANEL_KEYS.indexOf(id as (typeof PANEL_KEYS)[number]);
    return botRef !== undefined && (REPLACEABLE as readonly string[]).includes(id) && i >= 0 && entryLists[i + 1]?.[0] !== undefined && !entryLists[i + 1]![0]!.pluginId.startsWith("clover/");
  };
  const [fell, setFell] = useState<Record<string, boolean>>({});
  const [tries, setTries] = useState<Record<string, number>>({});
  const fellKey = (id: string) => `${key}|${id}`;
  const filled = new Set<string>([...(filledList[0] ? ["session"] : []), ...PANEL_KEYS.filter((_, i) => filledList[i + 1])]);
  // Not before the tab's session is known: its kind decides which panels fit it (`when.session`), and until then it is a guess.
  const settled = (shown?.route !== "agent" || session !== undefined) && (agent === undefined || agentSession !== undefined);
  const closing = kind && settled ? open.filter((id) => !filled.has(id)) : [];
  useEffect(() => {
    if (closing.length > 0) setOpen(open.filter((id) => filled.has(id)));
  }, [closing.join("|"), key]);
  const views: PanelView[] = kind
    ? open
        .filter((id) => id !== "session")
        .map((id) => {
          const base = id === "agent" ? (agentSession?.title ?? S.views.agent!) : (S.views[id] ?? id);
          const empty = <PanelEmpty id={id} title={S.views[id] ?? id} onFindPlugin={(k) => navigate({ route: "plugins", params: { spot: "panel", key: k } })} />;
          if (replacedOnTab(id) && botRef) {
            const hasFell = fell[fellKey(id)] === true;
            return {
              id,
              title: hasFell ? S.fellBack(botRef.name, S.views[id] ?? id) : base,
              ...(hasFell
                ? {
                    actions: (
                      <button type="button" className="cl-panel__text-button" onClick={() => { setTries((t) => ({ ...t, [fellKey(id)]: (t[fellKey(id)] ?? 0) + 1 })); setFell((f) => ({ ...f, [fellKey(id)]: false })); }}>
                        {S.tryAgain(botRef.name)}
                      </button>
                    ),
                  }
                : {}),
              content: (header: HTMLElement | null, usedLast: boolean) => (
                <ReplacedPanel key={`${fellKey(id)}|${tries[fellKey(id)] ?? 0}`} id={id} props={panelProps(id)} header={header} usedLast={usedLast} fell={hasFell} onFell={() => setFell((f) => (f[fellKey(id)] ? f : { ...f, [fellKey(id)]: true }))} empty={empty} bot={botRef.id} />
              ),
            };
          }
          return {
            id,
            title: base,
            content: (header: HTMLElement | null, usedLast: boolean) => (
              <Spot name="panel" spotKey={id} {...(botRef ? { forBot: botRef.id } : {})} props={{ ...panelProps(id), header, usedLast }} fallback={empty} />
            ),
          };
        })
        .filter((v) => belongsIn(v, kind))
    : [];

  const side: ReactNode =
    kind && open.includes("session")
      ? kind === "bot" && botRef
        ? <Spot name="bot.side" forBot={botRef.id} props={{ bot: botRef, session: tabSession, sessionKind: "bot", openAgent: agent, onOpenAgent: openAgent, navigate }} />
        : <Spot name="panel" spotKey="session" props={{ app: "session", session: tabSession, sessionKind: kind, navigate }} />
      : undefined;

  // A bot's tab draws its bar buttons through the chrome parts (`chrome.tsx`), so its layout may place them; any other tab (an agent's,
  // a code session's) has the standard bar's row.
  const toggles = kind && !botRef ? (
    <PanelToggles kind={kind} open={open} onToggle={(id) => setOpen(toggleView(open, id))} available={VIEWS_BY_KIND[kind].filter((id) => filled.has(id))} />
  ) : undefined;

  const statusEntries = useSpotEntries("status").entries;
  const status = statusEntries.length > 0 ? <Spot name="status" /> : undefined;

  // The last bot tab shown stays mounted while another page shows (KeptTab: hidden, its own layer's frames and its
  // transcript kept), so coming back to it draws it at once, never rebuilt in front of the user. One tab is kept: the
  // bot shown now, else the last one (while it is still a bot here).
  const lastBot = useRef<BotRef | undefined>(undefined);
  if (botRef !== undefined) lastBot.current = botRef;
  const keptBot = botRef ?? (lastBot.current !== undefined && bots?.some((b) => b.id === lastBot.current!.id) ? lastBot.current : undefined);
  const botShown = shown?.route === "bot" && botRef !== undefined;
  // The same element in the same place whatever shows, so React keeps it.
  const main = (
    <>
      {keptBot && (
        <KeptTab key={`bot:${keptBot.id}`} shown={botShown}>
          <BotTabSpot bot={keptBot} onOpenAgent={openAgent} />
        </KeptTab>
      )}
      {!shown || (shown.route === "bot" && !botShown) ? (
        <NothingHere key="loading" title={S.loading} />
      ) : shown.route !== "bot" ? (
        <Spot key="page" name="main" spotKey={shown.route} props={{ route: shown.route, params: shown.params, navigate }} fallback={<NothingHere title={S.nothingHere} />} />
      ) : null}
    </>
  );

  // The bot whose tab shows dresses what Bots offers it of the window's own chrome (its theme's `shell` block, checked by the
  // main process): the bar and the right panels. Any other tab, a dialog's page, the plugin manager, Archive: the stock shell.
  const tokens = useTokens();
  const skin = botRef ? skinOf(tokens, botRef.id) : undefined;
  // The shape the bot's theme gives the bar and the panels (the standard when it says nothing).
  const shape = shapeOf(skin);
  // The sidebar is the app's own and the same on every tab: one fold the user's toggle sets (a bot's own toggle sets the same
  // one), kept for the window's life.
  const [collapsedBy, setCollapsedBy] = useKept<Record<string, boolean>>("shell.sidebar", () => ({}));
  const sidebarCollapsed = collapsedBy["*"] ?? false;
  const setCollapsed = (v: boolean) => setCollapsedBy((c) => ({ ...c, "*": v }));
  const chrome: Omit<ChromeApi, "place" | "panels"> | undefined = botRef && kind
    ? {
        bot: botRef, kind, title,
        open,
        available: kind ? VIEWS_BY_KIND[kind].filter((id) => filled.has(id)) : [],
        toggleView: (id) => setOpen(toggleView(open, id)),
        editBot: () => navigate({ route: "bot-editor", params: { bot: botRef.id } }),
        sidebarCollapsed,
        toggleSidebar: () => setCollapsed(!sidebarCollapsed),
      }
    : undefined;

  // Where the window is, said to the core for the plugin frames that read it (`shell.state`): data only, whenever it changes.
  const appEntries = useSpotEntries("sidebar.app").entries;
  const stateOut: ShellState = {
    tab: { kind: !shown ? "other" : shown.route === "bot" ? "bot" : shown.route === "agent" ? "agent" : shown.route === "bot-editor" ? "bot-editor" : shown.route === "settings" || shown.route === "plugins" || shown.route === "archive" ? shown.route : "app", ...(shown?.params.bot ?? shown?.params.session !== undefined ? { id: (shown?.params.bot ?? shown?.params.session)! } : shown !== undefined && !["bot", "agent", "bot-editor", "settings", "plugins", "archive"].includes(shown.route) ? { id: shown.route } : {}) },
    ...(botRef ? { bot: botRef.id } : {}),
    ...(dialog ? { dialog: "settings" as const } : {}),
    sidebar: { collapsed: sidebarCollapsed, side: kind === "coding" ? "code" : "bots" },
    panels: { open, available: kind ? VIEWS_BY_KIND[kind].filter((id) => filled.has(id)) : [] },
    safeArea: { left: 80, top: 44 },
  };
  const appsOut: ShellApp[] = appEntries.flatMap((e) => (typeof e.fields?.opens === "string" && fieldText(e.fields?.title) !== undefined ? [{ id: e.fields.opens, title: fieldText(e.fields.title)!, ...(typeof e.fields?.icon === "string" ? { icon: e.fields.icon } : {}) }] : []));
  // The account row's data, as the stock sidebar reads it: who is signed in and which computer this is. Said only when a plugin's frame may read it.
  const core = useCore();
  const [account, setAccount] = useState<{ name: string; detail?: string } | undefined>();
  useEffect(() => {
    if (props.report === undefined) return;
    let live = true;
    void Promise.all([core?.call("account.status", {}).catch(() => undefined), api.computers?.list?.().catch(() => [])]).then(([a, computers]) => {
      if (!live) return;
      const here = computers?.find((c: { link?: string; name: string }) => c.link === "self");
      const name = a?.user?.name ?? a?.user?.email ?? here?.name ?? "";
      setAccount({ name, ...(here && name !== here.name ? { detail: here.name } : {}) });
    });
    return () => { live = false; };
  }, [api, core, props.report === undefined]);
  const reportKey = JSON.stringify([stateOut, appsOut, account]);
  const report = props.report;
  useEffect(() => {
    report?.({ state: stateOut, apps: appsOut, ...(account ? { account } : {}) });
  }, [report, reportKey]);

  // An act a bot's own plugin asked for: once per request. Main checked it (the capability, whose tab shows, the user's press); this only does it.
  const handled = useRef(props.act?.n ?? 0);
  const latest = useRef({ chrome, navigate, open, setOpen, setCollapsed, sidebarCollapsed, sessions, bots, kind });
  latest.current = { chrome, navigate, open, setOpen, setCollapsed, sidebarCollapsed, sessions, bots, kind };
  const act = props.act;
  useEffect(() => {
    if (act === undefined || act.n === handled.current) return;
    handled.current = act.n;
    const l = latest.current;
    const a = act.act;
    if (a.kind === "sidebar") l.setCollapsed(a.collapsed ?? !l.sidebarCollapsed);
    else if (a.kind === "panel") {
      if (!l.kind || !VIEWS_BY_KIND[l.kind].includes(a.view as PanelViewId)) return;
      const has = l.open.includes(a.view);
      if (a.to === "open" ? !has : a.to === "closed" ? has : true) l.setOpen(toggleView(l.open, a.view as PanelViewId));
    } else if (a.kind === "editor") {
      if (l.chrome?.bot) l.navigate({ route: "bot-editor", params: { bot: l.chrome.bot.id } });
    } else if (a.kind === "settings") l.navigate({ route: "settings", params: a.section !== undefined ? { section: a.section } : {} });
    else if (a.kind === "go") {
      const t = a.target;
      if ("bot" in t) l.navigate({ route: "bot", params: { bot: t.bot } });
      else if ("session" in t) l.navigate({ route: "agent", params: { session: t.session } });
      else if ("app" in t) l.navigate({ route: t.app, params: {} });
      else if ("page" in t) l.navigate({ route: t.page, params: {} });
      else if (t.side === "code") {
        const code = l.sessions?.find((x) => x.kind === "coding");
        if (code) l.navigate({ route: "agent", params: { session: code.id } });
      } else if (l.bots?.[0]) l.navigate({ route: "bot", params: { bot: l.bots[0].id } });
    }
  }, [act]);

  return (
    <Window
      skin={skin}
      translucent={props.translucent}
      shape={shape}
      chrome={chrome}
      provides={props.provides}
      barFill={botRef ? (stock) => <Spot name="bar" forBot={botRef.id} props={{ bot: botRef, title }} fallback={stock} /> : undefined}
      sidebar={<Spot name="sidebar" props={{ route: shown ?? { route: "bot", params: {} }, navigate, collapsed: sidebarCollapsed, onCollapsedChange: setCollapsed }} />}
      title={title}
      toggles={toggles}
      side={side}
      panel={views.length > 0 && kind ? <PanelHost kind={kind} views={views} onClose={(id) => setOpen(open.filter((v) => v !== id))} onExpand={() => undefined} /> : undefined}
      dialog={dialog ? <Spot name="main" spotKey="settings" props={{ route: "settings", params: dialog.params, navigate, close: closeDialog }} /> : undefined}
      cardPending={cardPending}
      onCloseDialog={closeDialog}
      status={status}
    >
      {main}
    </Window>
  );
}
