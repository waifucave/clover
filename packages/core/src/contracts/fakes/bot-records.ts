// FakeBotRecords: bots as records in memory, with the instructions rule and the one-time move.
import { instructionsEditRule, type BotFace, type BotMaker, type BotMoveJournal, type BotMoveOutcome, type BotPatch, type BotRecord, type BotRecordView, type BotVoice, type Text } from "@waifucave/moss-protocol";
import type { Clock } from "../clock";
import { ContractError, Listeners, type Unsubscribe } from "../common";
import { botIdFromName, type BotRecords, type InstructionsEditor, type PluginBotForMove } from "../bot-records";

const textOf = (t: Text): string => (typeof t === "string" ? t : t.en);

export class FakeBotRecords implements BotRecords {
  readonly #clock: Clock;
  readonly #records = new Map<string, { record: BotRecord; instructions: string }>();
  readonly #listeners = new Listeners<{ bot: BotRecordView } | { removed: string }>();
  #journal: BotMoveJournal | undefined;

  constructor(opts: { clock: Clock }) {
    this.#clock = opts.clock;
  }

  #view(id: string): BotRecordView {
    const held = this.#records.get(id);
    if (!held) throw new ContractError("not_found", `no bot ${id}`);
    const { record: _r, ...rest } = held.record;
    return { ...rest, mainSession: `bot:${id}`, instructionsBytes: new TextEncoder().encode(held.instructions).length };
  }

  #emit(id: string): BotRecordView {
    const v = this.#view(id);
    this.#listeners.emit({ bot: v });
    return v;
  }

  list(): BotRecordView[] {
    return [...this.#records.keys()].map((id) => this.#view(id));
  }

  get(id: string): BotRecordView | undefined {
    return this.#records.has(id) ? this.#view(id) : undefined;
  }

  async create(input: { name: Text; instructions?: string; model?: string; effort?: string; voice?: BotVoice; face?: BotFace }, by: BotMaker): Promise<BotRecordView> {
    if (textOf(input.name).trim() === "") throw new ContractError("invalid", "a bot needs a name");
    const id = botIdFromName(textOf(input.name), (x) => this.#records.has(x));
    const record: BotRecord = {
      record: 1, id, name: input.name, madeBy: by, createdAt: this.#clock.now(),
      ...(input.model !== undefined ? { model: input.model } : {}), ...(input.effort !== undefined ? { effort: input.effort } : {}),
      ...(input.voice !== undefined ? { voice: input.voice } : {}), ...(input.face !== undefined ? { face: input.face } : {}),
    };
    this.#records.set(id, { record, instructions: input.instructions ?? "" });
    return this.#emit(id);
  }

  async edit(id: string, patch: BotPatch): Promise<BotRecordView> {
    const held = this.#records.get(id);
    if (!held) throw new ContractError("not_found", `no bot ${id}`);
    const next: BotRecord = { ...held.record };
    if (patch.name !== undefined) next.name = patch.name;
    for (const k of ["model", "effort", "voice", "greeting", "face"] as const) {
      const v = patch[k];
      if (v === null) delete next[k];
      else if (v !== undefined) (next as Record<string, unknown>)[k] = v;
    }
    held.record = next;
    if (patch.instructions !== undefined) held.instructions = patch.instructions;
    return this.#emit(id);
  }

  async remove(id: string): Promise<void> {
    if (!this.#records.delete(id)) throw new ContractError("not_found", `no bot ${id}`);
    this.#listeners.emit({ removed: id });
  }

  instructions(id: string): string {
    const held = this.#records.get(id);
    if (!held) throw new ContractError("not_found", `no bot ${id}`);
    return held.instructions;
  }

  async writeInstructions(editor: InstructionsEditor, id: string, text: string): Promise<{ written: true } | { written: false; card: true }> {
    const held = this.#records.get(id);
    if (!held) throw new ContractError("not_found", `no bot ${id}`);
    const rule = instructionsEditRule(editor, held.record);
    if (rule === "refused") throw new ContractError("refused", "only a bot, or the user, edits a bot's instructions");
    if (rule === "card") return { written: false, card: true };
    held.instructions = text;
    this.#emit(id);
    return { written: true };
  }

  async move(bots: readonly PluginBotForMove[]): Promise<BotMoveJournal> {
    if (this.#journal) return this.#journal;
    const outcomes: BotMoveOutcome[] = [];
    for (const b of bots) {
      if (this.#records.has(b.id)) { outcomes.push({ outcome: "kept", id: b.id, plugin: b.plugin }); continue; }
      const layer = b.userLayer ?? {};
      const model = layer.model ?? b.model;
      const effort = layer.effort ?? b.effort;
      const record: BotRecord = {
        record: 1, id: b.id, name: layer.name ?? b.name, madeBy: { kind: "move", plugin: b.plugin }, createdAt: this.#clock.now(),
        ...(model !== undefined ? { model } : {}), ...(effort !== undefined ? { effort } : {}),
        ...(b.voice !== undefined ? { voice: b.voice } : {}), ...(b.greeting !== undefined ? { greeting: b.greeting } : {}),
      };
      this.#records.set(b.id, { record, instructions: layer.instructions ?? b.instructions });
      this.#emit(b.id);
      outcomes.push({ outcome: "moved", id: b.id, plugin: b.plugin });
    }
    this.#journal = { move: 1, at: this.#clock.now(), bots: outcomes };
    return this.#journal;
  }

  journal(): BotMoveJournal | undefined {
    return this.#journal;
  }

  watch(fn: (change: { bot: BotRecordView } | { removed: string }) => void): Unsubscribe {
    return this.#listeners.add(fn);
  }
}
