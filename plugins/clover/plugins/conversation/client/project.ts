// The core's session events as the view's items, so the view never reads the core's shapes directly. The events are
// lane B's (on `lane/b-m0`):
// - the inherited stream (`packages/protocol/src/events.ts`): user_message, turn_started, assistant_delta and
//   assistant_message, thinking_delta and thinking_block, tool_call and tool_result, question_asked and
//   question_resolved, turn_completed, session_titled; and approval_requested and approval_resolved, which only old
//   sessions from the app Clover replaces hold (the archive), drawn as notes since no sealed card exists for them;
// - Clover's session events (`sessions.ts`): bot_message, agent_message, agent_finished, routine_result, note,
//   plugin_message;
// - the cards (`approvals.ts`): card_pending and card_resolved, for this session's cards. A card carries no text; the
//   view places its sealed frames.
// Events the view doesn't know are skipped, as the inherited clients do.
import type {
  ApprovalItem, ApprovalState, ConversationItem, NoteItem, Question, QuestionItem, ReasoningKind, ThinkingItem, ToolCall, ToolItem, TurnState,
} from "./types";

export type CoreEvent = Record<string, unknown>;

export interface Projection {
  items: ConversationItem[];
  turn: TurnState;
  /** The session's title, once the core gave it one. */
  title?: string;
}

export interface ProjectOptions {
  /** A display name for a bot, an agent or a plugin by id; the id when absent. */
  name?: (kind: "bot" | "agent" | "plugin" | "device", id: string) => string | undefined;
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

/** A tool call's one-line hint, from its arguments: a command's first line, a path, a URL or a query. */
export function toolHint(argsJson: string | undefined): string | undefined {
  if (!argsJson) return undefined;
  let args: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(argsJson);
    if (!parsed || typeof parsed !== "object") return undefined;
    args = parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
  for (const k of ["command", "file_path", "path", "url", "query", "pattern", "description", "prompt"]) {
    const v = str(args[k]);
    if (v) return v.split("\n")[0]!.slice(0, 200);
  }
  return undefined;
}

const OUTCOME: Record<string, ApprovalState> = { approved: "approved", denied: "denied", expired: "expired", withdrawn: "withdrawn", cancelled: "cancelled" };

/** Projects a session's events, oldest first, into the view's items and the turn's state. */
export function project(events: readonly CoreEvent[], options: ProjectOptions = {}): Projection {
  const name = (kind: "bot" | "agent" | "plugin" | "device", id: string) => options.name?.(kind, id) ?? id;
  const items: ConversationItem[] = [];
  const byId = new Map<string, ConversationItem>();
  const add = <T extends ConversationItem>(item: T): T => {
    items.push(item);
    byId.set(item.id, item);
    return item;
  };
  let turn: TurnState = { running: false };
  let title: string | undefined;
  let streaming: string | undefined;
  let streams = 0;

  for (const e of events) {
    const type = str(e.type);
    const at = num(e.ts) ?? num(e.at) ?? 0;
    const seq = num(e.seq);
    const key = seq !== undefined ? String(seq) : `${at}-${items.length}`;
    switch (type) {
      case "user_message": {
        const text = str(e.text) ?? "";
        const images = Array.isArray(e.images) ? (e.images as { n: number; path: string }[]) : [];
        const files = Array.isArray(e.files) ? (e.files as { n: number; path: string }[]) : [];
        const attachments = [
          ...images.map((i) => ({ n: i.n, kind: "image" as const, name: baseName(i.path), path: i.path })),
          ...files.map((f) => ({ n: f.n, kind: "file" as const, name: baseName(f.path), path: f.path })),
        ];
        const device = str(e.device) ?? str(e.clientName);
        add({ id: `u${key}`, kind: "user", at, text, ...(attachments.length ? { attachments } : {}), ...(device ? { device: { id: device, name: name("device", device) } } : {}) });
        break;
      }
      case "turn_started":
        turn = { running: true, phase: "thinking" };
        break;
      case "assistant_delta": {
        const delta = str(e.delta) ?? "";
        const open = streaming ? byId.get(streaming) : undefined;
        if (open && open.kind === "bot") open.text += delta;
        else streaming = add({ id: `s${++streams}`, kind: "bot", at, text: delta, streaming: true }).id;
        turn = { running: true, phase: "working" };
        break;
      }
      case "assistant_message": {
        const text = str(e.text) ?? "";
        const open = streaming ? byId.get(streaming) : undefined;
        if (open && open.kind === "bot") {
          open.text = text;
          delete open.streaming;
        } else if (text) add({ id: `m${key}`, kind: "bot", at, text });
        streaming = undefined;
        break;
      }
      case "thinking_delta":
      case "thinking_block": {
        const block = str(e.blockId) ?? key;
        const id = `t${block}`;
        const existing = byId.get(id);
        const live = type === "thinking_delta";
        const item: ThinkingItem = existing && existing.kind === "thinking" ? existing : add<ThinkingItem>({ id, kind: "thinking", at, live, reasoning: (str(e.kind) ?? "summary") as ReasoningKind });
        item.live = live;
        const t = str(e.title);
        if (t) item.title = t;
        if (!live) {
          item.text = str(e.text) ?? "";
          const d = num(e.durationMs);
          if (d !== undefined) item.durationMs = d;
          if (e.truncated === true) item.truncated = true;
        }
        break;
      }
      case "tool_call": {
        const callId = str(e.callId) ?? key;
        const call: ToolCall = { callId, name: str(e.name) ?? "tool", status: "running" };
        const hint = toolHint(str(e.argsJson));
        if (hint) call.detail = hint;
        const computer = str(e.computer);
        if (computer) call.computer = computer;
        add<ToolItem>({ id: `c${callId}`, kind: "tool", at, call });
        turn = { running: true, phase: "working" };
        break;
      }
      case "tool_result": {
        const item = byId.get(`c${str(e.callId)}`);
        if (item?.kind !== "tool") break;
        item.call.status = e.isError === true ? "failed" : "succeeded";
        item.call.output = str(e.output) ?? "";
        const diff = e.fileDiff as { path?: string; added?: number; removed?: number; diffId?: string } | undefined;
        if (diff?.path && diff.diffId) item.call.diff = { path: diff.path, added: diff.added ?? 0, removed: diff.removed ?? 0, diffId: diff.diffId };
        const icons = e.siteIcons as { url: string; icon?: string }[] | undefined;
        if (Array.isArray(icons)) item.call.sites = icons.map((s) => ({ url: s.url, ...(s.icon ? { icon: s.icon } : {}) }));
        break;
      }
      case "card_pending":
      case "card_requested": {
        const card = e.card as { id: string; kind?: ApprovalItem["cardKind"]; computer?: string | null; options?: ApprovalItem["options"]; pluginId?: string; expiresAt?: number | null; issuedAt?: number } | undefined;
        if (!card?.id || byId.has(`a${card.id}`)) break;
        add<ApprovalItem>({
          id: `a${card.id}`, kind: "approval", at: card.issuedAt ?? at, cardId: card.id, state: "pending",
          ...(card.kind ? { cardKind: card.kind } : {}),
          ...(card.options?.length ? { options: card.options.map((o) => ({ id: o.id, kind: o.kind, ...(o.remember ? { remember: o.remember } : {}) })) } : {}),
          ...(card.computer ? { computer: card.computer } : {}),
          ...(card.pluginId ? { pluginId: card.pluginId } : {}),
          ...(card.expiresAt ? { expiresAt: card.expiresAt } : {}),
        });
        for (const it of items) if (it.kind === "tool" && it.call.status === "running") it.call.status = "waiting";
        turn = { running: true, phase: "waiting" };
        break;
      }
      case "card_resolved": {
        const item = byId.get(`a${str(e.id)}`);
        if (item?.kind !== "approval") break;
        item.state = OUTCOME[str(e.outcome) ?? ""] ?? "withdrawn";
        const device = str(e.device);
        if (device) item.answeredOn = name("device", device);
        for (const it of items) if (it.kind === "tool" && it.call.status === "waiting") it.call.status = item.state === "approved" ? "running" : "interrupted";
        if (turn.phase === "waiting") turn = { running: turn.running, phase: "working" };
        break;
      }
      case "approval_requested":
      case "approval_resolved": {
        // Only an old session from the app Clover replaces holds these (the archive): no sealed card exists for them, so they read as notes.
        const tool = str(e.toolName);
        const text = type === "approval_requested" ? `Asked to use ${tool ?? "a tool"}${str(e.summary) ? `: ${str(e.summary)}` : ""}` : e.approved === true ? "Allowed" : "Denied";
        add<NoteItem>({ id: `n${key}`, kind: "note", at, text, tone: "info" });
        break;
      }
      case "question_asked": {
        const callId = str(e.callId) ?? key;
        const questions = (Array.isArray(e.questions) ? e.questions : []) as Record<string, unknown>[];
        add<QuestionItem>({
          id: `q${callId}`, kind: "question", at, callId, state: "pending",
          questions: questions.map((q): Question => ({
            question: str(q.question) ?? "",
            ...(str(q.header) ? { header: str(q.header)! } : {}),
            options: (Array.isArray(q.options) ? (q.options as Record<string, unknown>[]) : []).map((o) => ({
              label: str(o.label) ?? "",
              ...(str(o.description) ? { description: str(o.description)! } : {}),
              ...(str(o.preview) ? { preview: str(o.preview)! } : {}),
            })),
            multiSelect: q.multiSelect === true,
          })),
        });
        turn = { running: true, phase: "waiting" };
        break;
      }
      case "question_resolved": {
        const item = byId.get(`q${str(e.callId)}`);
        if (item?.kind !== "question") break;
        item.state = "answered";
        if (e.answers && typeof e.answers === "object") item.answers = e.answers as Record<string, string>;
        if (e.notes && typeof e.notes === "object") item.notes = e.notes as Record<string, string>;
        if (turn.phase === "waiting") turn = { running: true, phase: "working" };
        break;
      }
      case "turn_completed": {
        const open = streaming ? byId.get(streaming) : undefined;
        if (open && open.kind === "bot") {
          delete open.streaming;
          if (e.stopReason === "aborted") open.interrupted = true;
        }
        streaming = undefined;
        for (const it of items) if (it.kind === "tool" && (it.call.status === "running" || it.call.status === "waiting")) it.call.status = "interrupted";
        if (e.stopReason === "error") add<NoteItem>({ id: `n${key}`, kind: "note", at, text: "The turn ended with an error.", tone: "error" });
        turn = { running: false };
        break;
      }
      case "session_titled":
        title = str(e.title) ?? title;
        break;
      case "bot_message": {
        const from = str(e.from) ?? "bot";
        add({ id: `r${key}`, kind: "agent-report", at, from: { kind: "bot", id: from, name: name("bot", from) }, text: str(e.text) ?? "", folded: turn.running });
        break;
      }
      case "agent_message": {
        const agent = str(e.agent) ?? "agent";
        add({ id: `r${key}`, kind: "agent-report", at, from: { kind: "agent", id: agent, name: name("agent", agent) }, text: str(e.text) ?? "", folded: turn.running });
        break;
      }
      case "plugin_message": {
        const from = e.from as { pluginId?: string } | undefined;
        const id = from?.pluginId ?? "plugin";
        const app = e.app as { callId?: string } | undefined;
        add({ id: `r${key}`, kind: "agent-report", at, from: { kind: "plugin", id, name: name("plugin", id) }, text: str(e.text) ?? "", ...(app?.callId ? { app: { callId: app.callId } } : {}) });
        break;
      }
      case "agent_finished": {
        const agent = str(e.agent) ?? "agent";
        const backend = str(e.backend);
        const reason = str(e.stopReason);
        add({
          id: `f${key}`, kind: "task-notification", at,
          task: { kind: "agent", agentId: agent, name: name("agent", agent), ...(backend ? { backend } : {}) },
          status: reason === "aborted" ? "stopped" : reason === "error" ? "failed" : reason === "stalled" ? "stalled" : "completed",
          ...(str(e.text) ? { report: str(e.text)! } : {}),
          ...(str(e.transcript) ? { transcriptPath: str(e.transcript)! } : {}),
        });
        break;
      }
      case "routine_result": {
        const routine = str(e.routine) ?? "routine";
        add({
          id: `o${key}`, kind: "routine-result", at,
          routine: { id: routine, name: str(e.name) ?? routine, computer: str(e.computer) ?? "" },
          status: e.failed === true ? "failed" : "succeeded",
          summary: str(e.text) ?? "",
          threadId: str(e.sideThread) ?? "",
        });
        break;
      }
      case "note": {
        const from = e.from as { kind?: string; pluginId?: string } | undefined;
        const label = str(e.label);
        const text = str(e.text) ?? "";
        add<NoteItem>({
          id: `n${key}`, kind: "note", at, text: label ? `${label}: ${text}` : text,
          ...(from?.kind === "plugin" && from.pluginId ? { from: { kind: "plugin" as const, id: from.pluginId, name: name("plugin", from.pluginId) } } : {}),
        });
        break;
      }
      default:
        break;
    }
  }
  return { items, turn, ...(title ? { title } : {}) };
}
