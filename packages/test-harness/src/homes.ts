// Temp homes: every daemon a test boots gets a fresh home under the test process's own temp root, never a real
// one. The guard below refuses any home inside a live install's folders, whatever a caller passes.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";
import { OTHER_INSTALL_HOMES, realPathOf } from "@waifucave/clover-core";

/** Folders under the user's home a test must never use, read or write: Clover's homes (the dist one and the dev
 *  profile's), the other installs' (core's `other-installs.ts`) and the agents' own (plan §9). Matched on the first path
 *  segment under the home, by prefix. */
export const PROTECTED_HOME_PREFIXES: readonly string[] = [".clover", ...OTHER_INSTALL_HOMES.map((o) => o.dir), ".claude"];

export class UnsafeHomeError extends Error {
  constructor(public readonly path: string, reason: string) {
    super(`refusing ${path} as a test home: ${reason}`);
    this.name = "UnsafeHomeError";
  }
}

/** Throws unless `path` is a safe place for a test home: not a live install's folder (`~/.clover*`, the
 *  previous products' folders, the agents'), and not the user's home itself. Links are resolved first. */
export function assertSafeTestHome(path: string, userHome: string = homedir()): void {
  const real = realPathOf(path);
  const home = realPathOf(userHome);
  if (real === home) throw new UnsafeHomeError(path, "it is the user's home");
  if (real.startsWith(home + sep)) {
    const first = real.slice(home.length + 1).split(sep)[0] ?? "";
    const hit = PROTECTED_HOME_PREFIXES.find((p) => first.startsWith(p));
    if (hit !== undefined) throw new UnsafeHomeError(path, `it is inside ~/${first}, which a test never touches`);
  }
}

export interface TempHome {
  /** The home folder: pass it as `CLOVER_HOME`, or to `startDaemon({ home })`. */
  home: string;
  /** What a child process needs to use this home: `CLOVER_HOME`, and the dist profile. */
  env: Record<string, string>;
  /** Removes the home. Safe to call twice. */
  cleanup(): void;
}

/** A fresh home under `parent` (default: the test process's temp root, which the preload removes at exit). */
export function makeTempHome(opts: { name?: string; parent?: string } = {}): TempHome {
  const parent = opts.parent ?? tmpdir();
  assertSafeTestHome(parent);
  mkdirSync(parent, { recursive: true });
  const label = (opts.name ?? "home").replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 40);
  const home = mkdtempSync(join(parent, `clover-home-${label}-`));
  assertSafeTestHome(home);
  return {
    home,
    env: { CLOVER_HOME: home, CLOVER_PROFILE: "dist" },
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}
