// The desktop notifications' words, in English: the keys a translation pack (`locales`) overrides. Never a message's,
// a card's or a question's text: the core does not hand a notifier any.

type Entry = string | { one?: string; other: string };

const EN: Record<string, Entry> = {
  "clover.notifications.aBot": "A bot",
  "clover.notifications.fallbackTitle": "Clover",
  "clover.notifications.aPlugin": "A plugin",
  "clover.notifications.fromPlugin": "{plugin}: {title}",
  "clover.notifications.message": "Sent you a message",
  "clover.notifications.card": "Needs your OK",
  "clover.notifications.question": "Has a question for you",
  "clover.notifications.routine": "A routine finished",
  "clover.notifications.agent": "An agent finished",
  "clover.notifications.unseen": { one: "1 unseen", other: "{count} unseen" },
};

export function t(key: string, vars: Record<string, string | number> = {}): string {
  const entry = EN[key];
  if (entry === undefined) return key;
  const text = typeof entry === "string" ? entry : vars.count === 1 && entry.one !== undefined ? entry.one : entry.other;
  return text.replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? `{${name}}`));
}
