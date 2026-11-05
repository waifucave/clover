// The pill's words, in locale format 1's shape (spec §5.9): keys start with `clover.`, strings use `{name}`
// placeholders, a key may hold plural forms. Until the app's `t()` exists (lane E), this is the English
// table and a stand-in lookup with the same rules.

type Entry = string | { one?: string; other: string };

export const EN: Readonly<Record<string, Entry>> = {
  "clover.pill.name": "Dispatch pill",
  "clover.pill.label": "Message {name}",
  "clover.pill.placeholder": "Message {name}",
  "clover.pill.working": "{name} is working",
  "clover.pill.send": "Send",
  "clover.pill.stop": "Stop",
  "clover.pill.stopping": "Stopping…",
  "clover.pill.voice": "Voice",
  "clover.pill.more": "More",
  "clover.pill.fullScreen": "Full screen",
  "clover.pill.openInApp": "Open {name} in Clover",
  "clover.pill.clearDraft": "Clear draft",
  "clover.pill.target": "Choose who to message",
  "clover.pill.targets": "Message someone else",
  "clover.pill.asks": "{name} asks",
  "clover.pill.aQuestion": "A question for you",
  "clover.pill.chooseAny": "Choose any",
  "clover.pill.typeAnswer": "Type an answer",
  "clover.pill.somethingElse": "Something else",
  "clover.pill.next": "Next",
  "clover.pill.back": "Back",
  "clover.pill.sending": "Sending…",
  "clover.pill.childStop": "Stop {name}",
  "clover.pill.childOpen": "Open {name}",
  "clover.pill.childMore": { one: "1 more agent", other: "{count} more agents" },
  "clover.pill.untitled": "Agent",
  "clover.pill.leavePreview": "Back to the message box",
  "clover.pill.turn": "Turn {position}",
  "clover.pill.notSent": "That answer didn't go through. Try again.",
  "clover.pill.update": "An update from your bot",
};

export function t(key: string, vars: Record<string, string | number> = {}): string {
  const entry = EN[key];
  if (entry === undefined) return key;
  const text = typeof entry === "string" ? entry : vars.count === 1 && entry.one !== undefined ? entry.one : entry.other;
  return text.replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? `{${name}}`));
}
