// What MOSS's main process hands its window (spec §3.6 "What the engine gives MOSS as plain data", §6.10): plain data,
// states and names, never a sealed card's text and never markup. The window draws it with React text nodes only. Types
// alone, shared by the main process and the window (no Node, no DOM).
import type { ActivityState, BotFace, ToolAvailability } from "@waifucave/moss-protocol";

/** A face's pinned traits (§6.9, lane BT's record): shape, colour, eyes and temper, each optional, the rest from the name. */
export type { BotFace };

/** The engine pieces the window stands on, each served by its own lane: until a piece is served, the window says it is
 *  waiting for it, never shows something made up. */
export type Piece = "bots" | "summaries" | "activity" | "routines" | "memory" | "pictures" | "router" | "tools" | "plugins" | "account" | "devices" | "models" | "key";
export type PieceState = "ready" | "waiting" | "failed";

export type ConnectionKind = "connecting" | "starting-engine" | "connected" | "reconnecting" | "behind" | "refused" | "unavailable" | "stopped";

export interface BotRow {
  id: string;
  name: string;
  /** The traits the person pinned (shape, colour); the rest comes from the name. */
  face?: BotFace;
  /** From the activity feed; `idle` until the feed says otherwise. */
  mood: ActivityState;
  /** The tool's wire name while `working`, never its arguments. */
  tool?: string;
  last?: { text: string; from: "user" | "bot" | "note"; at: number };
  unread: boolean;
}

/** A card the router placed in MOSS's window: its ids only (its words are sealed, drawn by its own frame). */
export interface CardRow {
  id: string;
  bot?: string;
  kind: string;
  /** In the conversation of the bot it belongs to, or in the window's own strip. */
  place: "conversation" | "strip";
}

export interface MossView {
  connection: { kind: ConnectionKind; reason?: string };
  pieces: Partial<Record<Piece, PieceState>>;
  bots: BotRow[];
  cards: CardRow[];
  /** Whether the microphone can run the voice plugin's talk command now, and why not when it can't. */
  talk?: { ready: true } | { ready: false; why: string };
  /** The engine's release, when connected. */
  engine?: string;
}

export interface Attachment {
  /** The file's name as shown (its last path segment), never its contents. */
  name: string;
  kind: "file" | "image";
}

export interface Message {
  id: string;
  from: "user" | "bot" | "note";
  /** Plain text: the window shows it as text, never as markup. */
  text: string;
  at: number;
  files?: Attachment[];
  /** A note that a turn ended in an error: the conversation offers Try again while it is the last thing there. */
  failed?: true;
}

export interface ConversationPage {
  bot: string;
  messages: Message[];
  hasMore: boolean;
  /** The seq to page back from. */
  before?: number;
}

export interface RoutineRow {
  id: string;
  name: string;
  /** Its triggers in words (`Every day at 9:00`). */
  schedule: string;
  paused: boolean;
  /** The engine's state: on, paused (by the person or by MOSS), waiting for the person's OK on a raised level, a copy
   *  with the same id, or its bot removed. Only an `active` one can run now. */
  state: "active" | "paused" | "waiting-for-ok" | "duplicate" | "bot-removed";
  /** Why MOSS paused it, while it stays paused. */
  pausedWhy?: string;
  /** Its schedule trigger as written (`every 6h`, `0 8 * * 1-5`), for the edit form; none when it has no schedule. */
  scheduleSpec?: string;
  nextRunAt?: number;
}

/** What the person changes on a routine (`routine.edit`): its file is rewritten by the engine. */
export interface RoutineEdit {
  name?: string;
  schedule?: string;
  instructions?: string;
  paused?: boolean;
}

/** One file of a bot's memory, as the engine serves it to MOSS (`memory.list`): read only here. */
export interface MemoryFileRow {
  path: string;
  size: number;
  modifiedAt: number;
}

export interface PictureRow {
  id: string;
  /** The plugin that publishes it (its id, shown beside the picture), and its name when the engine lists it. */
  publisher: string;
  publisherName?: string;
  tool?: string;
  width: number;
  height: number;
  screen: boolean;
}

/** One frame of a live picture: inert pixels, a data URL of an image the engine checked. */
export interface PictureFrameView {
  id: string;
  seq: number;
  url: string;
}

export interface ToolRow {
  server: string;
  tool: string;
  availability: ToolAvailability;
  /** What the plugin declares, which is the default (`preload` is always on, `on-demand` on demand). */
  declared?: ToolAvailability;
  permission: "allow" | "ask" | "deny";
}

export interface PluginRow {
  id: string;
  name: string;
  enabled: boolean;
  tools: ToolRow[];
}

/** MOSS's own Settings (spec §6.10, R8): each section is the engine's data, or "waiting" while its piece isn't served. */
export interface SettingsView {
  account: { signedIn: boolean; name?: string; email?: string } | "waiting";
  /** The keys and sign-ins of the plugins that have any (models, voices): their state, never a key. */
  signIns: { pluginId: string; name: string; index: number; method: "api-key" | "oauth-pkce" | "custom" | "core"; state: string; account?: string }[] | "waiting";
  /** The approval level of each computer (this one first). */
  computers: { name: string; level: string }[] | "waiting";
  devices: { id: string; name: string; kind: string }[] | "waiting";
}

/** One of a plugin's declared bot-scoped settings (a voice plugin's voice for this bot), drawn generically from its schema. */
export interface BotSetting {
  pluginId: string;
  pluginName: string;
  key: string;
  type: "string" | "number" | "boolean" | "enum" | "color" | "secret";
  title: string;
  description?: string;
  options?: { value: string; title: string }[];
  min?: number;
  max?: number;
  value?: unknown;
  set: boolean;
}

/** A bot's own record for its Edit view (the person's: name, model, effort, face pins). The instructions' text is read on
 *  its own (`botInstructions`). */
export interface BotRecordRow {
  id: string;
  name: string;
  model?: string;
  effort?: string;
  face?: BotFace;
  instructionsBytes: number;
}

/** A change to a bot's record or instructions; `null` clears a field back to the default. */
export interface BotEdit {
  name?: string;
  instructions?: string;
  model?: string | null;
  effort?: string | null;
  face?: BotFace | null;
}

/** A model the person can give a bot (`models.list`). */
export interface ModelRow {
  id: string;
  title: string;
  provider: string;
  /** Its provider is signed in, so it can run a turn now. */
  ready: boolean;
}

/** What the window may ask MOSS's main process: a fixed list, never a generic call (preload.ts). */
export interface MossBridge {
  view(): Promise<MossView>;
  onView(fn: (view: MossView) => void): () => void;
  /** What the window shows now: a bot's conversation, or a page with none (presence's `showing`). */
  showing(page: { bot: string } | { page: "plugins" | "settings" | "none" }): void;
  conversation(bot: string, before?: number): Promise<ConversationPage | { waiting: true }>;
  onMessage(fn: (bot: string, message: Message) => void): () => void;
  /** Sends the person's words to a bot, with the pictures they picked (`pickImages`' ids); main takes it only right
   *  after their own key press or click. */
  send(bot: string, text: string, images?: readonly string[]): Promise<{ ok: true } | { ok: false; why: string }>;
  /** The person picks pictures to attach (main's own file dialog; PNG, JPEG or WebP, at most 4, 10 MB each): their names
   *  and the ids `send` takes. Never their bytes in the window. */
  pickImages(): Promise<{ id: string; name: string }[]>;
  /** Makes a bot with the model the person chose in the + flow (one of `models`), so its first turn has a credential. */
  createBot(name: string, model?: string): Promise<{ ok: true; id: string } | { ok: false; why: string }>;
  markRead(bot: string): void;
  routines(bot: string): Promise<RoutineRow[] | { waiting: true }>;
  /** A routine's instructions as its file has them now (`routine.get`), for the edit form. */
  routineInstructions(bot: string, id: string): Promise<{ text: string } | { ok: false; why: string }>;
  /** Runs a routine now (`routine.runNow`), after the person's own press. */
  runRoutine(id: string): Promise<{ ok: true } | { ok: false; why: string }>;
  /** Pauses, resumes or edits a routine (`routine.edit`), after the person's own press; the engine's why on a refusal. */
  editRoutine(bot: string, id: string, patch: RoutineEdit): Promise<{ ok: true; routine: RoutineRow } | { ok: false; why: string }>;
  /** A bot's memory files and one file's text (`memory.list`, `memory.read`): read only. */
  memory(bot: string): Promise<MemoryFileRow[] | { waiting: true }>;
  memoryFile(bot: string, path: string): Promise<{ text: string } | { ok: false; why: string }>;
  pictures(bot: string): Promise<PictureRow[] | { waiting: true }>;
  openPicture(id: string): Promise<boolean>;
  closePicture(id: string): void;
  onPictureFrame(fn: (frame: PictureFrameView) => void): () => void;
  /** A card's sealed frame for this window: its single-use `moss-sealed://` URL, or undefined. */
  cardFrame(cardId: string): Promise<string | undefined>;
  onCardHeight(fn: (cardId: string, height: number) => void): () => void;
  /** Why a press on a card's button was refused, in plain words, to show beside the card. */
  onCardSaid(fn: (cardId: string, words: string) => void): () => void;
  /** The microphone button: held down and let go (main runs the voice plugin's talk command). */
  talk(phase: "down" | "up"): void;
  plugins(): Promise<PluginRow[] | { waiting: true }>;
  setAvailability(server: string, tool: string, availability: ToolAvailability): Promise<boolean>;
  /** Adds a plugin from a link, behind the normal OK card (the router draws it here); a file is picked by main. */
  addPlugin(from: { link: string } | { file: true }): Promise<{ ok: true } | { ok: false; why: string }>;
  settings(): Promise<SettingsView>;
  botSettings(bot: string): Promise<BotSetting[] | { waiting: true }>;
  /** A person's change to a bot's plugin setting; main takes it only right after their own press. */
  setBotSetting(bot: string, pluginId: string, key: string, value: unknown): Promise<boolean>;
  /** A computer's approval level: the engine raises a sealed card (a sensitive change), which the router places here. */
  setLevel(computer: string, level: string): Promise<boolean>;
  /** A tool's permission (always allow / ask / always block), the person's own, after their press. */
  setPermission(server: string, tool: string, permission: "allow" | "ask" | "deny"): Promise<boolean>;
  /** Signs in with one of a plugin's `auth` entries: a key goes in once and never comes back; for a browser sign-in
   *  main opens the page itself (the window never sees the link). */
  signIn(pluginId: string, index: number, key?: string): Promise<{ state: string } | { ok: false; why: string }>;
  /** Signs out of one entry, after the person's yes on a sealed card the router places here. */
  signOut(pluginId: string, index: number): Promise<boolean>;
  botRecord(id: string): Promise<BotRecordRow | { waiting: true }>;
  /** The bot's instructions as they are now (`bot.instructions.get`, the person's own client only), so an edit never
   *  writes over text the person couldn't see; waiting while the engine doesn't serve it. */
  botInstructions(id: string): Promise<{ text: string } | { waiting: true }>;
  editBot(id: string, patch: BotEdit): Promise<boolean>;
  /** Archives a bot after the person's press (nothing is deleted); `archivedBots` lists them and `restoreBot` brings one
   *  back with its conversation whole. */
  archiveBot(id: string): Promise<boolean>;
  archivedBots(): Promise<{ id: string; name: string }[] | { waiting: true }>;
  restoreBot(id: string): Promise<boolean>;
  /** Try again on the bot's failed latest turn (`session.resend`): the engine sends the same words once more, after the
   *  person's own press. */
  retry(bot: string): Promise<{ ok: true } | { ok: false; why: string }>;
  /** The person tried to act on a bot's screen (a click, a key, a scroll): it is watch only, and main says so. */
  pictureInput(kind: "pointer" | "key" | "wheel"): void;
  models(): Promise<ModelRow[] | { waiting: true }>;
}

/** A mood in words, said beside every face (the kit's README: "a mood is shown by motion alone"). */
export const MOOD_WORDS: Readonly<Record<ActivityState, string>> = {
  idle: "Idle",
  listening: "Listening",
  thinking: "Thinking",
  working: "Working",
  asking: "Needs you",
  stuck: "Stuck",
  done: "Done",
  asleep: "Asleep",
};
