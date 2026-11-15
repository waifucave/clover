// The acceptance fixture for plugin triggers (§7): a routine file that names `acceptance-ping` arms it, and it fires
// that routine once, at once, through the API its start was given. No network, no files, no other process.
let api: { routines?: { fire(routine: string, type: string, payload?: string): Promise<void> } } | undefined;
const fired = new Set<string>();

export async function start(given: NonNullable<typeof api>): Promise<void> {
  api = given;
}

export const ping = {
  arm(args: { routine: string }): void {
    console.log(`acceptance-trigger: armed ${args.routine}`);
    if (fired.has(args.routine)) return;
    fired.add(args.routine);
    setTimeout(() => {
      api?.routines?.fire(args.routine, "acceptance-ping", "ACCEPTANCE-PINGED").catch((err: Error) => console.log(`acceptance-trigger: fire failed: ${err.message}`));
    }, 0);
  },
  disarm(args: { routine: string }): void {
    console.log(`acceptance-trigger: disarmed ${args.routine}`);
  },
};
