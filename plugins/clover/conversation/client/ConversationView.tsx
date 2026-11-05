// The bot's one continuous conversation (spec §6.3): every message kind in the order the computer
// running the bot placed it, the answer streaming in, thinking titles, and the turn's own status.
//
// Each message draws through a renderer keyed like the `conversation.message` spot (spec §5.5), each
// tool result through `renderToolResult` (the `tool.result` spot) and the add-ons under a message
// through `renderMessageExtra` (`conversation.message.extra`). In M2 those three become <Spot>s;
// nothing else here changes.
//
// Nothing in this view may overlap the conversation's own content: an approval card's sealed buttons
// count a click only while nothing covers them (spec §5.5), so the "Jump to latest" pill lives in a
// strip below the scrolling area rather than over it.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
import type { MessageContext } from "./context";
import { afterContentChange, isAtBottom } from "./follow";
import { IconArrowDown, IconClover } from "./icons";
import { AgentReport } from "./messages/AgentReport";
import { ApprovalMessage } from "./messages/ApprovalMessage";
import { BotMessage } from "./messages/BotMessage";
import { NoteMessage } from "./messages/NoteMessage";
import { QuestionMessage } from "./messages/QuestionMessage";
import { RoutineResult } from "./messages/RoutineResult";
import { TaskNotification } from "./messages/TaskNotification";
import { ThinkingRow } from "./messages/ThinkingRow";
import { ToolRun, type ToolRunProps } from "./messages/ToolRun";
import { UserMessage } from "./messages/UserMessage";
import { S } from "./strings";
import { buildTimeline, streamingText, type MessageItem, type Unit } from "./timeline";
import type {
  AgentReportItem,
  ApprovalItem,
  BotItem,
  ConversationActions,
  ConversationFormat,
  ConversationItem,
  NoteItem,
  QuestionItem,
  RoutineResultItem,
  SharedTime,
  TaskNotificationItem,
  DeviceRef,
  ToolCall,
  TurnState,
  UserItem,
} from "./types";

type Renderer<T> = ComponentType<{ item: T; ctx: MessageContext }>;

/** One renderer per `conversation.message` key. */
export interface MessageRenderers {
  user: Renderer<UserItem>;
  bot: ComponentType<{ item: BotItem; ctx: MessageContext; final?: boolean }>;
  tool: ComponentType<ToolRunProps>;
  approval: Renderer<ApprovalItem>;
  question: Renderer<QuestionItem>;
  "routine-result": Renderer<RoutineResultItem>;
  "task-notification": Renderer<TaskNotificationItem>;
  "agent-report": Renderer<AgentReportItem>;
  note: Renderer<NoteItem>;
}

export const DEFAULT_RENDERERS: MessageRenderers = {
  user: UserMessage,
  bot: BotMessage,
  tool: ToolRun,
  approval: ApprovalMessage,
  question: QuestionMessage,
  "routine-result": RoutineResult,
  "task-notification": TaskNotification,
  "agent-report": AgentReport,
  note: NoteMessage,
};

export interface ConversationViewProps extends ConversationActions {
  bot: { id: string; name: string };
  items: readonly ConversationItem[];
  turn?: TurnState;
  /** The shared clock's now, for deadlines and day labels. */
  now?: SharedTime;
  /** The session this conversation is. */
  session?: string;
  /** Files dropped on the conversation, for the host to attach. Without it, a drop does nothing. */
  onDropFiles?: (files: File[]) => void;
  /** The device this view is on. */
  device?: DeviceRef;
  format?: ConversationFormat;
  /** Older items exist beyond what the host has handed over. */
  hasEarlier?: boolean;
  onLoadEarlier?: () => void;
  renderers?: Partial<MessageRenderers>;
  renderToolResult?: (call: ToolCall) => ReactNode | undefined;
  renderMessageExtra?: (item: MessageItem) => ReactNode;
  /** Start at the bottom, following new output (the default), or at the top. */
  initialFollow?: boolean;
  /** Tool items whose runs start open, by item id. */
  initialExpanded?: readonly string[];
}

/** The turn's status line, or nothing when the turn is idle or its last unit already shows that it
 *  is live (a streaming answer, a live thinking row). */
export function workingText(turn: TurnState | undefined, botName: string, last: Unit | undefined): string | undefined {
  if (!turn?.running) return undefined;
  switch (turn.phase) {
    case "compacting":
      return S.turnCompacting;
    case "retrying":
      return turn.retry ? S.turnRetrying(turn.retry.attempt, turn.retry.maxRetries) : S.turnWorking(botName);
    case "waiting":
      return S.turnWaiting(botName);
  }
  if (last?.type === "message" && last.item.kind === "bot" && last.item.streaming) return undefined;
  if (last?.type === "thinking" && last.item.live) return undefined;
  return turn.phase === "working" ? S.turnWorking(botName) : S.turnThinking(botName);
}

function MessageUnit({
  unit,
  renderers,
  ctx,
  expanded,
  onToggle,
  renderToolResult,
}: {
  unit: Exclude<Unit, { type: "day" }>;
  renderers: MessageRenderers;
  ctx: MessageContext;
  expanded: boolean;
  onToggle: () => void;
  renderToolResult?: (call: ToolCall) => ReactNode | undefined;
}) {
  if (unit.type === "tools") {
    const Tool = renderers.tool;
    return <Tool calls={unit.calls} ctx={ctx} expanded={expanded} onToggle={onToggle} renderResult={renderToolResult} />;
  }
  if (unit.type === "thinking") return <ThinkingRow item={unit.item} ctx={ctx} />;
  const item = unit.item;
  switch (item.kind) {
    case "user": {
      const R = renderers.user;
      return <R item={item} ctx={ctx} />;
    }
    case "bot": {
      const R = renderers.bot;
      return <R item={item} ctx={ctx} final={unit.final} />;
    }
    case "approval": {
      const R = renderers.approval;
      return <R item={item} ctx={ctx} />;
    }
    case "question": {
      const R = renderers.question;
      return <R item={item} ctx={ctx} />;
    }
    case "routine-result": {
      const R = renderers["routine-result"];
      return <R item={item} ctx={ctx} />;
    }
    case "task-notification": {
      const R = renderers["task-notification"];
      return <R item={item} ctx={ctx} />;
    }
    case "agent-report": {
      const R = renderers["agent-report"];
      return <R item={item} ctx={ctx} />;
    }
    case "note": {
      const R = renderers.note;
      return <R item={item} ctx={ctx} />;
    }
  }
}

export function ConversationView(props: ConversationViewProps) {
  const {
    bot,
    items,
    turn,
    device,
    hasEarlier,
    onLoadEarlier,
    renderToolResult,
    renderMessageExtra,
    initialFollow = true,
    initialExpanded,
    onAnswerQuestion,
    onOpenLink,
    onOpenFile,
    onOpenDiff,
    onOpenThread,
    onOpenAgent,
    onCopy,
  } = props;
  // The clock the view was opened at, when the host passes none: never a new one per render.
  const [openedAt] = useState(() => Date.now());
  const now = props.now ?? openedAt;
  const format = props.format ?? {};
  const renderers = useMemo(() => ({ ...DEFAULT_RENDERERS, ...props.renderers }), [props.renderers]);
  const units = useMemo(() => buildTimeline(items, now, format), [items, now, format.locale, format.timeZone]);
  const actions = useMemo<ConversationActions>(
    () => ({ onAnswerQuestion, onOpenLink, onOpenFile, onOpenDiff, onOpenThread, onOpenAgent, onCopy }),
    [onAnswerQuestion, onOpenLink, onOpenFile, onOpenDiff, onOpenThread, onOpenAgent, onCopy],
  );
  const ctx = useMemo<MessageContext>(
    () => ({ botName: bot.name, session: props.session ?? "", now, format, device, turnLive: turn?.running === true, actions }),
    [bot.name, props.session, now, format.locale, format.timeZone, device?.id, device?.name, turn?.running, actions],
  );

  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set((initialExpanded ?? []).map((id) => `tools:${id}`)));
  const toggle = useCallback((key: string) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // Follow the bottom while the reader is there; otherwise keep their place and offer the way back.
  const viewport = useRef<HTMLDivElement>(null);
  const following = useRef(initialFollow);
  const [showJump, setShowJump] = useState(false);
  const growth = `${items.length}:${streamingText(items)?.length ?? -1}:${turn?.running ? turn.phase ?? "on" : "off"}`;
  useLayoutEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const next = afterContentChange(following.current, el);
    if (next.scrollToBottom) el.scrollTop = el.scrollHeight;
    setShowJump(next.showJump);
  }, [growth]);
  // Content can also grow inside an item already drawn (a code block's last line, a tool run opening, an
  // app page sizing itself): while following, any growth of the column keeps the bottom in view.
  const column = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = viewport.current;
    const inner = column.current;
    if (!el || !inner || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (following.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(inner);
    return () => observer.disconnect();
  }, []);
  const onScroll = () => {
    const el = viewport.current;
    if (!el) return;
    following.current = isAtBottom(el);
    if (following.current) setShowJump(false);
  };
  const jump = () => {
    const el = viewport.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    following.current = true;
    setShowJump(false);
  };

  const status = workingText(turn, bot.name, units[units.length - 1]);
  return (
    <div
      className="cl-conv"
      data-turn={turn?.running ? turn.phase ?? "running" : undefined}
      onDragOver={(e) => {
        // A file dropped here is the host's to take (as an attachment), never the page's to open.
        if (Array.from(e.dataTransfer?.types ?? []).includes("Files")) e.preventDefault();
      }}
      onDrop={(e) => {
        e.preventDefault();
        const files = Array.from(e.dataTransfer?.files ?? []);
        if (files.length > 0) props.onDropFiles?.(files);
      }}
    >
      <div className="cl-conv__viewport" ref={viewport} onScroll={onScroll} role="log" aria-label={S.conversationLabel(bot.name)} tabIndex={0}>
        <div className="cl-conv__column" ref={column}>
          {hasEarlier && onLoadEarlier && (
            <button type="button" className="cl-conv__earlier" onClick={onLoadEarlier}>
              {S.showEarlier}
            </button>
          )}
          {units.length === 0 && <div className="cl-conv__empty">{S.empty(bot.name)}</div>}
          {units.map((unit) =>
            unit.type === "day" ? (
              <div key={unit.key} className="cl-conv-day" role="separator" aria-label={unit.label}>
                <span className="cl-conv-day__label">{unit.label}</span>
              </div>
            ) : (
              <div key={unit.key} className="cl-conv__unit" data-unit={unit.type === "message" ? unit.item.kind : unit.type}>
                <MessageUnit
                  unit={unit}
                  renderers={renderers}
                  ctx={ctx}
                  expanded={open.has(unit.key)}
                  onToggle={() => toggle(unit.key)}
                  renderToolResult={renderToolResult}
                />
                {unit.type === "message" && renderMessageExtra && <div className="cl-conv__extra">{renderMessageExtra(unit.item)}</div>}
              </div>
            ),
          )}
          {status && (
            <div className="cl-conv-working" data-phase={turn?.phase ?? "thinking"}>
              <span className="cl-conv-working__glyph" aria-hidden="true">
                <IconClover />
              </span>
              <span className="cl-conv-working__text">{status}</span>
            </div>
          )}
        </div>
      </div>
      <div className="cl-conv__footer">
        {/* The turn's state for screen readers: outside the log, so the log only ever gains messages. */}
        <span className="cl-conv__announce" role="status">
          {status ?? ""}
        </span>
        {showJump && (
          <button type="button" className="cl-conv__jump" onClick={jump}>
            <IconArrowDown />
            {S.jumpToLatest}
          </button>
        )}
      </div>
    </div>
  );
}
