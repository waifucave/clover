// The island clause's fixture's host half: one command, `acceptance-island.say`, which says its text back. No network,
// no files, no other process.
export async function start(): Promise<void> {}

export async function say(args: { text?: unknown }): Promise<{ text: string }> {
  return { text: `acceptance-island-said: ${String(args?.text ?? "")}` };
}

export async function stop(): Promise<void> {}
