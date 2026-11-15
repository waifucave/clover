// The acceptance UI fixture's host half: one command, `ping`, bound to a key chord in its manifest. Run (by the key, in
// the window), it tells its page `pinged` with a count, which the page shows: the press reached main, `command.run`
// reached this handler, and the handler reached the page.
let api: { ui?: { send(event: string, data?: unknown): void } } | undefined;
let count = 0;

export async function start(a: unknown): Promise<void> {
  api = a as typeof api;
}

export async function ping(): Promise<{ count: number }> {
  count += 1;
  api?.ui?.send("pinged", { count });
  return { count };
}

export async function stop(): Promise<void> {}
