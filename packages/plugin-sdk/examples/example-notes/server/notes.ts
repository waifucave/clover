// The notes themselves: a list in the plugin's synced store (key `notes`), so they follow the user to every computer
// running this plugin, and a count of the Notes bot's turns (key `turns`, which the turn.end hook moves). Pure apart from
// the store it is handed; every write goes through one chain, so two calls at once never lose a note.

export interface Note {
  /** A short handle the bot deletes by (`n1`, `n2`, …); the page never shows it. */
  id: string;
  text: string;
  /** When it was written (ms since the epoch). */
  at: number;
}

/** The parts of the plugin API the notes use. */
export interface NotesStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

export const NOTES_KEY = "notes";
export const TURNS_KEY = "turns";
/** At most this many notes, and this long each: the synced store holds at most 1 MB for the whole plugin. */
export const NOTES_MAX = 200;
export const NOTE_TEXT_MAX = 200;

/** A note's text as kept: one line, no control characters, at most NOTE_TEXT_MAX characters. */
export function cleanNote(text: unknown): string {
  return typeof text === "string" ? text.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, " ").replace(/\s+/g, " ").trim().slice(0, NOTE_TEXT_MAX) : "";
}

/** The stored list, read safely: anything that isn't a note is left out. */
export function readNotes(raw: unknown): Note[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((n): n is Note => n !== null && typeof n === "object" && typeof (n as Note).id === "string" && typeof (n as Note).text === "string" && typeof (n as Note).at === "number").slice(0, NOTES_MAX);
}

/** The next free handle. */
export function nextId(notes: readonly Note[]): string {
  for (let i = 1; ; i++) if (!notes.some((n) => n.id === `n${i}`)) return `n${i}`;
}

export class Notes {
  readonly #store: NotesStore;
  readonly #now: () => number;
  #chain: Promise<unknown> = Promise.resolve();

  constructor(store: NotesStore, now: () => number = Date.now) {
    this.#store = store;
    this.#now = now;
  }

  async list(): Promise<Note[]> {
    return readNotes(await this.#store.get(NOTES_KEY));
  }

  async turns(): Promise<number> {
    const t = await this.#store.get(TURNS_KEY);
    return typeof t === "number" && Number.isSafeInteger(t) && t >= 0 ? t : 0;
  }

  add(text: unknown): Promise<{ ok: true; note: Note } | { ok: false; said: string }> {
    return this.#serial(async () => {
      const clean = cleanNote(text);
      if (clean === "") return { ok: false as const, said: "A note needs some text." };
      const notes = await this.list();
      if (notes.length >= NOTES_MAX) return { ok: false as const, said: `There are ${NOTES_MAX} notes already; delete some first.` };
      const note = { id: nextId(notes), text: clean, at: this.#now() };
      await this.#store.set(NOTES_KEY, [...notes, note]);
      return { ok: true as const, note };
    });
  }

  delete(id: unknown): Promise<{ ok: true; note: Note } | { ok: false; said: string }> {
    return this.#serial(async () => {
      const notes = await this.list();
      const gone = notes.find((n) => n.id === id);
      if (gone === undefined) return { ok: false as const, said: `No note ${JSON.stringify(String(id).slice(0, 16))}; the handles are: ${notes.map((n) => n.id).join(", ") || "none"}.` };
      await this.#store.set(NOTES_KEY, notes.filter((n) => n.id !== gone.id));
      return { ok: true as const, note: gone };
    });
  }

  countTurn(): Promise<number> {
    return this.#serial(async () => {
      const turns = (await this.turns()) + 1;
      await this.#store.set(TURNS_KEY, turns);
      return turns;
    });
  }

  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#chain.then(fn, fn);
    this.#chain = run.catch(() => undefined);
    return run;
  }
}
