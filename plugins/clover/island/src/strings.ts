// The island's words, in locale format 1's shape (spec §5.9): keys start with `clover.`, strings use
// `{name}` placeholders, and a key may hold plural forms. Until the app's `t()` exists (lane E), this is
// the English table and a stand-in lookup with the same rules.

type Entry = string | { one?: string; other: string };

export const EN: Readonly<Record<string, Entry>> = {
  "clover.island.label": "Clover island.",
  "clover.island.nothingNeedsYou": "Nothing needs you",
  "clover.island.needsYouCount": { one: "1 thing needs you.", other: "{count} things need you." },
  "clover.island.workingCount": { one: "1 bot working.", other: "{count} bots working." },
  "clover.island.needsYou": "Needs you",
  "clover.island.question": "Question",
  "clover.island.questionFrom": "Question · {name}",
  "clover.island.asks": "{name} asks",
  "clover.island.aQuestion": "A question for you",
  "clover.island.otherPlaceholder": "Something else",
  "clover.island.typeAnswer": "Type an answer",
  "clover.island.next": "Next question",
  "clover.island.previous": "Previous question",
  "clover.island.send": "Send",
  "clover.island.showWaiting": "Waiting: {line}. Show it.",
  "clover.island.tabs": "Island tabs",
  "clover.island.onComputer": "on {computer}",
};

export function t(key: string, vars: Record<string, string | number> = {}): string {
  const entry = EN[key];
  if (entry === undefined) return key;
  let text: string;
  if (typeof entry === "string") text = entry;
  else text = vars.count === 1 && entry.one !== undefined ? entry.one : entry.other;
  return text.replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? `{${name}}`));
}
