// The default shell: the `app.root` entry. It holds the route (what `main` shows) and the panels open on each tab, and
// it places every spot it declares (spec §5.5): the sidebar, `main` keyed by route, the panel host keyed by panel, the
// column beside the conversation, the status bar, and a dialog layer for Settings. What fills each spot is another
// entry, mounted through `<Spot>`; the shell draws only the frame (`Window`), the panel host and its toggles.
//
// MOSS Code's window has no bots (spec §9.4, G8: bots are shown only by MOSS). Routes (`main`'s keys): `agent` (a
// session's live tab: a coding session with any agent the person picked, or a bot's coding task opened from MOSS),
// `new` (the shell's own page to start a session), `settings` (a dialog over the tab under it), `plugins`, and the keys
// app buttons open (`archive`). A route the window kept from before that names a bot (`bot`, `bot-editor`) is dropped:
// the window starts on the newest code session, or on `new` when there is none. Panels by tab (the owner's item 90): a
// session has its column, the terminal, the changes, the files and the browser.
import { fieldText } from "./local";
import type { EntryProps, SessionKind, SessionView } from "@waifucave/moss-plugin-sdk";
import { Spot, useApprovals, useCore, useKept, usePluginApi, useSpotEntries, useTokens } from "@waifucave/moss-plugin-sdk/ui";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ShellApp, ShellState } from "@waifucave/moss-plugin-sdk";
import type { ShellAct } from "@waifucave/moss-plugin-sdk/ui/bridge";
import { useLiveList } from "./data";
import { PanelEmpty, PanelHost } from "./PanelHost";
import { belongsIn, PanelToggles, toggleView, VIEWS_BY_KIND } from "./PanelToggles";
import type { PanelViewId } from "./panel-types";
import type { OwnPanel, PanelView } from "./panel-types";
import { S } from "./strings";
import { Window, shapeOf } from "./Window";
import { NewSession } from "./NewSession";
import { AgentStatus } from "./Tabs";

/** An entry's ref (`<plugin id>#<entry id>`). */
const entryRef = (e: { pluginId: string; id: string }) => `${e.pluginId}#${e.id}`;

/** The panel keys besides the session column, each a `panel` entry's key. */
const PANEL_KEYS = ["terminal", "diff", "browser", "files", "agent"] as const;

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
  /** A coding agent open in the panel. */
  agent?: string;
}

export interface ShellProps {
  /** The window has a system material behind it (lane E): the sidebar lets it through. */
  translucent?: boolean;
  start?: ShellStart;
  /** An act of the window a plugin asked for through `shell.*` (main checked the capability and the user's press): applied once per `n`. */
  act?: { n: number; act: ShellAct };
  /** The essential handles a plugin's own controls offer (`shell.provide`). */
  provides?: { sidebar: boolean; drag: boolean };
  /** Where the window is, for the plugin frames that read it (`shell.state`); the app's own layer hands it to the core. */
  report?: (report: { state: ShellState; apps: readonly ShellApp[]; account?: { name: string; detail?: string } }) => void;
}

/** The routes a window kept from before bots left MOSS Code's window: a bot's tab and its editor. */
const BOT_ROUTES: ReadonlySet<string> = new Set(["bot", "bot-editor"]);

/** A kept route as this window shows it: one that names a bot is no route (the window then starts where it starts). */
export function keptRouteOf(r: ShellRoute | null | undefined): ShellRoute | undefined {
  if (r === null || r === undefined || typeof r !== "object" || typeof r.route !== "string") return undefined;
  return BOT_ROUTES.has(r.route) || (r.params !== null && typeof r.params === "object" && typeof r.params.bot === "string") ? undefined : r;
}

const tabKey = (r: ShellRoute | undefined) => (r ? `${r.route}:${r.params.session ?? ""}` : "");

function NothingHere({ title }: { title: string }) {
  return (
    <div className="cl-shell-empty" role="status">
      <p className="cl-shell-empty__title">{title}</p>
      <p className="cl-shell-empty__detail">{S.nothingHereDetail}</p>
    </div>
  );
}

/** Where the window starts and where "Code" goes: the newest coding session (by when it started) that is live; with
 *  none live, the newest that has stopped (it stays in the lists, marked). An archived one never. */
export function newestCoding(sessions: readonly SessionView[]): SessionView | undefined {
  const newest = (list: readonly SessionView[]) => list.reduce<SessionView | undefined>((a, x) => (a === undefined || x.startedAt > a.startedAt ? x : a), undefined);
  const mine = sessions.filter((x) => x.kind === "coding" && x.archived !== true);
  return newest(mine.filter((x) => x.status !== "stopped")) ?? newest(mine);
}

/** Where the window goes with no route: the newest code session, else the page that starts one. */
export function startRoute(sessions: readonly SessionView[] | undefined): ShellRoute | undefined {
  if (sessions === undefined) return undefined;
  const code = newestCoding(sessions);
  return code !== undefined ? { route: "agent", params: { session: code.id } } : { route: "new", params: {} };
}

export function Shell({ props }: EntryProps<ShellProps>) {
  const api = usePluginApi();
  // Where the user is (the route, the tab under Settings, each tab's open panels and agent) outlives a reload of this
  // document: installing, turning on or updating a plugin with its own layer loads it again, and the window shows the
  // same place from its first frame (`useKept`, the window's own session storage). A kept route that names a bot (from
  // before bots left this window) is dropped.
  const [keptRoute, setRoute] = useKept<ShellRoute | null>("shell.route", () => props.start?.route ?? null);
  const route = keptRouteOf(keptRoute);
  // Settings opens over the tab the user was on, which stays under it.
  const [keptUnder, setUnder] = useKept<ShellRoute | null>("shell.under", () => props.start?.under ?? null);
  const under = keptRouteOf(keptUnder);
  const startTab = props.start?.route?.route === "settings" ? props.start.under : props.start?.route;
  const [panels, setPanels] = useKept<Record<string, string[]>>("shell.panels", () => (startTab && props.start?.panels ? { [tabKey(startTab)]: props.start.panels } : {}));
  const [agents] = useKept<Record<string, string | undefined>>("shell.agents", () => (startTab && props.start?.agent ? { [tabKey(startTab)]: props.start.agent } : {}));

  // The code sessions, read once and followed through `sessions.watch` (`sessions.read`): one started outside the window
  // (the CLI, another window, a bot's coding task) is known at once.
  const sessions = useLiveList<SessionView>(() => api.sessions?.list?.() ?? Promise.resolve([] as SessionView[]), api.sessions?.watch ? (l) => api.sessions!.watch(l) : undefined, (a, b) => a.id === b.id, [api]);

  // No route (a first start, or a kept one that named a bot): the newest code session, else the page that starts one.
  useEffect(() => {
    if (route !== undefined) return;
    const to = startRoute(sessions);
    if (to !== undefined) setRoute(to);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route === undefined, sessions === undefined]);
  // A kept tab under Settings that named a bot goes too.
  useEffect(() => {
    if (keptUnder !== null && under === undefined) setUnder(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keptUnder !== null && under === undefined]);

  const dialog = route?.route === "settings" ? route : undefined;
  const shown = dialog ? under : route;
  const session = shown?.route === "agent" ? sessions?.find((s) => s.id === shown.params.session) : undefined;
  const kind: SessionKind | undefined = shown?.route === "agent" ? (session?.kind ?? "agent") : undefined;
  const tabSession = session?.id;
  const key = tabKey(shown);
  const open = panels[key] ?? [];
  const agent = agents[key];
  const agentSession = agent ? sessions?.find((s) => s.id === agent) : undefined;

  const navigate = (next: ShellRoute) => {
    if (keptRouteOf(next) === undefined) return;
    if (next.route === "settings" && route?.route !== "settings") setUnder(route ?? null);
    setRoute(next);
  };
  const closeDialog = () => setRoute(under ?? null);
  const setOpen = (next: string[]) => setPanels((p) => ({ ...p, [key]: next }));

  // Any card this window will draw: one in a session it shows (the tab's, the agent's in the panel), or one raised
  // from a dialog (a level change, removing a device), which has no session.
  const { cards } = useApprovals();
  const showing = new Set([tabSession, agent].filter((s): s is string => s !== undefined));
  const cardPending = cards.some((c) => c.session === undefined || showing.has(c.session));

  const appButtons = useSpotEntries("sidebar.app").entries;
  const title = (() => {
    if (!shown) return "";
    if (shown.route === "agent") return session?.title ?? S.views.agent!;
    if (shown.route === "new") return S.newSession;
    if (shown.route === "plugins") return S.plugins;
    const app = appButtons.find((e) => e.fields?.opens === shown.route);
    return fieldText(app?.fields?.title) ?? (shown.params.title !== undefined ? fieldText(shown.params.title) : undefined) ?? shown.route;
  })();

  const panelProps = (id: string): Record<string, unknown> =>
    id === "agent" && agentSession
      ? { app: id, session: agentSession.id, sessionKind: agentSession.kind }
      : { app: id, session: tabSession, sessionKind: kind };
  // Which panels anything fills (the `panel` spot by key): a toggle is offered only for one that does, and an open panel
  // whose filler goes away closes. A constant list of hooks, whatever the tab.
  const answers: boolean[] = [];
  const entriesOf = (spot: string, key: string | undefined, props: Record<string, unknown>) => {
    const r = useSpotEntries(spot, key, { ...props, forSessionKind: props.sessionKind });
    answers.push((r as { loaded?: boolean }).loaded !== false);
    return r.entries;
  };
  const entryLists = [
    entriesOf("panel", "session", panelProps("session")),
    ...PANEL_KEYS.map((id) => entriesOf("panel", id, panelProps(id))),
  ];
  const filledList = entryLists.map((l) => l.length > 0);
  // The panels plugins add (a `panel` entry whose key isn't a stock panel's): the main process lists those that apply on this tab, and each
  // is named `<plugin id>#<key>` in the window's state so two plugins' keys never collide.
  const ownEntries = entriesOf("panel", "*", panelProps("*"));
  const ownById = new Map<string, (typeof ownEntries)[number]>(kind ? ownEntries.flatMap((e) => (e.key !== undefined && fieldText(e.fields?.title) !== undefined ? [[`${e.pluginId}#${e.key}`, e] as const] : [])) : []);
  const own: OwnPanel[] = [...ownById].map(([id, e]) => ({ id, title: fieldText(e.fields?.title)!, ...(typeof e.fields?.icon === "string" ? { icon: e.fields.icon } : {}) }));
  const filled = new Set<string>([...(filledList[0] ? ["session"] : []), ...PANEL_KEYS.filter((_, i) => filledList[i + 1]), ...ownById.keys()]);
  // Not before the tab's session is known: its kind decides which panels fit it (`when.session`), and until then it is a guess.
  const settled = (shown?.route !== "agent" || session !== undefined) && (agent === undefined || agentSession !== undefined);
  // Nor before every spot has answered once: a window document that loads again (a plugin's layer first served) starts with empty
  // lists, and an open panel is not one whose filler went away.
  const closing = kind && settled && answers.every(Boolean) ? open.filter((id) => !filled.has(id)) : [];
  useEffect(() => {
    if (closing.length > 0) setOpen(open.filter((id) => filled.has(id)));
  }, [closing.join("|"), key]);
  const views: PanelView[] = kind
    ? open
        .filter((id) => id !== "session")
        .map((id) => {
          const added = ownById.get(id);
          if (added !== undefined) {
            const title = fieldText(added.fields?.title)!;
            return {
              id,
              title,
              content: (header: HTMLElement | null, usedLast: boolean) => (
                <Spot name="panel" spotKey={added.key} entry={entryRef(added)} props={{ app: added.key, session: tabSession, sessionKind: kind, header, usedLast }} fallback={<PanelEmpty id={id} title={title} onFindPlugin={() => undefined} />} />
              ),
            };
          }
          const base = id === "agent" ? (agentSession?.title ?? S.views.agent!) : (S.views[id] ?? id);
          const empty = <PanelEmpty id={id} title={S.views[id] ?? id} onFindPlugin={(k) => navigate({ route: "plugins", params: { spot: "panel", key: k } })} />;
          return {
            id,
            title: base,
            content: (header: HTMLElement | null, usedLast: boolean) => (
              <Spot name="panel" spotKey={id} props={{ ...panelProps(id), header, usedLast }} fallback={empty} />
            ),
          };
        })
        .filter((v) => belongsIn(v, kind))
    : [];

  const side: ReactNode = kind && open.includes("session")
    ? <Spot name="panel" spotKey="session" props={{ app: "session", session: tabSession, sessionKind: kind, navigate }} />
    : undefined;

  const toggles = kind ? (
    <>
      {session !== undefined && <AgentStatus session={session} />}
      <PanelToggles kind={kind} open={open} onToggle={(id) => setOpen(toggleView(open, id))} available={VIEWS_BY_KIND[kind].filter((id) => filled.has(id))} own={own} />
    </>
  ) : undefined;

  const statusEntries = useSpotEntries("status").entries;
  const status = statusEntries.length > 0 ? <Spot name="status" /> : undefined;

  const main = !shown ? (
    <NothingHere key="loading" title={S.loading} />
  ) : shown.route === "new" ? (
    <NewSession key="new" onStarted={(id) => navigate({ route: "agent", params: { session: id } })} />
  ) : (
    <Spot key="page" name="main" spotKey={shown.route} props={{ route: shown.route, params: shown.params, navigate }} fallback={<NothingHere title={S.nothingHere} />} />
  );

  const tokens = useTokens();
  const shape = shapeOf(undefined);
  // The sidebar is the app's own and the same on every tab: one fold the user's toggle sets, kept for the window's life.
  const [collapsedBy, setCollapsedBy] = useKept<Record<string, boolean>>("shell.sidebar", () => ({}));
  const sidebarCollapsed = collapsedBy["*"] ?? false;
  // The sidebar's drawn width (Window measures it): a tab starts at its right edge.
  const [sidebarWidth, setSidebarWidth] = useState<number | undefined>();
  // The window's own controls' reach, from the frame's variables (macOS: the traffic lights, 80 px; Windows and Linux draw theirs at the other end: 0).
  const px = (v: unknown, or: number) => { const n = Number.parseFloat(String(v ?? "")); return Number.isFinite(n) && n >= 0 ? Math.round(n) : or; };
  const safeArea = { left: px(tokens["frame.window.controls"], 80), top: px(tokens["frame.inset.top"], 44) };
  const setCollapsed = (v: boolean) => setCollapsedBy((c) => ({ ...c, "*": v }));

  // Where the window is, said to the core for the plugin frames that read it (`shell.state`): data only, whenever it changes.
  const appEntries = useSpotEntries("sidebar.app").entries;
  const stateOut: ShellState = {
    tab: { kind: !shown ? "other" : shown.route === "agent" ? "agent" : shown.route === "settings" || shown.route === "plugins" || shown.route === "archive" ? shown.route : "app", ...(shown?.params.session !== undefined ? { id: shown.params.session } : shown !== undefined && !["agent", "settings", "plugins", "archive"].includes(shown.route) ? { id: shown.route } : {}) },
    ...(dialog ? { dialog: "settings" as const } : {}),
    sidebar: { collapsed: sidebarCollapsed, side: "code", ...(sidebarWidth !== undefined ? { width: sidebarWidth } : {}) },
    panels: { open, available: kind ? [...VIEWS_BY_KIND[kind].filter((id) => filled.has(id)), ...own.map((o) => o.id)] : [], ...(kind && own.length > 0 ? { titles: Object.fromEntries(own.map((o) => [o.id, o.title])) } : {}) },
    safeArea,
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

  // An act a plugin asked for: once per request. Main checked it (the capability, the user's press); this only does it.
  // A target that names a bot, or the bots' side, has no place in this window and is ignored.
  const handled = useRef(props.act?.n ?? 0);
  const latest = useRef({ navigate, open, setOpen, setCollapsed, sidebarCollapsed, sessions, kind, ownIds: own.map((o) => o.id) });
  latest.current = { navigate, open, setOpen, setCollapsed, sidebarCollapsed, sessions, kind, ownIds: own.map((o) => o.id) };
  const act = props.act;
  useEffect(() => {
    if (act === undefined || act.n === handled.current) return;
    handled.current = act.n;
    const l = latest.current;
    const a = act.act;
    if (a.kind === "sidebar") l.setCollapsed(a.collapsed ?? !l.sidebarCollapsed);
    else if (a.kind === "panel") {
      if (!l.kind || !(VIEWS_BY_KIND[l.kind].includes(a.view as PanelViewId) || l.ownIds.includes(a.view))) return;
      const has = l.open.includes(a.view);
      if (a.to === "open" ? !has : a.to === "closed" ? has : true) l.setOpen(toggleView(l.open, a.view as PanelViewId));
    } else if (a.kind === "settings") l.navigate({ route: "settings", params: a.section !== undefined ? { section: a.section } : {} });
    else if (a.kind === "go") {
      const t = a.target;
      if ("session" in t) l.navigate({ route: "agent", params: { session: t.session } });
      else if ("app" in t) l.navigate({ route: t.app, params: {} });
      else if ("page" in t) l.navigate({ route: t.page, params: {} });
      else if ("side" in t && t.side === "code") {
        const code = newestCoding(l.sessions ?? []);
        l.navigate(code ? { route: "agent", params: { session: code.id } } : { route: "new", params: {} });
      }
    }
  }, [act]);

  return (
    <Window
      translucent={props.translucent}
      shape={shape}
      provides={props.provides}
      onSidebarWidth={setSidebarWidth}
      safeArea={safeArea}
      sidebar={<Spot name="sidebar" props={{ route: shown ?? { route: "new", params: {} }, navigate, collapsed: sidebarCollapsed, onCollapsedChange: setCollapsed }} />}
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
