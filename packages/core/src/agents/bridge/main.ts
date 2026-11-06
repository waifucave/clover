// The bridge process's entry: `clover-core bridge` in the shipped daemon binary, `bun bridge/main.ts` from source.
// The binary's argv dispatch belongs to the daemon's entry (a question for lane M with C); `bridgeCommand()` says
// which form this daemon hands agents.
import { join } from "node:path";
import { runBridge } from "./server";

export const BRIDGE_MAIN_PATH = join(import.meta.dir, "main.ts");

/** True inside a `bun build --compile` binary, whose modules live under `/$bunfs/` (`B:/~BUN/` on Windows). */
export function isCompiled(): boolean {
  return import.meta.path.startsWith("/$bunfs/") || import.meta.path.includes("~BUN");
}

/** How an agent starts the bridge: this daemon's binary with `bridge`, or bun with this file from source. */
export function bridgeCommand(): { command: string; args: string[] } {
  return isCompiled() ? { command: process.execPath, args: ["bridge"] } : { command: process.execPath, args: [BRIDGE_MAIN_PATH] };
}

/** Runs the bridge on this process's stdio; resolves when the agent closes stdin. */
export async function bridgeMain(): Promise<void> {
  const run = runBridge(process.env, {
    onInput: (fn, end) => {
      process.stdin.on("data", (c: Buffer) => fn(c));
      process.stdin.on("end", end);
      process.stdin.on("close", end);
    },
    output: (line) => {
      process.stdout.write(line);
    },
    log: (line) => {
      process.stderr.write(`${line}\n`);
    },
    connect: async (path, onData, onClose) => {
      // Bun may take part of a write; the rest waits for `drain`.
      const queue: Uint8Array[] = [];
      const flush = (s: { write(b: Uint8Array): number }) => {
        while (queue.length > 0) {
          const head = queue[0]!;
          const n = s.write(head);
          if (n < head.length) {
            queue[0] = head.subarray(Math.max(0, n));
            return;
          }
          queue.shift();
        }
      };
      const sock = await Bun.connect({
        unix: path,
        socket: {
          data: (_s, chunk) => onData(chunk),
          drain: (s) => flush(s),
          close: () => onClose(),
          error: () => onClose(),
        },
      });
      return {
        write: (line) => {
          queue.push(new TextEncoder().encode(line));
          if (queue.length === 1) flush(sock);
        },
        close: () => sock.end(),
      };
    },
  });
  await run.done;
  process.exit(0);
}

if (import.meta.main) await bridgeMain();
