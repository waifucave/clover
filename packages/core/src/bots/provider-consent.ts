// Asking before a bot spends a provider its plugin chose (the controller's ruling on #298's review). Owner: lane D.
//
// A bot's provider follows from its model tag (`<provider>/<model>`), and the tag may come from the bot's plugin: left
// alone, a plugin could pick any provider the user keeps a key for and spend it. A session's model is the user's own
// choice; a plugin's isn't. So:
//
// * **The user's choice asks nothing:** a model the user set for the bot (its user layer), or the user's default model
//   the bot falls back to.
// * **A plugin's choice asks once per bot and provider:** the first turn on a provider the plugin's tag names shows a
//   sealed `change` card, "<bot> wants to use <provider> (<model>) with your stored key". A yes is kept for that bot
//   and that provider only, as a grant in the bot's main conversation (the shared `SessionGrants`, lane C's card path
//   through the approval broker): its side threads and its next turns use it, and a plugin that moves its tag to a
//   new provider asks again. Only the user's answer on the card counts (`SessionGrants`, review B1).
// * **A no, or no way to ask, fails the turn** with a clear reason, and nothing reaches the provider; the user can pick
//   a model in the bot's settings. A no is asked again at the next turn.
import { CardFieldName, type SealedValue } from "@waifucave/clover-protocol";
import type { SessionGrants } from "../sessions/grants";
import { plainText, type EffectiveBot } from "./service";

/** The grant that lets a bot use a provider its plugin chose, in the bot's main conversation. */
export function providerGrantKey(provider: string): string {
  return `bot.provider:${provider}`;
}

/** The provider a model tag names (`anthropic/claude-sonnet-5-5` → `anthropic`); none for an untagged id. */
export function providerOfModel(model: string): string | undefined {
  const slash = model.indexOf("/");
  return slash > 0 ? model.slice(0, slash) : undefined;
}

export type ProviderConsent = { ok: true } | { ok: false; reason: string };

export interface BotProviderConsentOptions {
  /** The computer's one `SessionGrants` (`BotSide.grants`); without it nothing can be asked, and a plugin's provider
   *  is refused. */
  grants?: Pick<SessionGrants, "has" | "ensure">;
}

export class BotProviderConsent {
  readonly #o: BotProviderConsentOptions;

  constructor(opts: BotProviderConsentOptions) {
    this.#o = opts;
  }

  /** Whether `bot` may use its model's provider now, asking the user the first time when its plugin chose it. */
  async check(bot: EffectiveBot, mainSession: string, opts: { signal?: AbortSignal } = {}): Promise<ProviderConsent> {
    if (bot.modelFrom !== "plugin") return { ok: true };
    const provider = providerOfModel(bot.model);
    if (provider === undefined) return { ok: true };
    const name = botLabel(bot);
    const key = providerGrantKey(provider);
    const grants = this.#o.grants;
    if (grants === undefined) {
      return { ok: false, reason: `${name}'s plugin chose ${provider} (${bot.model}), and Clover can't ask you here whether it may use your stored key. Pick a model in the bot's settings.` };
    }
    if (grants.has(mainSession, key)) return { ok: true };
    const decision = await grants.ensure(mainSession, key, {
      kind: "change", change: "bot-provider", computers: [], effect: "other", fields: cardFields(bot, provider),
    }, opts.signal === undefined ? {} : { signal: opts.signal });
    if (decision.allowed) return { ok: true };
    return { ok: false, reason: `You didn't let ${name} use ${provider} (${bot.model}) with your stored key, so it didn't answer. Pick a model in the bot's settings, or say yes when it asks again.` };
  }

  /** Whether `bot` may use its model's provider now without asking (a compaction never shows a card). */
  allowedNow(bot: EffectiveBot, mainSession: string): boolean {
    if (bot.modelFrom !== "plugin") return true;
    const provider = providerOfModel(bot.model);
    return provider === undefined || (this.#o.grants?.has(mainSession, providerGrantKey(provider)) ?? false);
  }
}

function botLabel(bot: EffectiveBot): string {
  const name = plainText(bot.name).trim();
  return name === "" ? bot.id : name;
}

/** The card's sealed content: the sentence from the built-in table, and what the plugin named, as rows. */
function cardFields(bot: EffectiveBot, provider: string): Partial<Record<CardFieldName, SealedValue>> {
  const name = botLabel(bot);
  return {
    title: { type: "text", text: sealed(`Let ${name} use ${provider}?`) },
    what: { type: "text", text: sealed(`${name} wants to use ${provider} (${bot.model}) with your stored key.`) },
    reason: { type: "text", text: "The bot's plugin chose this model, not you. A yes holds for this bot and this provider only." },
    source: { type: "rows", rows: [
      { label: "Bot", value: sealed(`${name} (${bot.id})`) },
      { label: "Provider", value: sealed(provider) },
      { label: "Model", value: sealed(bot.model) },
      { label: "Chosen by", value: "The bot's plugin" },
    ] },
  };
}

/** Text for a sealed field: well formed (no lone surrogate, review N6) and within the field's room. */
function sealed(s: string): string {
  const text = s.toWellFormed();
  return text.length <= 4000 ? text : `${text.slice(0, 3999)}…`;
}
