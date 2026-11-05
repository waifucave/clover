// A pinned turn — a reply that just arrived, or one swiped to — as the pill shows it alone: its prompt cut
// to one line, its WHOLE reply read as plain words where that is safe, and where it sits ("3/7"). Ported
// from Winter's `dispatchPillTurnPreview` and `dispatchPillReplyText`. Pure.

import { t } from "../strings";

export interface Exchange {
  prompt: string;
  reply: string;
  aborted?: boolean;
}

export interface TurnPreview {
  prompt: string;
  reply: string;
  position: string;
}

/** The prompt line of a turn the user did not start: the bot reporting on its own. */
export const UPDATE_LABEL = t("clover.pill.update");
export const PROMPT_LIMIT = 90;

export function shortened(text: string, limit: number): string {
  const collapsed = text.split(/\s+/).filter(Boolean).join(" ");
  if (collapsed.length <= limit || limit <= 1) return collapsed;
  return collapsed.slice(0, limit - 1).trimEnd() + "…";
}

export function turnPreview(exchanges: readonly Exchange[], index: number, replyText: (s: string) => string = plainReply): TurnPreview | null {
  const exchange = exchanges[index];
  if (!exchange) return null;
  const prompt = shortened(exchange.prompt, PROMPT_LIMIT);
  const reply = replyText(exchange.reply);
  return {
    prompt: prompt.length === 0 ? UPDATE_LABEL : prompt,
    reply: reply.length === 0 ? (exchange.aborted ? "stopped" : "no reply yet") : reply,
    position: `${index + 1}/${exchanges.length}`,
  };
}

const isFence = (trimmed: string) => trimmed.startsWith("```") || trimmed.startsWith("~~~");

/**
 * The reply as plain words: a fenced code block kept verbatim (only its fences dropped), a paragraph that
 * looks like a diff kept verbatim, otherwise heading marks (only before a space), a quote's `> `, `- `/`* `
 * bullets drawn as "•" and balanced `**` pairs outside inline code dropped; blank runs fold to one.
 */
export function plainReply(reply: string): string {
  const raw = reply.split(/\r?\n/);
  const verbatim = new Set<number>();
  let fenced = false;
  let paragraph: number[] = [];
  const close = () => {
    const diff = paragraph.some((i) => {
      const t = raw[i]!.trim();
      return t.startsWith("+") || t.startsWith("@@") || t.startsWith("---");
    });
    if (diff) for (const i of paragraph) verbatim.add(i);
    paragraph = [];
  };
  raw.forEach((line, i) => {
    const t = line.trim();
    if (isFence(t)) {
      close();
      fenced = !fenced;
      return;
    }
    if (fenced) return;
    if (t.length === 0) close();
    else paragraph.push(i);
  });
  close();

  const lines: string[] = [];
  fenced = false;
  raw.forEach((line, i) => {
    const trimmed = line.trim();
    if (isFence(trimmed)) {
      fenced = !fenced;
      return;
    }
    if (fenced || verbatim.has(i)) {
      lines.push(line.replace(/[ \t]+$/, ""));
      return;
    }
    if (trimmed.length === 0) {
      if (lines.length > 0 && lines[lines.length - 1] !== "") lines.push("");
      return;
    }
    lines.push(plainLine(line));
  });
  while (lines[lines.length - 1] === "") lines.pop();
  while (lines[0] === "") lines.shift();
  return lines.join("\n");
}

function plainLine(raw: string): string {
  const indent = (/^[ \t]*/.exec(raw)?.[0] ?? "").slice(0, 6).replace(/\t/g, "  ");
  let s = raw.trim();
  const hashes = /^#+/.exec(s)?.[0].length ?? 0;
  if (hashes >= 1 && hashes <= 6 && s[hashes] === " ") s = s.slice(hashes + 1);
  else if (s.startsWith("> ")) s = s.slice(2);
  else if (s === ">") s = "";
  let bullet = false;
  if (s.startsWith("- ") || s.startsWith("* ")) {
    s = s.slice(2);
    bullet = true;
  }
  const words = stripBold(s.trim());
  return bullet ? `${indent}• ${words}` : words;
}

/** `**bold**` pairs to their words, outside inline code only. */
export function stripBold(line: string): string {
  const segments = line.split("`");
  if (segments.length === 1 && !line.includes("**")) return line;
  const codeClosed = segments.length % 2 === 1;
  return segments
    .map((segment, i) => {
      const isCode = i % 2 === 1 && (codeClosed || i < segments.length - 1);
      return isCode ? segment : segment.replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, "$1");
    })
    .join("`");
}
