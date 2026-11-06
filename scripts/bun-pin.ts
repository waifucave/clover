// The Bun a build runs on must be the one `.bun-version` pins, because CI tests that one. These are the checks
// that the release (`release.ts`), the daemon build (`build-daemon.ts`) and the dev daemon (`dev-daemon.ts`) share.
// `scripts/pinned-bun` runs the pinned Bun beside any other one (`scripts/pinned-bun run build:daemon`).
import { readFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

/** The version in `<root>/.bun-version`. */
export function pinnedBunVersion(root: string): string {
  return readFileSync(join(root, ".bun-version"), "utf8").trim();
}

/** Null when `running` is the pinned Bun, else the reason, for a check's message. */
export function bunPinProblem(root: string, running: string = Bun.version): string | null {
  const pinned = pinnedBunVersion(root);
  return running === pinned ? null : `this bun is ${running} but .bun-version pins ${pinned}`;
}

/**
 * `env` with the running Bun's folder first on PATH. `bun run` does not put its own Bun first, so a package
 * script's `bun build` would otherwise run whichever Bun PATH finds, not the one these scripts checked.
 */
export function thisBunFirst(env: NodeJS.ProcessEnv, execPath: string = process.execPath): NodeJS.ProcessEnv {
  const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  const rest = env[key];
  return { ...env, [key]: rest ? `${dirname(execPath)}${delimiter}${rest}` : dirname(execPath) };
}
