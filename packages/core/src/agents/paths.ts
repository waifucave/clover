// The paths an agent's permission request names, as the fence compares them (review 8): the fence's items are
// absolute and canonical, so a relative path, a `~` path, a `file:` URL or a path through a symbolic link would
// otherwise never match one, and would skip the broker's rule 3 (a fenced path is always a card).
//
// Each path is resolved against the agent's root, and its real path is added where it differs: the path itself
// where it exists, else its deepest existing folder's real path with the rest appended (a file about to be created
// through a linked folder).
//
// Every path is checked, not just the first few (check 2's minor 1: a cap let a fenced path hide behind 200 harmless
// ones). A request naming more than `MAX_CHECKED_PATHS` is `over`, and the agent manager refuses it without a card.
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The most paths one request may name; past it the request is refused. */
export const MAX_CHECKED_PATHS = 10_000;

export function agentPaths(paths: readonly string[], root: string, home: string = homedir()): { paths: string[]; over: boolean } {
  if (paths.length > MAX_CHECKED_PATHS) return { paths: [], over: true };
  const out = new Set<string>();
  for (const raw of paths) {
    // Not a path any file system has: nothing to check, and nothing the agent can reach through it.
    if (typeof raw !== "string" || raw.length === 0 || raw.length > 4096 || raw.includes("\0")) continue;
    let p = raw;
    if (p.startsWith("file://")) {
      try {
        p = fileURLToPath(p);
      } catch {
        continue;
      }
    }
    if (p === "~") p = home;
    else if (p.startsWith("~/")) p = join(home, p.slice(2));
    const abs = resolve(root, p);
    out.add(abs);
    const real = realOf(abs);
    if (real !== undefined && real !== abs) out.add(real);
  }
  return { paths: [...out], over: false };
}

function realOf(abs: string): string | undefined {
  const rest: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      return join(realpathSync(cur), ...rest);
    } catch {
      const up = dirname(cur);
      if (up === cur) return undefined;
      rest.unshift(basename(cur));
      cur = up;
    }
  }
}
