// Bots as engine data (spec §6.1 "A bot is engine data", "A bot's data is its folder under the home's `bots/`", §6.2,
// §6.9; items 101, 114, 124; G8, G9, R5; the controller's rulings of 2026-11-17): the real `BotRecords` (contract
// `contracts/bot-records.ts`) over this home's disk. Owner: lane BT.
//
// | Path (under the home)                        | What                                         | Who writes it                    |
// | :------------------------------------------- | :------------------------------------------- | :------------------------------- |
// | `bots/<seg>/bot.json`                        | the record: name, model, effort, greeting, face pins, maker | the core only (no bot, §9.1) |
// | `bots/<seg>/instructions/instructions.md`    | the `<bot-instructions>` block, read at each turn | the core, the bot and its maker (the fence's rule) |
// | `bots/<seg>/memory/`, `bots/<seg>/agents/`   | its memory and its agents' transcripts       | as before (lane D, lane K)       |
// | `transcripts/<seg>/`                         | its one conversation and its side threads    | the session host                 |
// | `transcripts/<seg>/bot-read.json`            | how far the user has read its conversation   | the core                         |
// | `archive/bots/<seg>/`                        | a removed bot, whole (`archived.json` first) | the core                         |
// | `user-layers/moved/bots.json`                | the move's journal, written once             | the core                         |
//
// `<seg>` is the id with `/` written `--` (§5.1). The record is written last when a bot is made (its folders and its
// instructions first), so a crash leaves no half bot: a folder with no readable `bot.json` is no bot.
//
// * **Ids** come from the name (`botIdFromName`); taken are every record, every archived bot and every plugin bot the move
//   hasn't moved yet (`reserved`), so no id is ever handed out twice.
// * **Instructions** are untrusted text the bot itself writes: read without following a link, with one name only and
//   capped (`readOwnFile`), fresh when the file changed; a file that isn't plain reads as empty and is logged.
// * **A bot makes a bot** (`proposeByBot`): nothing exists until the person's yes; a maker has at most
//   `PROPOSALS_PER_MAKER` waiting.
// * **Remove archives** (the controller's ruling 4): the bot's folder, its conversation's folder and its routines'
//   folder move to `archive/bots/<seg>/`, from which `restore` moves them back. Nothing is deleted. A crash in the
//   middle is finished at the next start (`archived.json`'s `state`).
// * **The move** (`move`): once, each plugin bot to a record of the same id (below, `move`).
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  BOT_ARCHIVE_DIR, BOT_INSTRUCTIONS_FILE, BOT_MOVE_JOURNAL, BOT_RECORD_FILE, BotFace, BotId, BotMoveJournal, BotPatch, BotRecord, MakeBotInput,
  type ArchivedBot, type BotMaker, type BotMoveOutcome, type BotRecordView, type MakeBotResult, type Text,
} from "@waifucave/moss-protocol";
import type { Clock } from "../contracts/clock";
import { ContractError, Listeners, type Unsubscribe } from "../contracts/common";
import {
  botIdFromName, type BotPluginSettings, type BotProposal, type BotRecords, type InstructionsEditor, type PluginBotForMove,
} from "../contracts/bot-records";
import { instructionsEditRule } from "@waifucave/moss-protocol";
import { readJson, writeJsonAtomic } from "../sessions/atomic-file";
import { syncDir, syncFile } from "../sessions/durable-io";
import { botSegment, mainSessionIdFor, transcriptsDir } from "../sessions/ids";
import { BOT_RECORD_MAX_BYTES, plainFolder, readRecordFile } from "./made-by";
import { seedMemory } from "./memory";
import { readOwnFile } from "./own-file";
import { botStateFile } from "./paths";
import { GREETING_MAX_CHARS, INSTRUCTIONS_MAX_CHARS } from "./plugin-bot";
import { MODEL_ID_RE } from "./user-layer";

/** How many proposals one maker may have waiting for the person's OK at once. */
export const PROPOSALS_PER_MAKER = 3;
/** The most bytes of instructions read (the protocol's 200,000 characters, at up to 4 bytes each). */
const INSTRUCTIONS_MAX_BYTES = INSTRUCTIONS_MAX_CHARS * 4;
const EFFORT_RE = /^[a-z0-9][a-z0-9-]*$/;

const textOf = (t: Text): string => (typeof t === "string" ? t : t.en);

/** A plugin's bot-scoped settings as the plugin host keeps them (§5.9 `Setting.scope: "bot"`): the registry's
 *  declarations and the per-bot values in `settings/plugins/<id>.json`. The store keeps none of its own. */
export interface BotPluginSettingsPort {
  /** Every plugin's settings and their scopes. */
  declared(): { pluginId: string; settings: { key: string; scope: "account" | "device" | "bot"; default?: unknown }[] }[];
  /** One bot's value of one bot-scoped setting, when set. */
  value(bot: string, pluginId: string, key: string): { set: true; value: unknown } | { set: false };
  /** Sets (`null`: clears) one bot's value, as the user. */
  set(bot: string, pluginId: string, key: string, value: unknown): Promise<void>;
}

/** A plugin bot as the move takes it: the contract's, its plugin's starter memories, or why it couldn't be read. */
export type MoveInput = PluginBotForMove & {
  memorySeed?: string;
  /** Starter memory files by name (the default bot's, `default-bot.ts`), written when this computer never seeded the
   *  bot's memory and never over a file that is there. */
  memoryFiles?: Readonly<Record<string, string>>;
  /** Who the record says made it: the move from `plugin` unless given (the default bot: `{ kind: "default" }`). */
  madeBy?: BotMaker;
  /** The face the record pins (the default bot's, `default-bot.ts`); none: the face the name gives. */
  face?: BotFace;
  failed?: string;
  /** Its plugin was switched off, invalid or refused: moved straight into the archive. */
  archive?: true;
};

export interface BotRecordStoreOptions {
  home: string;
  clock: Clock;
  /** The plugins' bot-scoped settings; without it, no plugin declares any. */
  pluginSettings?: BotPluginSettingsPort;
  /** Ids held for plugin bots the move hasn't moved yet. */
  reserved?: () => Iterable<string>;
  warn?: (message: string) => void;
}

interface Held {
  record: BotRecord;
  /** The instructions file as last read: its stamp and text. */
  instructions?: { stamp: string; text: string };
}

interface ArchiveMark {
  archive: 1;
  id: string;
  name: Text;
  archivedAt: number;
  /** `archiving`: the folders are on their way into the archive; `archived`: all in; `restoring`: on their way back. */
  state: "archiving" | "archived" | "restoring";
  /** Archived by the move itself (its plugin was off): the plugin it came from. */
  movedFrom?: string;
}

/** The folders of a bot that move with it into the archive and back: under `bots/`, `transcripts/` and `routines/`. */
const ARCHIVED_PARTS = [
  { part: "bot", root: (home: string) => join(home, "bots") },
  { part: "transcripts", root: (home: string) => transcriptsDir(home) },
  { part: "routines", root: (home: string) => join(home, "routines") },
] as const;

/** Writes a text file whole: a temp file beside it, flushed, renamed over it (a link at the name is replaced, never
 *  followed), and the folder flushed. */
function writeTextAtomic(path: string, text: string): void {
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  const data = Buffer.from(text, "utf8");
  const fd = openSync(tmp, "wx", 0o600);
  try {
    let written = 0;
    while (written < data.length) written += writeSync(fd, data, written, data.length - written);
    syncFile(fd);
  } catch (err) {
    closeSync(fd);
    rmSync(tmp, { force: true });
    throw err;
  }
  closeSync(fd);
  try {
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  syncDir(dirname(path));
}

/** Makes `dir` under `base` folder by folder, refusing any step that is a link or a file. */
function plainFolders(base: string, ...parts: string[]): string {
  let at = base;
  for (const part of parts) {
    at = join(at, part);
    let st: ReturnType<typeof lstatSync> | undefined;
    try { st = lstatSync(at); } catch { st = undefined; }
    if (st === undefined) mkdirSync(at, { mode: 0o700 });
    else if (st.isSymbolicLink() || !st.isDirectory()) throw new ContractError("conflict", `${at} isn't a plain folder: a bot's folders are never made through a link`);
  }
  return at;
}

/** A record must stay readable at the next start: its file as `writeJsonAtomic` writes it is at most
 *  `BOT_RECORD_MAX_BYTES` (a greeting of control characters costs six bytes each as JSON). */
function checkRecordSize(record: BotRecord): void {
  const bytes = Buffer.byteLength(`${JSON.stringify(record, null, 2)}\n`, "utf8");
  if (bytes > BOT_RECORD_MAX_BYTES) throw new ContractError("invalid", `that would make the bot's record ${bytes} bytes, more than the ${BOT_RECORD_MAX_BYTES} a record may hold; shorten its greeting or name`);
}

export function recordFile(home: string, id: string): string {
  return join(home, "bots", botSegment(id), BOT_RECORD_FILE);
}

export function instructionsFile(home: string, id: string): string {
  return join(home, "bots", botSegment(id), ...BOT_INSTRUCTIONS_FILE.split("/"));
}

/** Where the user's reading of a bot's conversation is kept. */
export function readMarkFile(home: string, id: string): string {
  return join(transcriptsDir(home), botSegment(id), "bot-read.json");
}

function archiveDir(home: string, id: string): string {
  return join(home, ...BOT_ARCHIVE_DIR.split("/"), botSegment(id));
}

export class BotRecordStore implements BotRecords {
  readonly #o: BotRecordStoreOptions;
  readonly #home: string;
  readonly #records = new Map<string, Held>();
  readonly #archive = new Map<string, ArchiveMark>();
  readonly #proposals = new Map<string, BotProposal>();
  readonly #listeners = new Listeners<{ bot: BotRecordView } | { removed: string }>();
  readonly #warn: (message: string) => void;
  #journal: BotMoveJournal | undefined;
  #seq = 0;

  constructor(opts: BotRecordStoreOptions) {
    this.#o = opts;
    this.#home = opts.home;
    this.#warn = opts.warn ?? (() => {});
    this.#load();
  }

  // ── Reading ─────────────────────────────────────────────────────────────────────────────────────

  /** Every bot folder with a readable record of its own id; archives (finishing one a crash cut off); the journal. */
  #load(): void {
    this.#recoverArchives();
    const bots = join(this.#home, "bots");
    let names: string[] = [];
    try { names = readdirSync(bots); } catch { names = []; }
    for (const name of names) {
      const file = join(bots, name, BOT_RECORD_FILE);
      // A second name for a record (planted elsewhere): the core rewrites it as its own file first (copy and rename),
      // so the other name stops being it; a planted name can neither erase the bot nor be written through later.
      this.#unlink(file);
      const record = readRecordFile(file);
      if (record === undefined) {
        // A plugin bot's folder (its memory) the move hasn't reached, or a half-made bot: not a record.
        if (existsSync(join(bots, name, BOT_RECORD_FILE))) this.#warn(`bots/${name}/bot.json isn't a bot's record; it is left as it is`);
        continue;
      }
      if (botSegment(record.id) !== name) {
        this.#warn(`bots/${name}/bot.json names ${record.id}, whose folder is another; it is left as it is`);
        continue;
      }
      this.#records.set(record.id, { record });
    }
    const journal = BotMoveJournal.safeParse(readJson(join(this.#home, ...BOT_MOVE_JOURNAL.split("/"))));
    if (journal.success) this.#journal = journal.data;
    else if (existsSync(join(this.#home, ...BOT_MOVE_JOURNAL.split("/")))) this.#warn(`${BOT_MOVE_JOURNAL} doesn't parse; the move is held until it is looked at`);
  }

  /** A record file with more than one name made whole again: its bytes copied to a temp file and renamed over it. */
  #unlink(file: string): void {
    let st: ReturnType<typeof lstatSync> | undefined;
    try { st = lstatSync(file); } catch { return; }
    if (!st.isFile() || st.isSymbolicLink() || st.nlink < 2 || st.size > BOT_RECORD_MAX_BYTES) return;
    try {
      writeTextAtomic(file, readFileSync(file, "utf8"));
      this.#warn(`${file} had a second name; MOSS rewrote it as its own file`);
    } catch (err) {
      this.#warn(`${file} has a second name and couldn't be rewritten: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Whether the move's journal is there but unreadable: the move then never runs (it may have run). */
  get journalUnreadable(): boolean {
    return this.#journal === undefined && existsSync(join(this.#home, ...BOT_MOVE_JOURNAL.split("/")));
  }

  #taken = (id: string): boolean => {
    if (this.#records.has(id) || this.#archive.has(id)) return true;
    for (const r of this.#o.reserved?.() ?? []) if (r === id) return true;
    // A folder on the disk under that segment (a plugin bot's memory, a leftover) is never taken over either.
    return existsSync(join(this.#home, "bots", botSegment(id)));
  };

  #view(held: Held): BotRecordView {
    const { record: _r, ...rest } = held.record;
    return { ...rest, mainSession: mainSessionIdFor(held.record.id), instructionsBytes: Buffer.byteLength(this.#instructionsOf(held), "utf8") };
  }

  #held(id: string): Held {
    const held = this.#records.get(id);
    if (!held) throw new ContractError("not_found", `no bot ${id}`);
    return held;
  }

  /** The instructions file now: read again only when it changed (its inode, size and time), never through a link. */
  #instructionsOf(held: Held): string {
    const path = instructionsFile(this.#home, held.record.id);
    let stamp: string;
    try {
      const st = lstatSync(path);
      stamp = `${st.ino}:${st.size}:${st.mtimeMs}:${st.nlink}:${st.isSymbolicLink() ? "l" : "f"}`;
    } catch {
      return "";
    }
    if (held.instructions?.stamp === stamp) return held.instructions.text;
    const read = readOwnFile(this.#home, path, { maxBytes: INSTRUCTIONS_MAX_BYTES, whole: true });
    let text = "";
    if (read.ok) {
      text = read.data.toString("utf8");
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      if (text.length > INSTRUCTIONS_MAX_CHARS) text = text.slice(0, INSTRUCTIONS_MAX_CHARS);
    } else {
      this.#warn(`${held.record.id}'s instructions file wasn't read (${read.why}); it is taken as empty`);
    }
    held.instructions = { stamp, text };
    return text;
  }

  list(): BotRecordView[] {
    return [...this.#records.values()].map((h) => this.#view(h));
  }

  get(id: string): BotRecordView | undefined {
    const held = this.#records.get(id);
    return held ? this.#view(held) : undefined;
  }

  /** The record as it is on the disk's terms (who made it), for the instructions rule. */
  record(id: string): BotRecord | undefined {
    const held = this.#records.get(id);
    return held === undefined ? undefined : structuredClone(held.record);
  }

  has(id: string): boolean {
    return this.#records.has(id);
  }

  /** The instructions rule from the records the core holds (never re-read from the disk, where a planted second name
   *  could forge a maker): `bot` itself and every bot whose record names it as maker, each while its folder and its
   *  instructions folder are plain folders. */
  instructionsReach(bot: string): string[] {
    const out: string[] = [];
    for (const { record } of this.#records.values()) {
      if (record.id !== bot && !(record.madeBy.kind === "bot" && record.madeBy.id === bot)) continue;
      const folder = join(this.#home, "bots", botSegment(record.id));
      if (plainFolder(folder) && plainFolder(join(folder, "instructions"))) out.push(record.id);
    }
    return out;
  }

  instructions(id: string): string {
    return this.#instructionsOf(this.#held(id));
  }

  watch(fn: (change: { bot: BotRecordView } | { removed: string }) => void): Unsubscribe {
    return this.#listeners.add(fn);
  }

  #emit(id: string): BotRecordView {
    const v = this.#view(this.#held(id));
    this.#listeners.emit({ bot: v });
    return v;
  }

  // ── Making and changing ─────────────────────────────────────────────────────────────────────────

  /** Writes a new bot: its folders, its instructions, then its record (last). */
  #write(record: BotRecord, instructions: string): void {
    checkRecordSize(record);
    const seg = botSegment(record.id);
    const root = plainFolders(this.#home, "bots", seg);
    plainFolders(root, "memory");
    plainFolders(root, "instructions");
    writeTextAtomic(instructionsFile(this.#home, record.id), instructions);
    writeJsonAtomic(join(root, BOT_RECORD_FILE), record, { mode: 0o600 });
    this.#records.set(record.id, { record });
  }

  /** A bot's folders as `#write` makes them: plain folders all the way, never through a link (refused otherwise). */
  #folders(id: string): void {
    const root = plainFolders(this.#home, "bots", botSegment(id));
    plainFolders(root, "instructions");
  }

  #checkFields(f: { name?: Text; instructions?: string; model?: string | null; effort?: string | null; greeting?: string | null; face?: unknown }): void {
    if (f.name !== undefined && textOf(f.name).trim() === "") throw new ContractError("invalid", "a bot needs a name");
    if (f.name !== undefined && textOf(f.name).length > 200) throw new ContractError("invalid", "a bot's name is at most 200 characters");
    if (typeof f.instructions === "string" && f.instructions.length > INSTRUCTIONS_MAX_CHARS) throw new ContractError("invalid", `a bot's instructions are at most ${INSTRUCTIONS_MAX_CHARS} characters`);
    if (typeof f.model === "string" && !MODEL_ID_RE.test(f.model)) throw new ContractError("invalid", `"${f.model.slice(0, 200)}" is not a qualified model id (<provider>/<model>)`);
    if (typeof f.effort === "string" && !EFFORT_RE.test(f.effort)) throw new ContractError("invalid", `"${f.effort.slice(0, 32)}" is not an effort`);
    if (typeof f.greeting === "string" && f.greeting.length > GREETING_MAX_CHARS) throw new ContractError("invalid", `a greeting is at most ${GREETING_MAX_CHARS} characters`);
    if (f.face !== undefined && f.face !== null && !BotFace.safeParse(f.face).success) throw new ContractError("invalid", "a face pins a shape and a colour only");
  }

  async create(input: { name: Text; instructions?: string; model?: string; effort?: string; face?: BotFace }, by: BotMaker): Promise<BotRecordView> {
    this.#checkFields(input);
    const id = botIdFromName(textOf(input.name), this.#taken);
    const record: BotRecord = {
      record: 1, id, name: input.name, madeBy: by, createdAt: this.#o.clock.now(),
      ...(input.model !== undefined ? { model: input.model } : {}), ...(input.effort !== undefined ? { effort: input.effort } : {}),
      ...(input.face !== undefined ? { face: BotFace.parse(input.face) } : {}),
    };
    this.#write(BotRecord.parse(record), input.instructions ?? "");
    return this.#emit(id);
  }

  async proposeByBot(maker: string, input: MakeBotInput, setUp: readonly string[]): Promise<{ proposal: BotProposal; card: true } | Extract<MakeBotResult, { outcome: "refused" }>> {
    const parsed = MakeBotInput.safeParse(input);
    if (!parsed.success) throw new ContractError("invalid", "MakeBot takes a name, instructions, a face and a model only");
    const makerRecord = this.#held(maker).record;
    if ([...this.#proposals.values()].filter((p) => p.maker === maker).length >= PROPOSALS_PER_MAKER) {
      return { outcome: "refused", why: `you already have ${PROPOSALS_PER_MAKER} new bots waiting for the person's answer; wait for those first` };
    }
    this.#checkFields({ name: parsed.data.name, ...(parsed.data.instructions === undefined ? {} : { instructions: parsed.data.instructions }) });
    const model = parsed.data.model ?? makerRecord.model;
    if (model !== undefined && !setUp.includes(model)) return { outcome: "refused", why: `${model} isn't a model the person has set up` };
    const proposal: BotProposal = { id: `prop_${this.#o.clock.now().toString(36)}_${++this.#seq}`, maker, input: { ...parsed.data, ...(model !== undefined ? { model } : {}) } };
    this.#proposals.set(proposal.id, proposal);
    return { proposal, card: true };
  }

  proposals(): BotProposal[] {
    return [...this.#proposals.values()].map((p) => structuredClone(p));
  }

  async answerProposal(id: string, yes: boolean): Promise<MakeBotResult> {
    const p = this.#proposals.get(id);
    if (!p) throw new ContractError("not_found", `no proposal ${id}`);
    this.#proposals.delete(id);
    if (!yes) return { outcome: "declined" };
    // The maker may have been removed while the card waited: the new bot still names it.
    const made = await this.create({
      name: p.input.name,
      ...(p.input.instructions !== undefined ? { instructions: p.input.instructions } : {}),
      ...(p.input.model !== undefined ? { model: p.input.model } : {}),
      ...(p.input.face !== undefined ? { face: p.input.face } : {}),
    }, { kind: "bot", id: p.maker });
    return { outcome: "made", id: made.id };
  }

  async edit(id: string, patch: BotPatch): Promise<BotRecordView> {
    const held = this.#held(id);
    const parsed = BotPatch.safeParse(patch);
    if (!parsed.success) throw new ContractError("invalid", `not a change to a bot: ${parsed.error.issues.map((i) => `${i.path.join(".") || "patch"}: ${i.message}`).join("; ")}`);
    const p = parsed.data;
    this.#checkFields(p);
    const next: BotRecord = { ...held.record };
    if (p.name !== undefined) next.name = p.name;
    for (const k of ["model", "effort", "greeting", "face"] as const) {
      const v = p[k];
      if (v === null) delete next[k];
      else if (v !== undefined) (next as Record<string, unknown>)[k] = v;
    }
    const parsedNext = BotRecord.parse(next);
    checkRecordSize(parsedNext);
    this.#folders(id);
    if (p.instructions !== undefined) writeTextAtomic(instructionsFile(this.#home, id), p.instructions);
    writeJsonAtomic(recordFile(this.#home, id), parsedNext, { mode: 0o600 });
    held.record = next;
    return this.#emit(id);
  }

  async writeInstructions(editor: InstructionsEditor, id: string, text: string): Promise<{ written: true } | { written: false; card: true }> {
    const held = this.#held(id);
    const rule = instructionsEditRule(editor, held.record);
    if (rule === "refused") throw new ContractError("refused", "only a bot, or the user, edits a bot's instructions");
    if (rule === "card") return { written: false, card: true };
    this.#checkFields({ instructions: text });
    this.#folders(id);
    writeTextAtomic(instructionsFile(this.#home, id), text);
    this.#emit(id);
    return { written: true };
  }

  // ── The archive ─────────────────────────────────────────────────────────────────────────────────

  #markPath(id: string): string {
    return join(archiveDir(this.#home, id), "archived.json");
  }

  /** Moves each part of a bot between its place and the archive; a part already moved is skipped. */
  #moveParts(id: string, toArchive: boolean): void {
    const dir = archiveDir(this.#home, id);
    const seg = botSegment(id);
    for (const { part, root } of ARCHIVED_PARTS) {
      const at = join(root(this.#home), seg);
      const kept = join(dir, part);
      const [from, to] = toArchive ? [at, kept] : [kept, at];
      if (!existsSync(from)) continue;
      if (existsSync(to)) throw new ContractError("conflict", `${to} is already there; ${id} is left as it is`);
      mkdirSync(dirname(to), { recursive: true });
      renameSync(from, to);
      syncDir(dirname(from));
      syncDir(dirname(to));
    }
  }

  /** Finishes an archive or a restore a crash cut off, and lists the archive. */
  #recoverArchives(): void {
    const root = join(this.#home, ...BOT_ARCHIVE_DIR.split("/"));
    let names: string[] = [];
    try { names = readdirSync(root); } catch { return; }
    for (const name of names) {
      const markPath = join(root, name, "archived.json");
      const mark = readJson(markPath) as Partial<ArchiveMark> | undefined;
      if (mark?.archive !== 1 || typeof mark.id !== "string" || !BotId.safeParse(mark.id).success || botSegment(mark.id) !== name) {
        this.#warn(`archive/bots/${name} has no readable archived.json; it is left as it is`);
        continue;
      }
      const m = mark as ArchiveMark;
      try {
        if (m.state === "archiving") {
          this.#moveParts(m.id, true);
          writeJsonAtomic(markPath, { ...m, state: "archived" } satisfies ArchiveMark);
          m.state = "archived";
        } else if (m.state === "restoring") {
          this.#moveParts(m.id, false);
          rmSync(join(root, name), { recursive: true, force: true });
          continue;
        }
      } catch (err) {
        this.#warn(`finishing ${m.id}'s ${m.state === "restoring" ? "restore" : "archive"} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      this.#archive.set(m.id, m);
    }
  }

  /** Archives a bot: its record, instructions, memory, agents' transcripts, its conversation and its routines move to
   *  `archive/bots/<seg>/`; nothing is deleted. Its sessions must be let go first (the bot service does). */
  async remove(id: string): Promise<void> {
    this.#archiveNow(id);
  }

  /** Archives a bot now (`remove`, and the move for a bot whose plugin was off: `movedFrom`). */
  #archiveNow(id: string, movedFrom?: string): void {
    const held = this.#held(id);
    const mark: ArchiveMark = { archive: 1, id, name: held.record.name, archivedAt: this.#o.clock.now(), state: "archiving", ...(movedFrom === undefined ? {} : { movedFrom }) };
    const dir = archiveDir(this.#home, id);
    if (existsSync(dir)) throw new ContractError("conflict", `an archive of ${id} is already there`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeJsonAtomic(this.#markPath(id), mark);
    this.#moveParts(id, true);
    writeJsonAtomic(this.#markPath(id), { ...mark, state: "archived" } satisfies ArchiveMark);
    this.#records.delete(id);
    this.#archive.set(id, { ...mark, state: "archived" });
    for (const [pid, p] of this.#proposals) if (p.maker === id) this.#proposals.delete(pid);
    this.#listeners.emit({ removed: id });
  }

  archived(): ArchivedBot[] {
    return [...this.#archive.values()].map((a) => ({ id: a.id, name: a.name, archivedAt: a.archivedAt }));
  }

  async restore(id: string): Promise<BotRecordView> {
    const mark = this.#archive.get(id);
    if (!mark) throw new ContractError("not_found", `no archived bot ${id}`);
    if (this.#records.has(id)) throw new ContractError("conflict", `a bot ${id} exists`);
    // Every place it goes back to must be free before anything moves.
    for (const { part, root } of ARCHIVED_PARTS) {
      const to = join(root(this.#home), botSegment(id));
      if (existsSync(join(archiveDir(this.#home, id), part)) && existsSync(to)) throw new ContractError("conflict", `${to} is already there, so ${id} can't come back; nothing was moved`);
    }
    writeJsonAtomic(this.#markPath(id), { ...mark, state: "restoring" } satisfies ArchiveMark);
    this.#moveParts(id, false);
    rmSync(archiveDir(this.#home, id), { recursive: true, force: true });
    this.#archive.delete(id);
    const record = readRecordFile(recordFile(this.#home, id));
    if (record === undefined || record.id !== id) throw new ContractError("failed", `${id}'s record didn't come back readable; its folder is in bots/ as it was`);
    this.#records.set(id, { record });
    return this.#emit(id);
  }

  // ── Plugins' bot-scoped settings ────────────────────────────────────────────────────────────────

  pluginSettings(bot: string): BotPluginSettings[] {
    this.#held(bot);
    const port = this.#o.pluginSettings;
    if (port === undefined) return [];
    return port.declared().flatMap(({ pluginId, settings }) => {
      const scoped = settings.filter((s) => s.scope === "bot");
      if (scoped.length === 0) return [];
      return [{ pluginId, settings: scoped.map((s) => {
        const v = port.value(bot, pluginId, s.key);
        return { key: s.key, value: v.set ? v.value : s.default, set: v.set };
      }) }];
    });
  }

  async setPluginSetting(bot: string, pluginId: string, key: string, value: unknown): Promise<void> {
    this.#held(bot);
    const port = this.#o.pluginSettings;
    const s = port?.declared().find((d) => d.pluginId === pluginId)?.settings.find((x) => x.key === key);
    if (port === undefined || s === undefined) throw new ContractError("not_found", `${pluginId} declares no setting ${key}`);
    if (s.scope !== "bot") throw new ContractError("refused", `${pluginId}'s ${key} isn't a setting per bot`);
    await port.set(bot, pluginId, key, value);
  }

  // ── The one-time move ───────────────────────────────────────────────────────────────────────────

  journal(): BotMoveJournal | undefined {
    return this.#journal === undefined ? undefined : structuredClone(this.#journal);
  }

  /** Each plugin bot becomes a record of the same id (the journal). Its instructions, greeting, model and effort are
   *  the user's layer over its plugin's; its memory, its conversation and its routines are already under its id and stay
   *  where they are; its plugin's starter memories are copied if this computer never copied them. A bot whose plugin
   *  the person had switched off (or that is invalid or refused) goes straight into the archive, whole, for the person
   *  to bring back on purpose (`archived`). An id that has a record already is kept as it is, unless the move itself
   *  wrote it (a run a crash cut off: `moved`). A bot that can't be read or written is `failed`, with why, and nothing
   *  of it is touched. The journal is written last. Run again (each start), only what the journal doesn't settle is
   *  moved: a `failed` entry and a plugin bot it doesn't name yet; a `moved` or `kept` entry is never touched again,
   *  and a run that settles nothing new changes nothing. */
  async move(bots: readonly MoveInput[]): Promise<BotMoveJournal> {
    if (this.journalUnreadable) throw new ContractError("conflict", `${BOT_MOVE_JOURNAL} is there but unreadable, so the move may have run; it is held until it is looked at`);
    const before = this.#journal;
    const settled = new Map((before?.bots ?? []).filter((b) => b.outcome !== "failed").map((b) => [b.id, b] as const));
    const outcomes: BotMoveOutcome[] = [];
    const seen = new Set<string>();
    let changed = before === undefined;
    for (const b of bots) {
      if (seen.has(b.id) || settled.has(b.id)) continue;
      seen.add(b.id);
      const one = this.#moveOne(b);
      const was = before?.bots.find((x) => x.id === b.id);
      if (was === undefined || JSON.stringify(was) !== JSON.stringify(one)) changed = true;
      outcomes.push(one);
    }
    // A failed entry whose plugin bot is gone stays as it was.
    for (const b of before?.bots ?? []) if (b.outcome === "failed" && !seen.has(b.id)) outcomes.push(b);
    if (!changed && before !== undefined) return structuredClone(before);
    const merged = [...(before?.bots ?? []).filter((b) => settled.has(b.id)), ...outcomes];
    // `at` is the first completion's time and never moves forward: what the home holds of a bot dated before it is
    // pre-split (move.ts), so a later run must not push the line past a bot made in between.
    const journal = BotMoveJournal.parse({ move: 1, at: before?.at ?? this.#o.clock.now(), bots: merged.slice(0, 1024) });
    writeJsonAtomic(join(this.#home, ...BOT_MOVE_JOURNAL.split("/")), journal, { mode: 0o600 });
    this.#journal = journal;
    return structuredClone(journal);
  }

  #moveOne(b: MoveInput): BotMoveOutcome {
    if (!BotId.safeParse(b.id).success) return { outcome: "failed", id: b.id.slice(0, 64) || "bot", plugin: b.plugin, why: "its id isn't a bot id" };
    if (b.failed !== undefined) return { outcome: "failed", id: b.id, plugin: b.plugin, why: b.failed.slice(0, 500) };
    const there = this.#records.get(b.id)?.record;
    if (there !== undefined) {
      const ours = b.madeBy !== undefined ? there.madeBy.kind === b.madeBy.kind : there.madeBy.kind === "move" && there.madeBy.plugin === b.plugin;
      return { outcome: ours ? "moved" : "kept", id: b.id, plugin: b.plugin };
    }
    if (this.#archive.has(b.id)) {
      const ours = this.#archive.get(b.id)!.movedFrom === b.plugin;
      return { outcome: ours ? "moved" : "kept", id: b.id, plugin: b.plugin };
    }
    try {
      const layer = b.userLayer ?? {};
      const model = layer.model ?? b.model;
      const effort = layer.effort ?? b.effort;
      const greeting = b.greeting?.trim();
      const record = BotRecord.parse({
        record: 1, id: b.id, name: layer.name ?? b.name, madeBy: b.madeBy ?? { kind: "move", plugin: b.plugin }, createdAt: this.#o.clock.now(),
        ...(model !== undefined && MODEL_ID_RE.test(model) ? { model } : {}),
        ...(effort !== undefined && EFFORT_RE.test(effort) ? { effort } : {}),
        ...(greeting !== undefined && greeting !== "" ? { greeting: greeting.slice(0, GREETING_MAX_CHARS) } : {}),
        ...(b.face === undefined ? {} : { face: b.face }),
      } satisfies BotRecord);
      const instructions = (layer.instructions ?? b.instructions).slice(0, INSTRUCTIONS_MAX_CHARS);
      this.#seed(b);
      this.#write(record, instructions);
      if (b.archive === true) this.#archiveNow(b.id, b.plugin);
      else this.#emit(b.id);
      return { outcome: "moved", id: b.id, plugin: b.plugin };
    } catch (err) {
      return { outcome: "failed", id: b.id, plugin: b.plugin, why: (err instanceof Error ? err.message : String(err)).slice(0, 500) };
    }
  }

  /** The plugin's starter memories, when this computer never copied them (the bot service's state file says). */
  #seed(b: MoveInput): void {
    if (b.memorySeed === undefined && b.memoryFiles === undefined) return;
    const file = botStateFile(this.#home, b.id);
    const state = (readJson(file) as { seededMemory?: unknown; firstSeen?: unknown } | undefined) ?? {};
    if (state.seededMemory === true) return;
    const memory = join(plainFolders(this.#home, "bots", botSegment(b.id)), "memory");
    plainFolders(dirname(memory), "memory");
    if (b.memorySeed !== undefined) seedMemory(b.memorySeed, memory, { base: this.#home, warn: this.#warn });
    for (const [name, text] of Object.entries(b.memoryFiles ?? {})) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name) || existsSync(join(memory, name))) continue;
      writeTextAtomic(join(memory, name), text);
    }
    writeJsonAtomic(file, { bot: b.id, firstSeen: typeof state.firstSeen === "number" ? state.firstSeen : this.#o.clock.now(), seededMemory: true });
  }
}
