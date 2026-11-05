// The desktop notifications' words, in English: the keys a translation pack (`locales`) overrides. Never a message's,
// a card's or a question's text: the core does not hand a notifier any.

type Entry = string | { one?: string; other: string };

const EN: Record<string, Entry> = {
  "clover.notifications.aBot": "A bot",
  "clover.notifications.fallbackTitle": "Clover",
  "clover.notifications.message": { one: "Sent you a message", other: "Sent you {count} messages" },
  "clover.notifications.card": { one: "Needs your OK", other: "Needs your OK on {count} things" },
  "clover.notifications.question": { one: "Has a question for you", other: "Has {count} questions for you" },
  "clover.notifications.routine": { one: "A routine finished", other: "{count} routines finished" },
  "clover.notifications.agent": { one: "An agent finished", other: "{count} agents finished" },
};

export function t(key: string, vars: Record<string, string | number> = {}): string {
  const entry = EN[key];
  if (entry === undefined) return key;
  const text = typeof entry === "string" ? entry : vars.count === 1 && entry.one !== undefined ? entry.one : entry.other;
  return text.replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? `{${name}}`));
}
