// This engine's build stamp: when the build was made, as UTC `YYYYMMDDHHMMSS`. A release build (`scripts/build-daemon.ts`)
// compiles it in with `--define __MOSS_ENGINE_BUILD__=<the 14 digits>` (a bare number: nothing to quote on any shell); every
// other run (a checkout under Bun, a test, the dev daemon) has none and reads `undefined`. It is the build the engine install
// records in `<home>/bin/engine.json` and compares when two copies carry one release (`update/engine-copy.ts`'s
// `isNewerCopy`): a later build of the same release replaces an earlier one, an earlier or equal one doesn't. Fixed width, so
// numeric order is time order.
declare const __MOSS_ENGINE_BUILD__: number | false | undefined;

export const ENGINE_BUILD: string | undefined = typeof __MOSS_ENGINE_BUILD__ === "number" && /^\d{14}$/.test(String(__MOSS_ENGINE_BUILD__)) ? String(__MOSS_ENGINE_BUILD__) : undefined;
