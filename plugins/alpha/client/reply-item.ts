// What the pin under her replies reads of the conversation's item (`conversation.message.extra`'s `item`). Pure, so
// her tab's suite tests it (`pin-reply.tsx` is where it is used).

/** The reply's text, when the item is one of her finished replies; undefined otherwise (a user's message, one still
 *  arriving, an empty one, a tool row). */
export function pinnableText(item: unknown): string | undefined {
  const i = item as { kind?: unknown; text?: unknown; streaming?: unknown } | null | undefined;
  if (typeof i !== "object" || i === null || i.kind !== "bot" || i.streaming === true || typeof i.text !== "string" || i.text.trim() === "") return undefined;
  return i.text;
}
