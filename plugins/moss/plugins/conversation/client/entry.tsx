// The conversation part on the runtime: the `conversation` entry. It reads the session through the plugin API
// (`conversation.history`, then `conversation.follow` for what comes next), projects the core's events into the view's
// items (`project.ts`), and points the spots it declares at <Spot>s: each message through `conversation.message`
// keyed by kind (the `approval` key can't be hidden), each tool result through `tool.result` keyed by tool name, and
// the add-ons under each message through `conversation.message.extra`. Where no plugin fills a key, the view draws it
// itself. Plugins' small buttons in a message's row of actions are `conversation.message.action` entries: data this part
// draws itself, never a component (an add-on from a plugin outside MOSS's tree is a frame under every message), and a
// press goes to the app's own door (`conversation.messageAction`), which finds the entry and runs its plugin's handler.
//
// A card is a core event, never a session record, so `conversation.follow` doesn't carry it: the part hears its bot's
// pending cards through the card door every plugin with `approvals` gets (`useApprovals`: ids, kinds, options, the
// session; never a word), and draws this session's in place as `card_pending` at the end of what it projects, the sealed
// frames placed by the approval cell. A card answered anywhere leaves the list and its cell goes; the turn that waited
// on it carries on in the transcript. Questions are ordinary cells, from the session's own records.
//
// The archive draws an old session (from the app MOSS replaces) through this spot too, with `archived`: then the part reads the session
// from the core's `archive.history` (the `moss` layer's call), follows nothing and answers nothing. That history runs
// forward from the session's start, a page at a time by its `cursor`, so an old session opens at its start and the
// next page comes as the reader nears the end (the view's `onLoadLater`), until the whole session is shown.
import { plain } from "./local";
import { Spot, SpotHints, useApprovals, useBackendNames, useCore, usePluginApi, useSpotEntries, useTokens } from "@waifucave/moss-plugin-sdk/ui";
import { useCallback, useContext, useEffect, useMemo, useRef, useState, type ComponentProps, type ComponentType, type ReactNode } from "react";
import type { AgentStatus } from "./agents";
import { ConversationView, DEFAULT_RENDERERS, type MessageRenderers } from "./ConversationView";
import type { MessageSpotProps } from "./context";
import { project, type CoreEvent } from "./project";
import type { ActionOutcome, ConversationItem, MessageAction, QuestionAnswer, SharedTime } from "./types";

export interface ConversationEntryProps {
  bot: { id: string; name: string };
  session: string;
  /** Opens an agent's live tab: a bot's tab opens it in the panel (the owner's item 90). */
  onOpenAgent?: (agentId: string) => void;
  onOpenFile?: (path: string) => void;
  /** The shared clock's now, for deadlines and day labels; the device's clock when absent. */
  now?: SharedTime;
  /** An old session from the archive: read from `archive.history`, page by page from its start, read only. */
  archived?: boolean;
}

/** A plugin's picture for a message action, as the app serves a plugin's own image (`/_t/<plugin>/<path>`): only a
 *  relative image path inside its folder. */
const ACTION_ICON = /^(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\.(?:png|jpe?g|webp|gif|avif|svg)$/i;
function actionIcon(pluginId: string, path: unknown): string | undefined {
  if (typeof path !== "string" || !ACTION_ICON.test(path)) return undefined;
  return `/_t/${encodeURIComponent(pluginId)}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

/** The `conversation.message.action` entries as the view draws them: data, a ref to name on a press, nothing else. */
function messageActionsOf(entries: readonly unknown[]): MessageAction[] {
  const out: MessageAction[] = [];
  for (const raw of entries) {
    const e = raw as { ref?: unknown; pluginId?: unknown; id?: unknown; fields?: Record<string, unknown> };
    if (typeof e.pluginId !== "string") continue;
    const ref = typeof e.ref === "string" ? e.ref : typeof e.id === "string" ? `${e.pluginId}#${e.id}` : undefined;
    const f = e.fields ?? {};
    const title = typeof f.title === "string" ? plain(f.title) : "";
    if (ref === undefined || title === "" || typeof f.call !== "string") continue;
    const on = f.on === "user" || f.on === "both" ? f.on : "assistant";
    const icon = actionIcon(e.pluginId, f.icon);
    out.push({ ref, title, on, ...(icon !== undefined ? { icon } : {}) });
  }
  return out;
}

/** A spot inside the transcript (a message, its add-ons, a tool's result): drawn only once this part knows the kind of the
 *  session it shows, which it tells the core (`SpotHints`) so that what a plugin needs to read it (`sessions.read` for a code
 *  session, `conversation.read` for a bot's conversation) is the data's own, never the placing part's say. Until then it draws
 *  its fallback, and no plugin's entry is asked. */
function Inner(p: ComponentProps<typeof Spot>) {
  const known = useContext(SpotHints).session !== undefined;
  return known ? <Spot {...p} /> : <>{p.fallback ?? null}</>;
}

/** How many past events a tab reads before following live. */
const HISTORY_PAGE = 500;

/** Each `conversation.message` key drawn through its spot, falling back to the view's own renderer. */
function spotRenderers(): Partial<MessageRenderers> {
  const out: Partial<Record<keyof MessageRenderers, ComponentType<any>>> = {};
  for (const kind of Object.keys(DEFAULT_RENDERERS) as (keyof MessageRenderers)[]) {
    const Standard = DEFAULT_RENDERERS[kind] as ComponentType<any>;
    const Through = (p: MessageSpotProps<unknown> & Record<string, unknown>) => (
      <Inner name="conversation.message" spotKey={kind} props={{ bot: p.bot, session: p.session, item: p.item, ctx: p.ctx }} fallback={<Standard {...p} />} />
    );
    Through.displayName = `Spot(conversation.message:${kind})`;
    out[kind] = Through;
  }
  return out as Partial<MessageRenderers>;
}

const RENDERERS = spotRenderers();

export function ConversationEntry({ props }: { props: ConversationEntryProps }) {
  const api = usePluginApi();
  const core = useCore();
  // MOSS Code's window shows code sessions only (spec §9.4): read through `sessions.*` (`sessions.read`); the user's
  // answer to a question card goes through `conversation.answer` (`conversation.post`). An archived session (the
  // previous app's, whose kind isn't kept) is read with both reads (`archive.history`), so the part keeps
  // `conversation.read` for the archive alone.
  const conv = api.sessions;
  const [events, setEvents] = useState<CoreEvent[]>([]);
  const [hasEarlier, setHasEarlier] = useState(false);
  /** The session whose first page has answered (or failed): until then the view draws no empty state. */
  const [loadedFor, setLoadedFor] = useState<string | undefined>(undefined);
  /** An archived session's next page: the cursor `archive.history` gave, while there is more. */
  const [later, setLater] = useState<string | undefined>(undefined);
  /** Which read is current (a new session starts another), and whether a next page is on its way. */
  const reading = useRef({ session: "", loading: false });
  const archived = props.archived === true;
  // The kind of the session shown, from the session itself (never from what the placing part says): a live session's own
  // view says it; an archived one's can't be told, so its spots need both reads.
  const [kindOf, setKindOf] = useState<{ session: string; kind: string } | undefined>(undefined);
  useEffect(() => {
    if (archived) return;
    let live = true;
    conv?.get?.(props.session).then((v) => live && setKindOf({ session: props.session, kind: String(v.kind) }), () => undefined);
    return () => {
      live = false;
    };
  }, [conv, archived, props.session]);
  const shownKind = archived ? "archived" : kindOf?.session === props.session ? kindOf.kind : undefined;
  const hints = useMemo(() => (shownKind === undefined ? {} : { session: shownKind }), [shownKind]);

  useEffect(() => {
    let live = true;
    setEvents([]);
    setLater(undefined);
    if (archived) {
      const read = { session: props.session, loading: true };
      reading.current = read;
      core?.call("archive.history", { id: props.session, limit: HISTORY_PAGE }).then(
        (page) => {
          if (!live) return;
          setEvents(page.events as CoreEvent[]);
          setHasEarlier(false);
          setLater(page.cursor);
        },
        () => undefined,
      ).finally(() => {
        read.loading = false;
        if (live) setLoadedFor(props.session);
      });
      return () => {
        live = false;
      };
    }
    const read = conv?.history?.(props.session, { limit: HISTORY_PAGE });
    if (read === undefined) setLoadedFor(props.session);
    read?.then(
      (page) => {
        if (!live) return;
        setEvents((later) => [...page.events, ...later]);
        setHasEarlier(page.hasMore);
      },
      () => undefined,
    ).finally(() => {
      if (live) setLoadedFor(props.session);
    });
    // What the followed stream brings comes in at most once a frame, however many events (a streamed reply's words) came
    // in it: one projection of the transcript and one draw per frame, not one per word.
    let queued: CoreEvent[] = [];
    let frame: ReturnType<typeof setTimeout> | number | undefined;
    const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (fn: FrameRequestCallback) => setTimeout(() => fn(0), 16);
    const cancel = (id: ReturnType<typeof setTimeout> | number) => (typeof cancelAnimationFrame === "function" && typeof id === "number" ? cancelAnimationFrame(id) : clearTimeout(id as ReturnType<typeof setTimeout>));
    const flush = () => {
      frame = undefined;
      if (!live || queued.length === 0) return;
      const add = queued;
      queued = [];
      setEvents((list) => [...list, ...add]);
    };
    const stop = conv?.follow?.(props.session, (e) => {
      if (!live) return;
      queued.push(e);
      if (frame === undefined) frame = raf(flush);
    });
    return () => {
      live = false;
      if (frame !== undefined) cancel(frame);
      stop?.();
    };
  }, [conv, core, archived, props.session]);

  const loadLater = useCallback(() => {
    const read = reading.current;
    if (!archived || !core || later === undefined || read.loading) return;
    read.loading = true;
    const session = props.session;
    core.call("archive.history", { id: session, cursor: later, limit: HISTORY_PAGE }).then(
      (page) => {
        if (reading.current !== read) return;
        setEvents((list) => [...list, ...(page.events as CoreEvent[])]);
        setLater(page.cursor);
      },
      () => undefined,
    ).finally(() => {
      read.loading = false;
    });
  }, [archived, core, later, props.session]);

  // Agents this session started: the sessions area's `session_changed`, kept by session id (the agent cards' live status).
  const [agentStatus, setAgentStatus] = useState<Record<string, AgentStatus>>({});
  useEffect(() => {
    setAgentStatus({});
    if (!core || archived) return;
    return core.on("session_changed", (e) => {
      const s = (e as { session?: { id?: string; kind?: string; parent?: string; status?: string; backend?: string; definition?: string } }).session;
      if (!s || s.kind !== "agent" || s.parent !== props.session || typeof s.id !== "string") return;
      const next: AgentStatus = { status: String(s.status ?? "working"), ...(s.backend ? { backend: s.backend } : {}), ...(s.definition ? { definition: s.definition } : {}) };
      setAgentStatus((m) => ({ ...m, [s.id as string]: next }));
    });
  }, [core, archived, props.session]);

  const nameOf = useBackendNames();
  const { names, here } = useNames(api, nameOf);
  const shownStatus = useMemo(() => Object.fromEntries(Object.entries(agentStatus).map(([id, s]) => [id, s.backend === undefined ? s : { ...s, backend: nameOf(s.backend) ?? s.backend }])), [agentStatus, nameOf]);
  // This session's pending cards, as the card door says (never in the followed stream): drawn in place, after what the
  // session's own records project. Kept while the list says the same, so the transcript isn't projected again per render.
  const approvals = useApprovals();
  const cardsKey = archived ? "" : JSON.stringify(approvals.cards.filter((c) => c.session === props.session));
  const cardEvents = useMemo<CoreEvent[]>(
    () => (cardsKey === "" ? [] : (JSON.parse(cardsKey) as { issuedAt?: number }[]).map((card) => ({ type: "card_pending", card, ...(typeof card.issuedAt === "number" ? { ts: card.issuedAt } : {}) }))),
    [cardsKey],
  );
  const { items, turn } = useMemo(() => project([...events, ...cardEvents], { name: (kind, id) => names[`${kind}:${id}`], backend: (id) => nameOf(id) }), [events, cardEvents, names, nameOf]);
  // The view's clock (day labels, deadlines): read again when the transcript changed or the shared clock moved, never at every
  // render of this entry. A `Date.now()` in the props would be new each render, and the view would build its timeline and
  // draw every message again for it (the cost grows with the conversation: an owner's has hundreds).
  const sharedNow = props.now;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  // A new message, not a streamed word: a new clock for every word would draw every row again.
  const now = useMemo(() => sharedNow ?? Date.now(), [sharedNow, items.length]);
  const at = { bot: props.bot, session: props.session };
  // The theme can set a finished reply's add-ons in its actions row (`conversation.extra.inline`): only where the view's
  // own reply renderer draws the reply, since a plugin's renderer has no such row.
  const tokens = useTokens();
  const ownReply = useSpotEntries("conversation.message", "bot").entries.length === 0;
  const extraInline = Number(tokens["conversation.extra.inline"] ?? 0) === 1 && ownReply;
  // Plugins' small buttons for a message's row (data the view draws; no frame per message). A press names the entry, the
  // session and the message's seq on the app's own door; main finds the entry and runs its handler.
  const actionEntries = useSpotEntries("conversation.message.action").entries;
  // Kept while the entries say the same, so the view's messages don't redraw on every render.
  const actionsKey = archived ? "" : JSON.stringify(messageActionsOf(actionEntries));
  const messageActions = useMemo<MessageAction[]>(() => (actionsKey === "" ? [] : (JSON.parse(actionsKey) as MessageAction[])), [actionsKey]);
  const runAction = useCallback(
    (action: MessageAction, item: { seq?: number }): Promise<ActionOutcome> =>
      core!.call("conversation.messageAction", { entry: action.ref, session: props.session, seq: item.seq! }) as Promise<ActionOutcome>,
    [core, props.session],
  );

  return (
    <SpotHints.Provider value={hints}>
      <ConversationView
        bot={props.bot}
        session={props.session}
        items={items as ConversationItem[]}
        turn={turn}
        now={now}
        hasEarlier={hasEarlier}
        loaded={loadedFor === props.session}
        {...(archived ? { initialFollow: false, hasLater: later !== undefined, onLoadLater: loadLater } : {})}
        {...(here ? { device: here } : {})}
        renderers={RENDERERS}
        agentStatus={shownStatus}
        renderToolResult={(call, standard): ReactNode => (
          <Inner name="tool.result" spotKey={call.name} props={{ ...at, tool: call.name, item: call, ctx: {} }} fallback={standard} />
        )}
        renderMessageExtra={(item) => <Inner name="conversation.message.extra" props={{ ...at, item, ctx: {} }} />}
        extraInline={extraInline}
        onAnswerQuestion={archived ? undefined : (callId: string, answer: QuestionAnswer) => api.conversation?.answer?.(props.session, callId, answer.answers)}
        onOpenAgent={props.onOpenAgent}
        onOpenFile={props.onOpenFile}
        onCopy={(text) => void navigator.clipboard?.writeText(text)}
        {...(messageActions.length > 0 && core !== undefined ? { messageActions, onMessageAction: runAction } : {})}
        // Try again on a failed turn: the app's own door checks the session's log and sends the user's own words again.
        onTryAgain={archived || !core ? undefined : () => core.call("session.resend", { session: props.session })}
      />
    </SpotHints.Provider>
  );
}

/** Display names for the agents and devices a transcript mentions, by `<kind>:<id>` (a bot's is its id: bots are MOSS's to show). */
function useNames(api: ReturnType<typeof usePluginApi>, backendName: (backend: string | undefined) => string | undefined): { names: Record<string, string>; here?: { id: string; name: string } } {
  const [names, setNames] = useState<{ names: Record<string, string>; here?: { id: string; name: string } }>({ names: {} });
  useEffect(() => {
    let live = true;
    void Promise.all([
      api.sessions?.list?.().catch(() => []) ?? [],
      api.devices?.list().catch(() => []) ?? [],
    ]).then(([sessions, devices]) => {
      if (!live) return;
      const out: Record<string, string> = {};
      for (const s of sessions) out[`agent:${s.id}`] = backendName(s.backend) ?? s.title ?? s.id;
      for (const d of devices) out[`device:${d.id}`] = d.name;
      const here = devices.find((d) => d.isThis);
      setNames({ names: out, ...(here ? { here: { id: here.id, name: here.name } } : {}) });
    });
    return () => {
      live = false;
    };
  }, [api, backendName]);
  return names;
}
