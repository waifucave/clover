// The site an acting Browser call was approved for. The approval check reads the host of the bot's tab and keeps it
// here under the session; the tool asks for it (`browser.toolCaller`, once per tool call) and refuses to act if the page
// has moved to another host since, so a card or a kept answer for one site never lets an action land on another.
const checked = new Map<string, string>();

/** The approval check's: this session's acting call was checked against `host` (or, with none, against no site). */
export function noteCheckedHost(sessionId: string, host: string | undefined): void {
  if (host === undefined) checked.delete(sessionId);
  else checked.set(sessionId, host);
}

/** The tool's: the host the session's last acting call was checked against, once. */
export function takeCheckedHost(sessionId: string): string | undefined {
  const host = checked.get(sessionId);
  checked.delete(sessionId);
  return host;
}
