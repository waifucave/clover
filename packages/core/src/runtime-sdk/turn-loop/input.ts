// How each kind of input reads to the model (spec §6.4, §7, §9.3). Owner: lane A.
//
// The user's own message is the text they wrote, with its attachments named. Everything else is labelled with where
// it came from, so the model never takes another bot's, an agent's, a routine's or a plugin's words for the user's:
// a message from another bot or an agent, a background agent's task notification (its final report unchanged, its
// stop reason and transcript), a routine's result posted into the bot's conversation or the instructions that start a
// side thread, a plugin's message and a note.
import type { TurnInput } from "../../contracts/session-host";

function attr(value: string): string {
  return value.replace(/[&"<>]/g, (c) => ({ "&": "&amp;", "\"": "&quot;", "<": "&lt;", ">": "&gt;" })[c]!);
}

/** The body can't close its own wrapper: `</tag` inside becomes `‹/tag`. */
function body(tag: string, text: string): string {
  return text.replace(new RegExp(`<(/?)${tag}\\b`, "gi"), "‹$1" + tag);
}

function wrap(tag: string, attrs: Record<string, string | undefined>, text: string): string {
  const a = Object.entries(attrs).filter((e): e is [string, string] => e[1] !== undefined).map(([k, v]) => ` ${k}="${attr(v)}"`).join("");
  return `<${tag}${a}>\n${body(tag, text)}\n</${tag}>`;
}

export function formatTurnInput(input: TurnInput, kind: "bot" | "side-thread"): string {
  switch (input.from) {
    case "user": {
      const parts = [input.text];
      for (const img of input.images ?? []) parts.push(`[Image #${img.n}: ${img.path}]`);
      for (const f of input.files ?? []) parts.push(`[File #${f.n}: ${f.path}]`);
      return parts.filter((p) => p.length > 0).join("\n");
    }
    case "bot":
      return wrap("message", { "from-bot": input.bot, session: input.session }, input.text);
    case "agent":
      return wrap("message", { "from-agent": input.agent }, input.text);
    case "task-notification":
      return wrap("task-notification", {
        agent: input.agent, backend: input.backend, "stop-reason": input.stopReason, transcript: input.transcript,
        ...(input.usage === undefined ? {} : { tokens: `${input.usage.inputTokens} in, ${input.usage.outputTokens} out` }),
      }, input.text);
    case "routine":
      return kind === "side-thread"
        ? wrap("routine", { name: input.name, id: input.routine }, input.text)
        : wrap("routine-result", { name: input.name, id: input.routine, "side-thread": input.sideThread }, input.text);
    case "plugin":
      return wrap("message", { "from-plugin": input.pluginId, ...(input.app === undefined ? {} : { app: "true" }) }, input.text);
    case "note":
      return wrap("note", {
        label: input.label,
        from: input.by.kind === "core" ? "clover" : input.by.kind === "hook" ? `${input.by.pluginId} (${input.by.hook})` : input.by.pluginId,
      }, input.text);
  }
}
