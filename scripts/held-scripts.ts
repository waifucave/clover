// C0 review S6: scripts kept in this repo for reference that must not run from it yet. Each one builds, registers or
// publishes Winter's own artifacts under Winter's identities: the Computer Use and Headless helpers wait for opensky
// (spec §4), and Clover's release pipeline is built in C7 (spec §12). Each script calls `refuseHeldScript` before it
// reads an argument or touches anything; the lane that takes a script over removes its call.
export type HeldScript = "dev:helper" | "dev:headless" | "release" | "tap:publish";

export const HELD_SCRIPTS: Readonly<Record<HeldScript, { file: string; until: "opensky" | "C7"; why: string }>> = {
  "dev:helper": {
    file: "scripts/dev-helper.ts",
    until: "opensky",
    why: "it builds and registers the Computer Use helper as com.winter.computeruse.dev and points every Chromium browser's native-messaging manifest at this checkout, which would take over Winter Dev's helper and its screen permissions",
  },
  "dev:headless": {
    file: "scripts/dev-headless.ts",
    until: "opensky",
    why: "it builds and signs the Headless helper under Winter Dev's identity (com.winter.headless.dev)",
  },
  release: {
    file: "scripts/release.ts",
    until: "C7",
    why: "it builds and signs the retired Mac app (com.winter.app) against Winter's live update feed, and tags and publishes a release from this repo",
  },
  "tap:publish": {
    file: "scripts/publish-tap.ts",
    until: "C7",
    why: "it publishes casks to the Homebrew tap, which must not happen before Clover's own release pipeline",
  },
};

export function heldScriptRefusal(name: HeldScript): string {
  const h = HELD_SCRIPTS[name];
  return `${name} refuses to run in the Clover repo until ${h.until}: ${h.why}`;
}

/** Prints why `name` may not run here and exits 1; it never returns. Typed `void`, not `never`, so a call at a
 *  script's top level does not make the rest of that file unreachable to the type checker. */
export function refuseHeldScript(name: HeldScript, exit: (code: number) => never = (code) => process.exit(code), log: (line: string) => void = (line) => console.error(line)): void {
  log(heldScriptRefusal(name));
  exit(1);
}
