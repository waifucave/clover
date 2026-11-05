// The conversation part on the runtime: the `conversation` entry. It reads the session through the plugin API
// (`conversation.history`, then `conversation.follow` for what comes next), projects the core's events into the view's
// items (`project.ts`), and points the spots it declares at <Spot>s: each message through `conversation.message`
// keyed by kind (the `approval` key can't be hidden), each tool result through `tool.result` keyed by tool name, and
// the add-ons under each message through `conversation.message.extra`. Where no plugin fills a key, the view draws it
// itself.
//
// The session's card events (`card_pending`, `card_resolved`) are expected in the followed stream, so a card and how it
// ended sit in the transcript in order: a question for B, since the plugin API's `approvals.watch` gives only the
// pending list.
//
// The archive draws an old session (from the app Clover replaces) through this spot too, with `archived`: then the part reads the session
// from the core's `archive.history` (the `clover` layer's call), follows nothing and answers nothing.
import { useEffect, useMemo, useState, type ComponentType, type ReactNode } from "react";
import { ConversationView, DEFAULT_RENDERERS, type MessageRenderers } from "./ConversationView";
import type { MessageSpotProps } from "./context";
import { project, type CoreEvent } from "./project";
import { Spot, useCore, usePluginApi } from "./sdk";
import type { ConversationItem, QuestionAnswer, SharedTime } from "./types";

export interface ConversationEntryProps {
  bot: { id: string; name: string };
  session: string;
  /** Opens an agent's live tab: a bot's tab opens it in the panel (the owner's item 90). */
  onOpenAgent?: (agentId: string) => void;
  onOpenFile?: (path: string) => void;
  /** The shared clock's now, for deadlines and day labels; the device's clock when absent. */
  now?: SharedTime;
  /** An old session from the archive: read once from `archive.history`, read only. */
  archived?: boolean;
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
  const archived = props.archived === true;

  useEffect(() => {
    let live = true;
    setEvents([]);
    if (archived) {
      core?.call("archive.history", { id: props.session, limit: HISTORY_PAGE }).then(
        (page) => {
          if (!live) return;
          setEvents(page.events as CoreEvent[]);
          setHasEarlier(false);
        },
        () => undefined,
      );
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

  const { names, here } = useNames(api);
  const { items, turn } = useMemo(() => project(events, { name: (kind, id) => names[`${kind}:${id}`] }), [events, names]);
  const at = { bot: props.bot, session: props.session };

  return (
    <ConversationView
      bot={props.bot}
      session={props.session}
      items={items as ConversationItem[]}
      turn={turn}
      now={props.now ?? Date.now()}
      hasEarlier={hasEarlier}
      {...(here ? { device: here } : {})}
      renderers={RENDERERS}
      renderToolResult={(call, standard): ReactNode => (
        <Spot name="tool.result" spotKey={call.name} props={{ ...at, tool: call.name, item: call, ctx: {} }} fallback={standard} />
      )}
      renderMessageExtra={(item) => <Spot name="conversation.message.extra" props={{ ...at, item, ctx: {} }} />}
      onAnswerQuestion={archived ? undefined : (callId: string, answer: QuestionAnswer) => conv?.answer?.(props.session, callId, answer.answers)}
      onOpenAgent={props.onOpenAgent}
      onOpenFile={props.onOpenFile}
      onCopy={(text) => void navigator.clipboard?.writeText(text)}
    />
  );
}

/** Display names for the bots, agents and devices a transcript mentions, by `<kind>:<id>`. */
function useNames(api: ReturnType<typeof usePluginApi>): { names: Record<string, string>; here?: { id: string; name: string } } {
  const [names, setNames] = useState<{ names: Record<string, string>; here?: { id: string; name: string } }>({ names: {} });
  useEffect(() => {
    let live = true;
    void Promise.all([
      api.bots?.list().catch(() => []) ?? [],
      api.conversation?.list?.().catch(() => []) ?? [],
      api.devices?.list().catch(() => []) ?? [],
    ]).then(([bots, sessions, devices]) => {
      if (!live) return;
      const out: Record<string, string> = {};
      for (const b of bots) out[`bot:${b.id}`] = b.name;
      for (const s of sessions) out[`agent:${s.id}`] = s.backend ?? s.title ?? s.id;
      for (const d of devices) out[`device:${d.id}`] = d.name;
      const here = devices.find((d) => d.isThis);
      setNames({ names: out, ...(here ? { here: { id: here.id, name: here.name } } : {}) });
    });
    return () => {
      live = false;
    };
  }, [api]);
  return names;
}
