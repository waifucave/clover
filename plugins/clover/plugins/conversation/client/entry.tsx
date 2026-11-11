// The conversation part on the runtime: the `conversation` entry. It reads the session through the plugin API
// (`conversation.history`, then `conversation.follow` for what comes next), projects the core's events into the view's
// items (`project.ts`), and points the spots it declares at <Spot>s: each message through `conversation.message`
// keyed by kind (the `approval` key can't be hidden), each tool result through `tool.result` keyed by tool name, and
// the add-ons under each message through `conversation.message.extra`. Where no plugin fills a key, the view draws it
// itself. Plugins' small buttons in a message's row of actions are `conversation.message.action` entries: data this part
// draws itself, never a component (an add-on from a plugin outside Clover's tree is a frame under every message), and a
// press goes to the app's own door (`conversation.messageAction`), which finds the entry and runs its plugin's handler.
//
// The session's card events (`card_pending`, `card_resolved`) are expected in the followed stream, so a card and how it
// ended sit in the transcript in order: a question for B, since the plugin API's `approvals.watch` gives only the
// pending list.
//
// The archive draws an old session (from the app Clover replaces) through this spot too, with `archived`: then the part reads the session
// from the core's `archive.history` (the `clover` layer's call), follows nothing and answers nothing. That history runs
// forward from the session's start, a page at a time by its `cursor`, so an old session opens at its start and the
// next page comes as the reader nears the end (the view's `onLoadLater`), until the whole session is shown.
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
import type { AgentStatus } from "./agents";
import { ConversationView, DEFAULT_RENDERERS, type MessageRenderers } from "./ConversationView";
import type { MessageSpotProps } from "./context";
import { project, type CoreEvent } from "./project";
import { plain } from "../../shell/runtime/views";
import { Spot, useBotSpeech, useCore, usePluginApi, useSpotEntries, useTokens } from "./sdk";
import type { ActionOutcome, BotItem, ConversationItem, MessageAction, QuestionAnswer, SharedTime, SpeakOutcome } from "./types";

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

/** How many past events a tab reads before following live. */
const HISTORY_PAGE = 500;

/** Each `conversation.message` key drawn through its spot, falling back to the view's own renderer. */
function spotRenderers(): Partial<MessageRenderers> {
  const out: Partial<Record<keyof MessageRenderers, ComponentType<any>>> = {};
  for (const kind of Object.keys(DEFAULT_RENDERERS) as (keyof MessageRenderers)[]) {
    const Standard = DEFAULT_RENDERERS[kind] as ComponentType<any>;
    const Through = (p: MessageSpotProps<unknown> & Record<string, unknown>) => (
      <Spot name="conversation.message" spotKey={kind} props={{ bot: p.bot, session: p.session, item: p.item, ctx: p.ctx }} fallback={<Standard {...p} />} />
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
  const conv = api.conversation;
  const [events, setEvents] = useState<CoreEvent[]>([]);
  const [hasEarlier, setHasEarlier] = useState(false);
  /** An archived session's next page: the cursor `archive.history` gave, while there is more. */
  const [later, setLater] = useState<string | undefined>(undefined);
  /** Which read is current (a new session starts another), and whether a next page is on its way. */
  const reading = useRef({ session: "", loading: false });
  const archived = props.archived === true;

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
      });
      return () => {
        live = false;
      };
    }
    conv?.history?.(props.session, { limit: HISTORY_PAGE }).then(
      (page) => {
        if (!live) return;
        setEvents((later) => [...page.events, ...later]);
        setHasEarlier(page.hasMore);
      },
      () => undefined,
    );
    const stop = conv?.follow?.(props.session, (e) => live && setEvents((list) => [...list, e]));
    return () => {
      live = false;
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

  const { names, here, voiced } = useNames(api);
  const { items, turn } = useMemo(() => project(events, { name: (kind, id) => names[`${kind}:${id}`] }), [events, names]);
  const at = { bot: props.bot, session: props.session };
  // The theme can set a finished reply's add-ons in its actions row (`conversation.extra.inline`): only where the view's
  // own reply renderer draws the reply, since a plugin's renderer has no such row.
  const tokens = useTokens();
  const ownReply = useSpotEntries("conversation.message", "bot").entries.length === 0;
  const extraInline = Number(tokens["conversation.extra.inline"] ?? 0) === 1 && ownReply;
  // Speak one past reply: for a bot with a voice, in its main conversation, through the app's door with the user's click
  // (`voice.speak` takes the session and the reply's seq; the core reads the text from the log).
  const speech = useBotSpeech(props.bot.id);
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
  const canSpeak = !archived && core !== undefined && voiced[props.bot.id] === props.session;
  const speak = useCallback(
    (item: BotItem): Promise<SpeakOutcome> => core!.call("voice.speak", { session: props.session, seq: item.seq! }),
    [core, props.session],
  );

  return (
    <ConversationView
      bot={props.bot}
      session={props.session}
      items={items as ConversationItem[]}
      turn={turn}
      now={props.now ?? Date.now()}
      hasEarlier={hasEarlier}
      {...(archived ? { initialFollow: false, hasLater: later !== undefined, onLoadLater: loadLater } : {})}
      {...(here ? { device: here } : {})}
      renderers={RENDERERS}
      agentStatus={agentStatus}
      renderToolResult={(call, standard): ReactNode => (
        <Spot name="tool.result" spotKey={call.name} props={{ ...at, tool: call.name, item: call, ctx: {} }} fallback={standard} />
      )}
      renderMessageExtra={(item) => <Spot name="conversation.message.extra" props={{ ...at, item, ctx: {} }} />}
      extraInline={extraInline}
      onAnswerQuestion={archived ? undefined : (callId: string, answer: QuestionAnswer) => conv?.answer?.(props.session, callId, answer.answers)}
      onOpenAgent={props.onOpenAgent}
      onOpenFile={props.onOpenFile}
      onCopy={(text) => void navigator.clipboard?.writeText(text)}
      {...(canSpeak ? { onSpeak: speak, speaking: speech.speaking } : {})}
      {...(messageActions.length > 0 && core !== undefined ? { messageActions, onMessageAction: runAction } : {})}
      // Try again on a failed turn: the app's own door checks the session's log and sends the user's own words again.
      onTryAgain={archived || !core ? undefined : () => core.call("session.resend", { session: props.session })}
    />
  );
}

/** Display names for the bots, agents and devices a transcript mentions, by `<kind>:<id>`. */
function useNames(api: ReturnType<typeof usePluginApi>): { names: Record<string, string>; here?: { id: string; name: string }; voiced: Record<string, string> } {
  const [names, setNames] = useState<{ names: Record<string, string>; here?: { id: string; name: string }; voiced: Record<string, string> }>({ names: {}, voiced: {} });
  useEffect(() => {
    let live = true;
    void Promise.all([
      api.bots?.list().catch(() => []) ?? [],
      api.conversation?.list?.().catch(() => []) ?? [],
      api.devices?.list().catch(() => []) ?? [],
    ]).then(([bots, sessions, devices]) => {
      if (!live) return;
      const out: Record<string, string> = {};
      // The bots with a voice, by their main conversation: where a reply can be spoken on request.
      const voiced: Record<string, string> = {};
      for (const b of bots) {
        out[`bot:${b.id}`] = plain(b.name);
        const v = b as { voice?: unknown; mainSession?: unknown };
        if (v.voice !== undefined && v.voice !== null && typeof v.mainSession === "string") voiced[b.id] = v.mainSession;
      }
      for (const s of sessions) out[`agent:${s.id}`] = s.backend ?? s.title ?? s.id;
      for (const d of devices) out[`device:${d.id}`] = d.name;
      const here = devices.find((d) => d.isThis);
      setNames({ names: out, voiced, ...(here ? { here: { id: here.id, name: here.name } } : {}) });
    });
    return () => {
      live = false;
    };
  }, [api]);
  return names;
}
