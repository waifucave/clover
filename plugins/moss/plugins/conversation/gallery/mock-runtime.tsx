// A pretend core for the gallery and the tests: the SDK's own test layer (`ui/testing`), with the cards the conversation
// places pending and each sealed frame showing what the core's sealed page would (a field's words, a button's label).
// The words are the MOCK CORE's, in the sealed frames' pages, never the conversation plugin's: the split the app keeps
// (spec §5.5).
import { card as cardMeta, fakeApprovals, runtimeWith, type TestRuntime } from "@waifucave/moss-plugin-sdk/ui/testing";
import type { CardFieldProps, CardMeta } from "@waifucave/moss-plugin-sdk";

type SealedField = CardFieldProps["name"];
export type SealedCardData = Partial<Record<SealedField, string>>;

/** The mock core's option labels, by option id. */
const LABELS: Record<string, string> = {
  allow_once: "Allow once",
  allow_always: "Always allow",
  deny: "Deny",
  approve: "Approve",
  open_link: "Open link",
  decline: "Decline",
};

/** An option's kind, by its id (the mock core's options). */
const KIND: Record<string, "approve" | "deny"> = { allow_once: "approve", allow_always: "approve", approve: "approve", open_link: "approve", deny: "deny", decline: "deny" };

export interface MockRuntimeOptions {
  /** What each card's sealed fields say, by card id: each is pending. */
  cards?: Record<string, SealedCardData>;
  /** A card's options, by card id (else deny and approve). */
  options?: Record<string, readonly string[]>;
  /** The cards still waiting (else every card in `cards`): an answered one is no longer pending in the core. */
  pending?: readonly string[];
}

/** A pending card as the core would list it, with its options. */
export function mockCard(id: string, options: readonly string[] = ["deny", "approve"]): CardMeta {
  return cardMeta(id, { options: options.map((o) => ({ id: o, kind: KIND[o] ?? "approve" })) as CardMeta["options"] });
}

/** A test layer with the cards pending and their sealed frames' words. */
export function mockRuntime(options: MockRuntimeOptions = {}, extra: Partial<TestRuntime> = {}): TestRuntime {
  const cards = options.cards ?? {};
  return runtimeWith({
    approvals: fakeApprovals((options.pending ?? Object.keys(cards)).map((id) => mockCard(id, options.options?.[id]))),
    sealedText: (cardId, element) => {
      const [kind, name] = element.split(":") as ["field" | "button", string];
      return kind === "field" ? cards[cardId]?.[name as SealedField] : LABELS[name] ?? name;
    },
    ...extra,
  });
}
