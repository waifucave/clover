// The router row's fixture's host half: one command, `acceptance-router.say`, which says its text back. No network, no
// files, no other process.
export async function start(): Promise<void> {}

export async function say(args: { text?: unknown }): Promise<{ text: string }> {
  return { text: `acceptance-router-said: ${String(args?.text ?? "")}` };
}

export async function stop(): Promise<void> {}
