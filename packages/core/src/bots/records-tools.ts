// The core tools for bots as engine data (spec §6.1; the controller's rulings 3 and the reviewer's list for lane BT),
// served in a record bot's own conversation and side threads, never an agent's or a coding session's. Owner: lane BT.
//
// * `MakeBot` (`MAKE_BOT_TOOL`, the ONE core tool a bot makes a bot with; it replaces "a bot builds a bot" through the
//   plugin builder for bots): the maker sets the new bot's name, instructions, face and model; the model defaults to the
//   maker's and must be one the person has set up. Nothing exists until the person's yes on a card that names the maker
//   and shows the new bot's name, model and instructions in full; only a yes ON THE CARD makes it (`by: "card"`). A maker
//   has at most `PROPOSALS_PER_MAKER` waiting.
// * `EditBotInstructions`: another bot's instructions, behind a card (that bot can't write the file: the fence keeps it
//   to the bot itself and its maker, who use the normal Write and Edit). The card names both bots and shows the new text
//   in full; a text too long to show is refused, never cut.
// Every value a model chose goes on the card as a code value with the hiding characters made visible; the card's own
// words are MOSS's.
import { BOT_FACE_COLORS, BOT_FACE_EYES, BOT_FACE_SHAPES, BOT_FACE_TEMPERS, MAKE_BOT_TOOL, MakeBotInput, utf16, type CardFieldName, type SealedValue, type Text } from "@waifucave/moss-protocol";
import { z } from "zod";
import type { ApprovalBroker, ApprovalDecision } from "../contracts/approval-broker";
import { isContractError } from "../contracts/common";
import type { DurableSessionHost } from "../sessions/durable-host";
import { plainOf, shownCode } from "../approvals/strings";
import type { BotService } from "./service";
import type { CoreToolDef } from "./tools";

export const EDIT_BOT_INSTRUCTIONS_TOOL = "EditBotInstructions";

/** The longest text a card shows as one code value (the protocol caps a code value at 64,000). */
export const CARD_TEXT_MAX = 60_000;

export interface RecordToolsDeps {
  bots: Pick<BotService, "records" | "settled" | "has">;
  host: Pick<DurableSessionHost, "get" | "callerOf" | "turnOrigin">;
  approvals?: Pick<ApprovalBroker, "request">;
  /** Whether the person has set a model up: a key or sign-in for it, and a plugin on that offers it. */
  setUp(model: string): boolean;
  /** Whether the session's computer is at the read-only level: then neither tool runs (read-only is absolute, as it is
   *  for the bot's own Write of its instructions). */
  readOnly?(): boolean;
}

const nameOf = (t: Text): string => (typeof t === "string" ? t : t.en);
const fail = (text: string) => ({ text, isError: true as const });
const code = (s: string): SealedValue => ({ type: "code", code: shownCode(plainOf(s).toWellFormed()) });

/** A card that ended without the person's own yes on it, in words for the bot. */
function unanswered(d: ApprovalDecision, what: string): string {
  if (d.by === "card") return `The person said no to ${what}.`;
  if (d.by === "expired") return `Nobody answered the card for ${what} in time, so nothing happened.`;
  if (d.by === "withdrawn" || d.by === "cancelled") return `The card for ${what} was withdrawn before anyone answered, so nothing happened.`;
  return `Only the person's own answer on the card allows ${what}, and it ended without one, so nothing happened.`;
}

const EditInput = z.strictObject({ bot: utf16(200, 1), instructions: utf16(200_000) });

export function recordToolDefs(deps: RecordToolsDeps, sessionId: string): CoreToolDef[] {
  const caller = () => {
    const view = deps.host.get(sessionId);
    const bot = deps.host.callerOf(sessionId).bot;
    // A bot's own conversation and side threads only: an agent it started, and a coding session, make and edit no bot.
    if (view === undefined || bot === undefined || (view.kind !== "bot" && view.kind !== "side-thread")) return undefined;
    return bot;
  };
  const ask = async (bot: string, fields: Partial<Record<CardFieldName, SealedValue>>): Promise<ApprovalDecision | undefined> => {
    if (deps.approvals === undefined) return undefined;
    return deps.approvals.request({
      kind: "confirm", session: sessionId, bot, origin: deps.host.turnOrigin(sessionId) ?? "bot", computers: [], effect: "other", fields,
    });
  };
  return [
    {
      name: MAKE_BOT_TOOL,
      description: "Makes a new bot: its name, its instructions (who it is and how it talks), and optionally a face (a shape and a colour) and a model (yours by default; it must be one the person has set up). The person decides on a card that names you; the new bot exists only after their yes, with one continuous conversation of its own, and you may then edit its instructions with Write and Edit. Returns its id, or why not.",
      inputSchema: {
        type: "object", additionalProperties: false, required: ["name"],
        properties: {
          name: { type: "string", minLength: 1, maxLength: 80, description: "The new bot's name; its id comes from it." },
          instructions: { type: "string", maxLength: 200_000, description: "Its <bot-instructions>: who it is, how it talks, what it cares about." },
          face: {
            type: "object", additionalProperties: false, description: "Pins for its living-bot face; a trait left out comes from its name.",
            properties: {
              shape: { type: "string", enum: [...BOT_FACE_SHAPES] },
              color: { type: "string", description: `One of ${BOT_FACE_COLORS.join(", ")}, or #rrggbb.` },
              eyes: { type: "string", enum: [...BOT_FACE_EYES] },
              temper: { type: "string", enum: [...BOT_FACE_TEMPERS] },
            },
          },
          model: { type: "string", maxLength: 200, description: "A qualified model id (<provider>/<model>) the person has set up; yours by default." },
        },
      },
      async run(raw) {
        const maker = caller();
        const store = deps.bots.records;
        if (deps.readOnly?.() === true) return fail("MakeBot was refused: this computer's level is read-only.");
        if (maker === undefined || store === undefined || !store.has(maker)) return fail("MakeBot works only in a bot's own conversation.");
        const parsed = MakeBotInput.safeParse(raw);
        if (!parsed.success) return fail(`MakeBot takes a name, and optionally instructions, a face and a model: ${parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}`);
        const input = parsed.data;
        if (shownCode(input.instructions ?? "").length > CARD_TEXT_MAX) return fail(`Those instructions are too long to show the person on a card (at most about ${CARD_TEXT_MAX} characters); make the bot with shorter ones, then add to them with Write and Edit.`);
        const model = input.model ?? store.get(maker)?.model;
        const setUp = model !== undefined && deps.setUp(model) ? [model] : [];
        let asked;
        try {
          asked = await store.proposeByBot(maker, input, setUp);
        } catch (err) {
          return fail(isContractError(err) ? err.message : "MakeBot failed.");
        }
        if (!("proposal" in asked)) return fail(`The bot wasn't made: ${asked.why}.`);
        const p = asked.proposal;
        // Whatever ends the ask (a refusal, a throw), the proposal never outlives it: a leaked one would hold one of the
        // maker's PROPOSALS_PER_MAKER places until a restart.
        let answered = false;
        try {
          const decision = await ask(maker, {
            title: { type: "text", text: "Make a new bot?" },
            what: { type: "text", text: "A bot of yours wants to make a new bot. A yes makes it, with these instructions and one conversation of its own; the bot that made it can then change its instructions." },
            source: code(maker),
            detail: { type: "rows", rows: [
              { label: "Name", value: plainOf(p.input.name).toWellFormed().slice(0, 4000) },
              { label: "Model", value: plainOf(p.input.model ?? "your default model").toWellFormed().slice(0, 4000) },
              ...(p.input.face === undefined ? [] : [{ label: "Face", value: plainOf([p.input.face.shape, p.input.face.color, p.input.face.eyes, p.input.face.temper].filter(Boolean).join(", ") || "from its name").slice(0, 4000) }]),
            ] },
            command: code(p.input.instructions ?? ""),
          });
          if (decision === undefined) return fail("The bot wasn't made: MOSS can't ask the person here.");
          if (!decision.allowed || decision.by !== "card") return fail(unanswered(decision, "making that bot"));
          answered = true;
          const made = await store.answerProposal(p.id, true);
          await deps.bots.settled();
          if (made.outcome !== "made") return fail("The bot wasn't made.");
          return { text: `Made ${made.id}. It has its own conversation now: message it with SendMessage, and change its instructions with Write and Edit.`, isError: false };
        } finally {
          if (!answered && store.proposals().some((x) => x.id === p.id)) await store.answerProposal(p.id, false).catch(() => undefined);
        }
      },
    },
    {
      name: EDIT_BOT_INSTRUCTIONS_TOOL,
      description: "Changes another bot's instructions, the whole text, after the person's yes on a card that shows it. Your own instructions, and those of a bot you made, you edit directly with Write and Edit instead, with no card.",
      inputSchema: {
        type: "object", additionalProperties: false, required: ["bot", "instructions"],
        properties: {
          bot: { type: "string", description: "The bot's id." },
          instructions: { type: "string", maxLength: 200_000, description: "Its new instructions, whole." },
        },
      },
      async run(raw) {
        const editor = caller();
        const store = deps.bots.records;
        if (deps.readOnly?.() === true) return fail("EditBotInstructions was refused: this computer's level is read-only.");
        if (editor === undefined || store === undefined) return fail("EditBotInstructions works only in a bot's own conversation.");
        const parsed = EditInput.safeParse(raw);
        if (!parsed.success) return fail("EditBotInstructions takes a bot's id and its new instructions.");
        const { bot, instructions } = parsed.data;
        const target = store.get(bot);
        if (target === undefined) return fail(`There is no bot ${bot}.`);
        if (shownCode(instructions).length > CARD_TEXT_MAX) return fail(`Those instructions are too long to show the person on a card (at most about ${CARD_TEXT_MAX} characters).`);
        let first;
        try {
          first = await store.writeInstructions({ kind: "bot", id: editor }, bot, instructions);
        } catch (err) {
          return fail(isContractError(err) ? err.message : "EditBotInstructions failed.");
        }
        if (first.written) {
          await deps.bots.settled();
          return { text: `${bot}'s instructions are changed; its next turn uses them.`, isError: false };
        }
        const decision = await ask(editor, {
          title: { type: "text", text: "Change another bot's instructions?" },
          what: { type: "text", text: "A bot of yours wants to replace another bot's instructions with the text below. A yes changes them from that bot's next turn." },
          source: code(editor),
          detail: { type: "rows", rows: [{ label: "Bot", value: plainOf(`${nameOf(target.name)} (${bot})`).toWellFormed().slice(0, 4000) }] },
          command: code(instructions),
        });
        if (decision === undefined) return fail("The instructions weren't changed: MOSS can't ask the person here.");
        if (!decision.allowed || decision.by !== "card") return fail(unanswered(decision, `changing ${bot}'s instructions`));
        if (!store.has(bot)) return fail(`${bot} was removed while the card waited.`);
        await store.writeInstructions({ kind: "user" }, bot, instructions);
        await deps.bots.settled();
        return { text: `${bot}'s instructions are changed; its next turn uses them.`, isError: false };
      },
    },
  ];
}
