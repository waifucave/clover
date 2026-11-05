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
  "clover.island.notSent": "Not sent. Try again.",
  "clover.island.approval": "Approval",
  "clover.island.linkRequest": "Link request",
  "clover.island.moreBelow": "More below",
  "clover.island.declineLink": "Decline the link",
  "clover.island.openLink": "Open the link",
  "clover.island.deny": "Deny",
  "clover.island.allowOnce": "Allow once",
  "clover.devices.title": "Devices",
  "clover.devices.summary": "{online} of {count} online",
  "clover.devices.none": "No devices yet",
  "clover.devices.manage": "Manage devices",
  "clover.devices.computers": "Computers",
  "clover.devices.others": "Phones and browsers",
  "clover.devices.groupMeta": "{online} of {count} online",
  "clover.devices.thisDevice": "this device",
  "clover.devices.main": "main",
  "clover.devices.running": "Running",
  "clover.devices.kind.desktop": "Computer",
  "clover.devices.kind.server": "Server",
  "clover.devices.kind.cloud": "Cloud computer",
  "clover.devices.kind.phone": "Phone",
  "clover.devices.kind.browser": "Browser",
  "clover.devices.notLinked": "Not linked",
  "clover.devices.direct": "Direct",
  "clover.devices.sameNetwork": "Same network",
  "clover.devices.viaRelay": "Through a relay",
  "clover.devices.viaRelayNamed": "Through {relay}",
  "clover.devices.roundTrip": "{ms} ms round trip",
  "clover.devices.lastViaRelay": "Last linked through {relay}",
  "clover.devices.neverSeen": "Never seen",
  "clover.devices.seenNow": "Seen just now",
  "clover.devices.seenMinutes": { one: "Seen 1 min ago", other: "Seen {count} min ago" },
  "clover.devices.seenHours": { one: "Seen 1 h ago", other: "Seen {count} h ago" },
  "clover.devices.seenYesterday": "Seen yesterday",
  "clover.devices.seenDays": { one: "Seen 1 day ago", other: "Seen {count} days ago" },
  "clover.devices.seenOn": "Seen {date}",
};

export function t(key: string, vars: Record<string, string | number> = {}): string {
  const entry = EN[key];
  if (entry === undefined) return key;
  let text: string;
  if (typeof entry === "string") text = entry;
  else text = vars.count === 1 && entry.one !== undefined ? entry.one : entry.other;
  return text.replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? `{${name}}`));
}
