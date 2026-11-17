// What the fake engine holds: eight bots in eight moods, their conversations (one with a file and a card in it), two
// cards (one for the bot on screen, one for another, which the router puts in the strip), routines, a live picture,
// plugins with tools, and Settings' data. Made-up data for the tests and the renders only; nothing here is a real
// person's, and the real engine never sees it.
import { createHash } from "node:crypto";
import { cardHashInput, type ActivityState, type BotFace, type Card, type RoutineView } from "@waifucave/moss-protocol";

export interface FixtureBot {
  name: string;
  model?: string;
  instructions?: string;
  mood: ActivityState;
  tool?: string;
  face?: BotFace;
  unread?: boolean;
  /** Minutes ago of the last line. */
  ago: number;
  /** The conversation, oldest first: [who, text, files?]. */
  talk: [who: "user" | "bot", text: string, files?: string[]][];
}

export const BOTS: readonly FixtureBot[] = [
  {
    name: "Juniper", mood: "working", tool: "mcp__moss__Browser", ago: 1, model: "anthropic/claude-sonnet",
    instructions: "You plan trips. Book nothing without asking, keep receipts in the Travel folder, prefer window seats.", talk: [
      ["user", "Can you find me a flight to Lisbon for the 12th? Morning, window seat, under $350."],
      ["bot", "On it. I'll check three airlines and come back with the best two."],
      ["user", "Use my travel notes for the seat and the bag.", ["Travel notes.pdf"]],
      ["bot", "Got them: aisle is out, one checked bag. The 8:05 nonstop is $312.40 with a window seat. I've filled in the booking form; it needs your OK to submit."],
    ],
  },
  { name: "Kite", mood: "asking", unread: true, ago: 3, model: "openai/gpt-5.4-mini", instructions: "You keep the project tidy.", talk: [["user", "Clean up the old build folders in the project."], ["bot", "Two folders are 4.2 GB together. I'd like to delete them; can I go ahead?"]] },
  { name: "Maple", mood: "thinking", ago: 9, talk: [["user", "Plan the week's meals around what's in the fridge."], ["bot", "Thinking through the list you gave me…"]] },
  { name: "Cobalt", mood: "stuck", ago: 22, talk: [["user", "Sync the photos to the backup drive."], ["bot", "The backup drive isn't mounted, so I can't go on. Plug it in and I'll pick up where I stopped."]] },
  { name: "Fern", mood: "done", unread: true, ago: 41, talk: [["user", "Summarise the meeting notes from this morning."], ["bot", "Done: the summary is in your Notes folder, with the three action items at the top."]] },
  { name: "Brook", mood: "listening", ago: 68, talk: [["bot", "I'm listening. What should we work on?"]] },
  { name: "Ada", mood: "idle", ago: 60 * 5, face: { shape: "cup", color: "violet" }, talk: [["user", "Thanks for the reading list!"], ["bot", "Anytime. I'll add new papers as they come out."]] },
  { name: "Onyx", mood: "asleep", ago: 60 * 26, talk: [["bot", "Paused until Monday, as you asked."]] },
];

export function botId(name: string): string {
  return name.toLowerCase();
}

/** The next time it is `hour`:`minute` on a day `days` allows (0 Sunday), after `now`. */
function nextAt(now: number, hour: number, minute: number, days: readonly number[] = [0, 1, 2, 3, 4, 5, 6]): number {
  const d = new Date(now);
  d.setHours(hour, minute, 0, 0);
  while (d.getTime() <= now || !days.includes(d.getDay())) d.setDate(d.getDate() + 1);
  return d.getTime();
}

export function routinesOf(bot: string, now: number): RoutineView[] {
  const base = { bot, computer: "Studio", level: "ask-risky" };
  const file = (n: string) => `home/Studio/.moss/routines/${bot}/${n}.md`;
  if (bot === "juniper") {
    return [
      { ...base, id: `${bot}-prices`, name: "Watch flight prices", file: file("prices"), triggers: [{ type: "schedule", summary: "Every day at 7:00" }], state: "active", nextRunAt: nextAt(now, 7, 0) },
      { ...base, id: `${bot}-inbox`, name: "Sort the travel inbox", file: file("inbox"), triggers: [{ type: "schedule", summary: "Weekdays at 9:00" }], state: "active", nextRunAt: nextAt(now, 9, 0, [1, 2, 3, 4, 5]) },
      { ...base, id: `${bot}-visa`, name: "Visa paperwork reminders", file: file("visa"), triggers: [{ type: "schedule", summary: "Mondays at 8:30" }], state: "paused" },
    ];
  }
  if (bot === "fern") return [{ ...base, id: `${bot}-notes`, name: "Meeting notes digest", file: file("notes"), triggers: [{ type: "schedule", summary: "Weekdays at 12:30" }], state: "active" }];
  return [];
}

/** Each bot's memory folder, as `memory.list` and `memory.read` serve it. */
export const MEMORY: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  juniper: {
    "MEMORY.md": "# Juniper's memory\n\n- [Trips](trips.md): where Sam is going this year.\n<b>not markup</b>\n",
    "trips.md": "Lisbon in March. Kyoto in October.\n",
  },
};

export function sealedCard(c: Omit<Card, "hash">): Card {
  return { ...c, hash: createHash("sha256").update(cardHashInput(c)).digest("hex") } as Card;
}

export function cardsAt(now: number): Card[] {
  return [
    sealedCard({
      id: "card_juniper_book", kind: "tool", computer: "Studio", session: "bot:juniper", bot: "juniper", origin: "user", issuedAt: now - 30_000, expiresAt: null,
      fields: {
        title: { type: "text", text: "Submit the booking form?" },
        what: { type: "text", text: "Browser: click Book on example-air.test" },
        command: { type: "text", text: "Press \u201cBook\u201d: 8:05 nonstop to Lisbon, seat 14A, $312.40" },
        risk: { type: "text", text: "Spends money: $312.40 on your saved card" },
        computer: { type: "text", text: "Studio" },
      },
      options: [{ id: "allow_once", kind: "approve", label: "Book it" }, { id: "deny", kind: "deny", label: "Not now" }],
    }),
    sealedCard({
      id: "card_kite_delete", kind: "tool", computer: "Studio", session: "bot:kite", bot: "kite", origin: "user", issuedAt: now - 90_000, expiresAt: null,
      fields: {
        title: { type: "text", text: "Delete two folders?" },
        what: { type: "text", text: "Bash" },
        command: { type: "code", code: "rm -rf build/ .cache/old-builds/", language: "sh" },
        risk: { type: "text", text: "Deletes 4.2 GB in your project folder" },
        computer: { type: "text", text: "Studio" },
      },
      options: [{ id: "allow_once", kind: "approve", label: "Allow" }, { id: "deny", kind: "deny", label: "Deny" }],
    }),
  ];
}

/** The models the person has set up (`models.list`). */
export const MODELS = [
  { id: "anthropic/claude-sonnet", name: "Claude Sonnet", provider: "anthropic", providerName: "Anthropic", plugin: "moss/model-anthropic", efforts: ["low", "medium", "high"], images: true, signedIn: true },
  { id: "anthropic/claude-haiku", name: "Claude Haiku", provider: "anthropic", providerName: "Anthropic", plugin: "moss/model-anthropic", efforts: [], images: true, signedIn: true },
  { id: "openai/gpt-5.4-mini", name: "GPT-5.4 mini", provider: "openai", providerName: "OpenAI", plugin: "moss/model-openai", efforts: ["low", "high"], images: true, signedIn: false },
];

/** The person's own values on the tools (one differs from its declared default; permissions mixed). */
export const TOOL_VALUES: readonly { server: string; tool: string; availability?: "off" | "on-demand" | "always"; permission?: "allow" | "ask" | "deny" }[] = [
  { server: "moss_browser", tool: "Read", permission: "allow" },
  { server: "moss_browser", tool: "Fill", availability: "off" },
  { server: "opensky", tool: "Type", permission: "deny" },
  { server: "opensky", tool: "Screenshot", availability: "on-demand", permission: "allow" },
];

export const PLUGINS = [
  { id: "moss/browser", name: "MOSS Browser", enabled: true, server: "moss_browser", tools: { Open: "preload", Read: "preload", Click: "on-demand", Fill: "on-demand" } },
  { id: "opensky", name: "Computer use", enabled: true, server: "opensky", tools: { Screenshot: "preload", Click: "on-demand", Type: "on-demand" } },
  { id: "moss/voice", name: "MOSS Voice", enabled: true, server: "moss_voice", tools: {} },
  { id: "fish-audio", name: "Fish Audio", enabled: true, server: "fish_audio", tools: {} },
  { id: "moss/model-anthropic", name: "Anthropic models", enabled: true, server: "model_anthropic", tools: {} },
] as const;

/** A browser page drawn as an SVG, for the live picture's frames (rasterised by the fake engine). */
export const PAGE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800" viewBox="0 0 1280 800">
  <rect width="1280" height="800" fill="#ffffff"/>
  <rect width="1280" height="64" fill="#0b3d6b"/>
  <rect x="32" y="20" width="150" height="24" rx="6" fill="#ffffff" opacity="0.9"/>
  <rect x="980" y="20" width="268" height="24" rx="12" fill="#ffffff" opacity="0.25"/>
  <rect x="32" y="100" width="1216" height="120" rx="14" fill="#eef3f8"/>
  <rect x="64" y="130" width="260" height="22" rx="5" fill="#0b3d6b" opacity="0.85"/>
  <rect x="64" y="168" width="420" height="16" rx="5" fill="#5b6b7b" opacity="0.6"/>
  <rect x="1040" y="140" width="176" height="44" rx="10" fill="#f0694c"/>
  <g fill="#f7f9fb" stroke="#dde5ee">
    <rect x="32" y="250" width="1216" height="140" rx="14"/>
    <rect x="32" y="410" width="1216" height="140" rx="14"/>
    <rect x="32" y="570" width="1216" height="140" rx="14"/>
  </g>
  <g fill="#1b1d2b" opacity="0.8">
    <rect x="64" y="285" width="140" height="26" rx="5"/><rect x="64" y="445" width="140" height="26" rx="5"/><rect x="64" y="605" width="140" height="26" rx="5"/>
  </g>
  <g fill="#5b6b7b" opacity="0.45">
    <rect x="64" y="330" width="520" height="16" rx="5"/><rect x="64" y="490" width="460" height="16" rx="5"/><rect x="64" y="650" width="500" height="16" rx="5"/>
  </g>
  <g fill="#0b7a4b"><rect x="1080" y="290" width="136" height="30" rx="6"/><rect x="1080" y="450" width="136" height="30" rx="6" opacity="0.5"/><rect x="1080" y="610" width="136" height="30" rx="6" opacity="0.5"/></g>
  <rect x="24" y="242" width="1232" height="156" rx="18" fill="none" stroke="#e5a72e" stroke-width="4"/>
</svg>`;
