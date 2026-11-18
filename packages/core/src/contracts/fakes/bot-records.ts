// FakeBotRecords: bots as records in memory, with the instructions rule, the MakeBot proposals, the archive, plugins'
// bot-scoped settings and the one-time move. Its driver `declareBotSettings` stands in for the registry: which plugins
// declare which settings, at which scope.
import { BotFace as BotFaceSchema, instructionsEditRule, MakeBotInput, type ArchivedBot, type BotFace, type BotMaker, type BotMoveJournal, type BotMoveOutcome, type BotPatch, type BotRecord, type BotRecordView, type MakeBotResult, type Text } from "@waifucave/moss-protocol";
import type { Clock } from "../clock";
import { ContractError, Listeners, type Unsubscribe } from "../common";
import { botIdFromName, type BotPluginSettings, type BotProposal, type BotRecords, type InstructionsEditor, type PluginBotForMove } from "../bot-records";

const textOf = (t: Text): string => (typeof t === "string" ? t : t.en);

interface Held { record: BotRecord; instructions: string }

export class FakeBotRecords implements BotRecords {
  readonly #clock: Clock;
  readonly #records = new Map<string, Held>();
  readonly #archive = new Map<string, Held & { archivedAt: number }>();
  readonly #proposals = new Map<string, BotProposal>();
  readonly #declared = new Map<string, { key: string; scope: "account" | "device" | "bot"; default?: unknown }[]>();
  readonly #values = new Map<string, unknown>();
  readonly #listeners = new Listeners<{ bot: BotRecordView } | { removed: string }>();
  #journal: BotMoveJournal | undefined;
  #seq = 0;

  constructor(opts: { clock: Clock }) {
    this.#clock = opts.clock;
  }

  /** The registry's word: a plugin's settings and their scopes. */
  declareBotSettings(pluginId: string, settings: { key: string; scope: "account" | "device" | "bot"; default?: unknown }[]): void {
    this.#declared.set(pluginId, settings.map((s) => ({ ...s })));
  }

  #taken = (id: string) => this.#records.has(id) || this.#archive.has(id);

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

  #held(id: string): Held {
    const held = this.#records.get(id);
    if (!held) throw new ContractError("not_found", `no bot ${id}`);
    return held;
  }

  list(): BotRecordView[] {
    return [...this.#records.keys()].map((id) => this.#view(id));
  }

  get(id: string): BotRecordView | undefined {
    return this.#records.has(id) ? this.#view(id) : undefined;
  }

  async create(input: { name: Text; instructions?: string; model?: string; effort?: string; face?: BotFace }, by: BotMaker): Promise<BotRecordView> {
    if (textOf(input.name).trim() === "") throw new ContractError("invalid", "a bot needs a name");
    if (input.face !== undefined && !BotFaceSchema.safeParse(input.face).success) throw new ContractError("invalid", "a face pins the kit's shape, colour, eyes and temper only");
    const id = botIdFromName(textOf(input.name), this.#taken);
    const record: BotRecord = {
      record: 1, id, name: input.name, madeBy: by, createdAt: this.#clock.now(),
      ...(input.model !== undefined ? { model: input.model } : {}), ...(input.effort !== undefined ? { effort: input.effort } : {}),
      ...(input.face !== undefined ? { face: input.face } : {}),
    };
    this.#records.set(id, { record, instructions: input.instructions ?? "" });
    return this.#emit(id);
  }

  async proposeByBot(maker: string, input: MakeBotInput, setUp: readonly string[]): Promise<{ proposal: BotProposal; card: true } | Extract<MakeBotResult, { outcome: "refused" }>> {
    const parsed = MakeBotInput.safeParse(input);
    if (!parsed.success) throw new ContractError("invalid", "MakeBot takes a name, instructions, a face and a model only");
    const makerRecord = this.#held(maker).record;
    const model = parsed.data.model ?? makerRecord.model;
    if (model !== undefined && !setUp.includes(model)) return { outcome: "refused", why: `${model} isn't a model you have set up` };
    const proposal: BotProposal = { id: `prop_${++this.#seq}`, maker, input: { ...parsed.data, ...(model !== undefined ? { model } : {}) } };
    this.#proposals.set(proposal.id, proposal);
    return { proposal, card: true };
  }

  proposals(): BotProposal[] {
    return [...this.#proposals.values()];
  }

  async answerProposal(id: string, yes: boolean): Promise<MakeBotResult> {
    const p = this.#proposals.get(id);
    if (!p) throw new ContractError("not_found", `no proposal ${id}`);
    this.#proposals.delete(id);
    if (!yes) return { outcome: "declined" };
    const made = await this.create({ name: p.input.name, ...(p.input.instructions !== undefined ? { instructions: p.input.instructions } : {}), ...(p.input.model !== undefined ? { model: p.input.model } : {}), ...(p.input.face !== undefined ? { face: p.input.face } : {}) }, { kind: "bot", id: p.maker });
    return { outcome: "made", id: made.id };
  }

  async edit(id: string, patch: BotPatch): Promise<BotRecordView> {
    const held = this.#held(id);
    if (patch.face !== undefined && patch.face !== null && !BotFaceSchema.safeParse(patch.face).success) throw new ContractError("invalid", "a face pins the kit's shape, colour, eyes and temper only");
    const next: BotRecord = { ...held.record };
    if (patch.name !== undefined) next.name = patch.name;
    for (const k of ["model", "effort", "greeting", "face"] as const) {
      const v = patch[k];
      if (v === null) delete next[k];
      else if (v !== undefined) (next as Record<string, unknown>)[k] = v;
    }
    held.record = next;
    if (patch.instructions !== undefined) held.instructions = patch.instructions;
    return this.#emit(id);
  }

  async remove(id: string): Promise<void> {
    const held = this.#held(id);
    this.#records.delete(id);
    this.#archive.set(id, { ...held, archivedAt: this.#clock.now() });
    this.#listeners.emit({ removed: id });
  }

  archived(): ArchivedBot[] {
    return [...this.#archive.values()].map((a) => ({ id: a.record.id, name: a.record.name, archivedAt: a.archivedAt }));
  }

  async restore(id: string): Promise<BotRecordView> {
    const a = this.#archive.get(id);
    if (!a) throw new ContractError("not_found", `no archived bot ${id}`);
    if (this.#records.has(id)) throw new ContractError("conflict", `a bot ${id} exists`);
    this.#archive.delete(id);
    this.#records.set(id, { record: a.record, instructions: a.instructions });
    return this.#emit(id);
  }

  instructions(id: string): string {
    return this.#held(id).instructions;
  }

  async writeInstructions(editor: InstructionsEditor, id: string, text: string): Promise<{ written: true } | { written: false; card: true }> {
    const held = this.#held(id);
    const rule = instructionsEditRule(editor, held.record);
    if (rule === "refused") throw new ContractError("refused", "only a bot, or the user, edits a bot's instructions");
    if (rule === "card") return { written: false, card: true };
    held.instructions = text;
    this.#emit(id);
    return { written: true };
  }

  pluginSettings(bot: string): BotPluginSettings[] {
    this.#held(bot);
    return [...this.#declared].flatMap(([pluginId, settings]) => {
      const scoped = settings.filter((s) => s.scope === "bot");
      if (scoped.length === 0) return [];
      return [{ pluginId, settings: scoped.map((s) => {
        const k = `${bot}\0${pluginId}\0${s.key}`;
        const set = this.#values.has(k);
        return { key: s.key, value: set ? this.#values.get(k) : s.default, set };
      }) }];
    });
  }

  async setPluginSetting(bot: string, pluginId: string, key: string, value: unknown): Promise<void> {
    this.#held(bot);
    const s = this.#declared.get(pluginId)?.find((x) => x.key === key);
    if (!s) throw new ContractError("not_found", `${pluginId} declares no setting ${key}`);
    if (s.scope !== "bot") throw new ContractError("refused", `${pluginId}'s ${key} isn't a setting per bot`);
    const k = `${bot}\0${pluginId}\0${key}`;
    if (value === null) this.#values.delete(k);
    else this.#values.set(k, value);
  }

  async move(bots: readonly PluginBotForMove[]): Promise<BotMoveJournal> {
    const before = this.#journal;
    const settled = new Set((before?.bots ?? []).filter((b) => b.outcome !== "failed").map((b) => b.id));
    const fresh = bots.filter((b) => !settled.has(b.id));
    if (before !== undefined && fresh.length === 0) return before;
    const outcomes: BotMoveOutcome[] = [...(before?.bots ?? []).filter((b) => settled.has(b.id))];
    for (const b of fresh) {
      const there = this.#records.get(b.id)?.record;
      if (there !== undefined && there.madeBy.kind === "move" && there.madeBy.plugin === b.plugin) { outcomes.push({ outcome: "moved", id: b.id, plugin: b.plugin }); continue; }
      if (this.#taken(b.id)) { outcomes.push({ outcome: "kept", id: b.id, plugin: b.plugin }); continue; }
      const layer = b.userLayer ?? {};
      const model = layer.model ?? b.model;
      const effort = layer.effort ?? b.effort;
      const record: BotRecord = {
        record: 1, id: b.id, name: layer.name ?? b.name, madeBy: { kind: "move", plugin: b.plugin }, createdAt: this.#clock.now(),
        ...(model !== undefined ? { model } : {}), ...(effort !== undefined ? { effort } : {}),
        ...(b.greeting !== undefined ? { greeting: b.greeting } : {}),
      };
      this.#records.set(b.id, { record, instructions: layer.instructions ?? b.instructions });
      this.#emit(b.id);
      outcomes.push({ outcome: "moved", id: b.id, plugin: b.plugin });
    }
    this.#journal = { move: 1, at: before?.at ?? this.#clock.now(), bots: outcomes };
    return this.#journal;
  }

  journal(): BotMoveJournal | undefined {
    return this.#journal;
  }

  watch(fn: (change: { bot: BotRecordView } | { removed: string }) => void): Unsubscribe {
    return this.#listeners.add(fn);
  }
}
