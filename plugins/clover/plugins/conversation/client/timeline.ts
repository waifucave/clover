// Items become display units: consecutive tool calls fold into one run, a day divider opens each new
// day, and the bot's last word in a stretch is marked so it alone carries the copy button. Pure.
import { dayKey, dayLabel } from "./format";
import type { BotItem, ConversationFormat, ConversationItem, SharedTime, ThinkingItem, ToolCall } from "./types";

export type MessageItem = Exclude<ConversationItem, { kind: "tool" } | { kind: "thinking" }>;

export type Unit =
  | { type: "day"; key: string; label: string }
  | { type: "tools"; key: string; at: SharedTime; calls: ToolCall[] }
  | { type: "thinking"; key: string; item: ThinkingItem }
  | { type: "message"; key: string; item: MessageItem; final?: boolean };

/** What follows a bot message inside the same stretch of work, so it is not the last word. */
const CONTINUES_WORK = new Set(["tools", "thinking"]);
const CONTINUES_KINDS = new Set(["bot", "approval", "question"]);

function continuesWork(unit: Unit | undefined): boolean {
  if (!unit) return false;
  if (CONTINUES_WORK.has(unit.type)) return true;
  return unit.type === "message" && CONTINUES_KINDS.has(unit.item.kind);
}

export function buildTimeline(items: readonly ConversationItem[], now: SharedTime, format: ConversationFormat = {}): Unit[] {
  const units: Unit[] = [];
  // Days only move forward: a late arrival from yesterday, placed after today's answer (spec §6.4),
  // stays under today's divider rather than reopening yesterday's, so no day shows twice.
  let day: string | undefined;
  for (const item of items) {
    const key = dayKey(item.at, format);
    if (day === undefined || key > day) {
      day = key;
      units.push({ type: "day", key: `day:${key}`, label: dayLabel(item.at, now, format) });
    }
    if (item.kind === "tool") {
      const last = units[units.length - 1];
      if (last?.type === "tools") last.calls.push(item.call);
      else units.push({ type: "tools", key: `tools:${item.id}`, at: item.at, calls: [item.call] });
      continue;
    }
    if (item.kind === "thinking") {
      units.push({ type: "thinking", key: item.id, item });
      continue;
    }
    units.push({ type: "message", key: item.id, item });
  }
  // The bot's last word: a finished bot message nothing in its stretch of work follows (a day
  // divider is not work).
  for (let i = 0; i < units.length; i++) {
    const unit = units[i];
    if (unit?.type !== "message" || unit.item.kind !== "bot" || (unit.item as BotItem).streaming) continue;
    let j = i + 1;
    while (units[j]?.type === "day") j++;
    unit.final = !continuesWork(units[j]);
  }
  return units;
}

/** The streaming bot message, if any: the one whose text grows between renders. */
export function streamingText(items: readonly ConversationItem[]): string | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item?.kind === "bot" && item.streaming) return item.text;
  }
  return undefined;
}
