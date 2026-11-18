// WS-18 §9 / W18-19 — what "body-level on every hop" actually means, as predicates over the raw
// request bodies the loopback fakes record (Lane P fix round 1, review Major 1).
//
// A hop asserted only as "the body names the model id" proves the ROUTING and nothing else: an
// empty, rebuilt conversation on the right endpoint would pass it. What W18-19 is about is what
// TRAVELS — the prior turns, in order, and the prior model's reasoning re-rendered as data the
// destination can read, with the source's opaque state left behind. These are the three questions,
// asked of the bytes that actually went out.
//
// SDK 0.0.83 (the owner's rule: "when reasoning cant be carried natively across models and providers we just remove it"):
// an earlier model's reasoning goes into a request ONLY in its native form and ONLY where the destination takes it as it
// is (the same model on the same provider, or the same continuation domain). Everywhere else it is left out: there is no
// `<recovered_reasoning>` tag, no "prior-model reasoning, carried as data" prefix and no summary of it any more. What
// still carries is the visible text, the tool calls and their results, in order. These predicates ask the bytes that
// went out those questions: `reasoningLeaks` (nothing of another model's reasoning, no carried-as-data form) and
// `outOfOrder` (the conversation is the same conversation continued).
//
// Before 0.0.83 this file held `carriesReasoning`, which asked the opposite question (the reasoning WAS re-rendered as
// data for the destination, as a tag or a labelled prefix, with its provenance).

/**
 * The CONVERSATION part of a request body — messages/input/system — with the tool schemas left out.
 *
 * Load-bearing for the opacity check: the `advisor` tool's own description contains the literal
 * string "encrypted_content" (it says opaque state is never included in what it sends), so a
 * whole-body scan for that word reports a hit on every single request and can never fail. The
 * question is whether opaque state rode in the CONVERSATION, and this is the part that answers it.
 */
export function conversationOf(body: string): string {
  try {
    const o = JSON.parse(body) as Record<string, unknown>;
    // `instructions` is the Responses leg's system prompt (review nit) — part of the conversation,
    // and cheap to include. It carries no tool schemas, so it does not reintroduce the
    // `encrypted_content` false hit the tool list would.
    return JSON.stringify({ messages: o.messages, input: o.input, system: o.system, instructions: o.instructions });
  } catch {
    return body;
  }
}

/** The opaque-state field NAMES that must never appear in a conversation (`reasoning_item.itemJson`
 *  and friends are never rendered into a request body). Asserted on `conversationOf`, never the raw
 *  body — see that function for why. */
const OPAQUE_FIELD_NAMES = ["signature", "encrypted_content", "redacted_thinking"] as const;

/** Which opaque field names (and which caller-supplied opaque VALUES, e.g. a scripted `signature`)
 *  leaked into this body's conversation. `[]` is the required answer on every hop. */
export function opaqueLeaks(body: string, opaqueValues: readonly string[] = []): string[] {
  const conversation = conversationOf(body);
  return [
    ...OPAQUE_FIELD_NAMES.filter((name) => conversation.includes(name)),
    // A VALUE check as well as a name check: a renderer that inlined a signature's bytes without its
    // field name would pass the names-only half.
    ...opaqueValues.filter((value) => body.includes(value)),
  ];
}

/**
 * Do these needles appear in the body in THIS ORDER, each exactly where the conversation would put
 * it? Returns the needles that are missing or out of order — `[]` is the required answer.
 *
 * Order is what makes this an assertion about a CONVERSATION rather than a bag of strings: the
 * destination must receive hop 0's user turn before hop 0's assistant turn before hop 1's, or it is
 * not the same conversation continued.
 */
export function outOfOrder(body: string, needles: readonly string[]): string[] {
  const bad: string[] = [];
  let cursor = 0;
  for (const needle of needles) {
    const at = body.indexOf(needle, cursor);
    if (at === -1) bad.push(needle);
    else cursor = at + needle.length;
  }
  return bad;
}

/** What of an earlier model's reasoning is in this body: each given reasoning TEXT that appears, and each carried-as-data
 *  form the runtime used to paste in (the `<recovered_reasoning` tag, the "prior-model reasoning, carried as data"
 *  prefix). `[]` is the required answer for a destination that is not the reasoning's own model on its own provider. */
export function reasoningLeaks(body: string, texts: readonly string[] = []): string[] {
  return [
    ...texts.filter((text) => body.includes(text)).map((text) => `the reasoning text "${text}"`),
    ...(body.includes("recovered_reasoning") ? ["a recovered_reasoning tag"] : []),
    ...(body.includes("prior-model reasoning") ? ["a prior-model reasoning prefix"] : []),
  ];
}
