// Asking before a bot spends a provider its plugin chose (the controller's ruling on #298's review, and #311's).
// Owner: lane D.
//
// A bot's provider follows from its model tag (`<provider>/<model>`), and the tag may come from the bot's plugin: left
// alone, a plugin could pick any provider the user keeps a key for and spend it. A session's model is the user's own
// choice; a plugin's isn't. So:
//
// * **The user's choice asks nothing:** a model the user set for the bot (its user layer), or the user's default model
//   the bot falls back to (with `hasKeyFor`, a plugin's tag the user holds no key for falls back to the default too).
// * **A plugin's choice asks once per bot and provider:** the first use of a provider the plugin's tag names shows a
//   sealed `change` card. A yes is kept for that bot and that provider only, as a grant in the bot's main conversation
//   (the shared `SessionGrants`, lane C's card path): its side threads and its next turns use it, and a plugin that
//   moves its tag to a new provider asks again. Only the user's answer on the card counts (`SessionGrants`, review B1).
// * **The same rule for what else a bot picks:** an agent it starts with a model on another provider than the bot's own
//   user-chosen one (#311 S1), and a voice provider its plugin chose that uses the user's stored voice key (`bot.voice:`).
// * **A no holds** until the user's next message of their own: until then nothing asks again, not a wake, a routine or
//   an agent's report (#311 S2); the turn fails with a clear reason, and nothing reaches the provider. With no broker
//   to ask, a plugin's provider is refused.
// * **The card is Clover's own words** (#267's house rule, #311 B2): a fixed title and sentence; the bot, the provider
//   and the model, which a plugin wrote, only as code values with every hiding character removed (`plainOf`). Its
//   origin is the asking session's turn (a side thread's own), never the main conversation's.
import type { TurnOrigin } from "@waifucave/clover-protocol";
import { CardFieldName, type SealedValue } from "@waifucave/clover-protocol";
import { plainOf } from "../approvals/strings";
import { testProviderNameFor } from "../runtime-sdk/provider-selection";
import type { SessionGrants } from "../sessions/grants";
import type { EffectiveBot } from "./service";

/** The grant that lets a bot use a provider its plugin chose, in the bot's main conversation. */
export function providerGrantKey(provider: string): string {
  return `bot.provider:${provider}`;
}

/** The grant that lets a bot use a voice provider its plugin chose. */
export function voiceGrantKey(provider: string): string {
  return `bot.voice:${provider}`;
}

/** The provider a model tag names (`anthropic/claude-sonnet-5-5` → `anthropic`); none for an untagged id, and none for
 *  the runtime's test models, which use no stored key (the provider fill gives them nothing). */
export function providerOfModel(model: string): string | undefined {
  if (testProviderNameFor(model) !== undefined) return undefined;
  const slash = model.indexOf("/");
  return slash > 0 ? model.slice(0, slash) : undefined;
}

export type ProviderConsent = { ok: true } | { ok: false; reason: string };

export interface ConsentAsk {
  signal?: AbortSignal;
  /** The session that asks (a side thread's, an agent-starting turn's): the card is its, with its turn's origin. */
  asker?: string;
  /** What started the asking turn: only the user's own message lifts a held no. */
  origin?: TurnOrigin;
}

export interface BotProviderConsentOptions {
  /** The computer's one `SessionGrants` (`BotSide.grants`); without it nothing can be asked, and a plugin's provider
   *  is refused. */
  grants?: Pick<SessionGrants, "has" | "ensure">;
}

type Subject = { what: "model" | "agent"; provider: string; model: string } | { what: "voice"; provider: string; voice: string; model?: string };

export class BotProviderConsent {
  readonly #o: BotProviderConsentOptions;
  /** The noes held until the user's next message of their own, by bot and grant. */
  readonly #declined = new Set<string>();

  constructor(opts: BotProviderConsentOptions) {
    this.#o = opts;
  }

  /** Whether `bot` may use its model's provider now, asking the user the first time when its plugin chose it. */
  check(bot: EffectiveBot, mainSession: string, opts: ConsentAsk = {}): Promise<ProviderConsent> {
    if (bot.modelFrom !== "plugin") return Promise.resolve({ ok: true });
    const provider = providerOfModel(bot.model);
    if (provider === undefined) return Promise.resolve({ ok: true });
    return this.#ask(bot, mainSession, providerGrantKey(provider), { what: "model", provider, model: bot.model }, opts);
  }

  /** Whether an agent `bot` starts may run on `model` (#311 S1): its provider is the one the user chose for the bot, or
   *  one granted for the bot; any other asks the same card, keyed to the bot. */
  checkAgentModel(bot: EffectiveBot, model: string, mainSession: string, opts: ConsentAsk = {}): Promise<ProviderConsent> {
    const provider = providerOfModel(model);
    if (provider === undefined) return Promise.resolve({ ok: true });
    if (bot.modelFrom !== "plugin" && providerOfModel(bot.model) === provider) return Promise.resolve({ ok: true });
    return this.#ask(bot, mainSession, providerGrantKey(provider), { what: "agent", provider, model }, opts);
  }

  /** Whether `bot` may use its voice's provider now (the user's stored voice key), asking when its plugin chose it. */
  checkVoice(bot: EffectiveBot, mainSession: string, opts: ConsentAsk = {}): Promise<ProviderConsent> {
    const voice = bot.voice;
    if (voice === undefined || bot.voiceFrom !== "plugin") return Promise.resolve({ ok: true });
    return this.#ask(bot, mainSession, voiceGrantKey(voice.provider), {
      what: "voice", provider: voice.provider, voice: voice.voice, ...(voice.model === undefined ? {} : { model: voice.model }),
    }, opts);
  }

  /** Whether `bot` may use its model's provider now without asking (a compaction never shows a card). */
  allowedNow(bot: EffectiveBot, mainSession: string): boolean {
    if (bot.modelFrom !== "plugin") return true;
    const provider = providerOfModel(bot.model);
    return provider === undefined || (this.#o.grants?.has(mainSession, providerGrantKey(provider)) ?? false);
  }

  async #ask(bot: EffectiveBot, mainSession: string, key: string, subject: Subject, opts: ConsentAsk): Promise<ProviderConsent> {
    const grants = this.#o.grants;
    const what = describe(subject);
    if (grants === undefined) {
      return { ok: false, reason: `This bot's plugin chose ${what}, and Clover can't ask you here whether it may use your stored key. Pick it in the bot's settings.` };
    }
    if (grants.has(mainSession, key)) return { ok: true };
    const held = `${bot.id}\u0000${key}`;
    if (this.#declined.has(held)) {
      // A no holds until the user's next message of their own (#311 S2).
      if (opts.origin !== "user") return { ok: false, reason: declined(what) };
      this.#declined.delete(held);
    }
    const decision = await grants.ensure(mainSession, key, { kind: "change", change: "bot-provider", computers: [], effect: "other", fields: cardFields(bot, subject) }, {
      ...(opts.signal === undefined ? {} : { signal: opts.signal }),
      ...(opts.asker === undefined ? {} : { asker: opts.asker }),
    });
    if (decision.allowed) return { ok: true };
    this.#declined.add(held);
    return { ok: false, reason: declined(what) };
  }
}

/** What the plugin chose, in the reason's words: never its own text, only the kind. */
function describe(subject: Subject): string {
  if (subject.what === "voice") return "a voice provider";
  if (subject.what === "agent") return "a model for an agent on a provider you didn't choose for it";
  return "a model on a provider you didn't choose";
}

function declined(what: string): string {
  return `You didn't let this bot use ${what} with your stored key, so it didn't go ahead. Pick it in the bot's settings, or say yes when it asks again after your next message.`;
}

/** The card: Clover's own title and sentence, and what the plugin wrote only as code values (#267's house rule). */
function cardFields(bot: EffectiveBot, subject: Subject): Partial<Record<CardFieldName, SealedValue>> {
  const voice = subject.what === "voice";
  const chosen = subject.what === "voice" ? `${subject.voice}${subject.model === undefined ? "" : ` (${subject.model})`}` : subject.model;
  return {
    title: { type: "text", text: voice ? "Let this bot use a voice provider its plugin chose?" : "Let this bot use a provider its plugin chose?" },
    what: {
      type: "text",
      text: voice
        ? "This bot's plugin, not you, chose a voice whose provider uses your stored key. A yes lets this bot use that provider with your key, and no other bot or provider."
        : subject.what === "agent"
          ? "This bot wants to start an agent on a model whose provider uses your stored key, and you didn't choose that provider for it. A yes lets this bot use that provider with your key, and no other bot or provider."
          : "This bot's plugin, not you, chose a model whose provider uses your stored key. A yes lets this bot use that provider with your key, and no other bot or provider.",
    },
    reason: { type: "text", text: "You can choose the model or voice yourself in the bot's settings instead: then nothing asks." },
    source: { type: "code", code: sealedCode(`${bot.id}`) },
    host: { type: "code", code: sealedCode(subject.provider) },
    command: { type: "code", code: sealedCode(chosen) },
  };
}

/** A plugin's text as a sealed code value: every hiding character removed (`plainOf`), well formed, within its room. */
function sealedCode(s: string): string {
  const text = plainOf(s).toWellFormed();
  return text.length <= 4000 ? text : `${text.slice(0, 3999)}…`;
}
