// The test-marked release build (`scripts/release/build.ts --test-build`): a Developer ID signed, never notarized
// Clover.app whose core and app take a throwaway keychain file and a temp home, so an agent can run the acceptance
// script against a packaged build without the login keychain.
//
// The marker is COMPILE-TIME only: the `__CLOVER_TEST_BUILD__` define, which every release build passes, `false` for a
// real build and the label for a test one (the core's `bun build` steps through scripts/build-daemon.ts, the app's
// main process through apps/desktop/scripts/build.ts). Nothing at run time (an environment variable, an argument, a
// file, a setting, a plugin) can set it. Each test-only branch tests the define in its own module
// (`typeof __CLOVER_TEST_BUILD__ === "string"`), which Bun folds, so in a real build the branch and every function only
// it calls are gone from the bytes. `testBuildMarkerProblems` proves that on every build: a real one carries neither
// the label (which only the define puts there) nor the sentinel (a phrase only the test-only code says), and a test
// one carries both.
//
// The label and the sentinel live here, in a script, never in packages/core or apps/desktop source: the label must
// reach a binary only through the define.

/** The define's value in a test build: one token, no spaces or quotes beyond the JSON string's own. */
export const TEST_BUILD_LABEL = "CLOVER-TEST-BUILD";

/** A phrase only the test-only code says (its refusals and its version line): the dead-code half of the gate. */
export const TEST_BUILD_SENTINEL = "test-marked build";

/** The define's name. */
export const TEST_BUILD_DEFINE_NAME = "__CLOVER_TEST_BUILD__";

/** The source acceptance's own build of the app (apps/desktop/scripts/build.ts --acceptance): its define and label,
 *  `false` in every other build, a release's and the test twin's included. */
export const ACCEPTANCE_BUILD_DEFINE_NAME = "__CLOVER_ACCEPTANCE_BUILD__";
export const ACCEPTANCE_BUILD_LABEL = "CLOVER-ACCEPTANCE-BUILD";
export function acceptanceBuildDefine(acceptance: boolean): Record<string, string> {
  return { [ACCEPTANCE_BUILD_DEFINE_NAME]: acceptance ? JSON.stringify(ACCEPTANCE_BUILD_LABEL) : "false" };
}

/** The release build's own define (apps/desktop/scripts/build.ts --release, which release/build.ts passes for every
 *  build but the test twin): `__CLOVER_RELEASE_BUILD__`, the label in a release-shaped build (signed, sign-only,
 *  dev-signed, CI's unsigned), `false` in a test twin, an acceptance build and a dev build. It is for the app's
 *  "packaged" decision, which must not rest on the executable's name alone (Electron's `app.isPackaged` is false for an
 *  executable named `electron`); until that helper reads it, the main bundle carries the label in a leading comment
 *  (`RELEASE_BUILD_BANNER`), so the gate below can see that the release build reached the main process. */
export const RELEASE_BUILD_DEFINE_NAME = "__CLOVER_RELEASE_BUILD__";
export const RELEASE_BUILD_LABEL = "CLOVER-RELEASE-BUILD";
export function releaseBuildDefine(release: boolean): Record<string, string> {
  return { [RELEASE_BUILD_DEFINE_NAME]: release ? JSON.stringify(RELEASE_BUILD_LABEL) : "false" };
}
/** The main bundle's first line in a release build (Bun.build's `banner`). */
export const RELEASE_BUILD_BANNER = `/* ${RELEASE_BUILD_LABEL}: the main process of a release build (${RELEASE_BUILD_DEFINE_NAME}) */`;

/** The release gate on an app.asar: a release-shaped build's main process (out/main/index.js) carries the release
 *  label, and nothing in a test twin's or an acceptance build's app.asar does. */
export function releaseMarkerProblems(what: string, bytes: Uint8Array, release: boolean): string[] {
  const files = asarFiles(bytes);
  const main = files.get("out/main/index.js");
  if (release) {
    if (main === undefined) return [`${what} has no out/main/index.js to read the release label in`];
    return contains(main, RELEASE_BUILD_LABEL) ? [] : [`${what}'s main process doesn't carry the release label ${RELEASE_BUILD_LABEL} (apps/desktop/scripts/build.ts --release didn't reach it)`];
  }
  return contains(bytes, RELEASE_BUILD_LABEL) ? [`${what} carries the release label ${RELEASE_BUILD_LABEL}: a test twin or an acceptance build never does`] : [];
}

/** What only the test-only code of the app reads: the environment variables that pick the kept test answer key and
 *  allow the offscreen press. A real build's app code carries none of them (nor the acceptance label). */
export const TEST_ONLY_APP_STRINGS = ["CLOVER_TEST_ANSWER_KEY", "CLOVER_TEST_SEALED_PRESS"] as const;

/** The `bun build --define` argument for a shell line: `false` in a real build (no quotes, so cmd.exe takes it), the
 *  label as a JSON string in a test build (macOS only, /bin/sh). */
export function testBuildDefineArg(test: boolean): string {
  return test ? `'${TEST_BUILD_DEFINE_NAME}="${TEST_BUILD_LABEL}"'` : `${TEST_BUILD_DEFINE_NAME}=false`;
}

/** `Bun.build`'s `define` entry. */
export function testBuildDefine(test: boolean): Record<string, string> {
  return { [TEST_BUILD_DEFINE_NAME]: test ? JSON.stringify(TEST_BUILD_LABEL) : "false" };
}

function contains(bytes: Uint8Array, text: string): boolean {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).includes(Buffer.from(text, "utf8"));
}

/** Whether these bytes carry the test-build label or the sentinel. */
export function carriesTestBuild(bytes: Uint8Array): boolean {
  return contains(bytes, TEST_BUILD_LABEL) || contains(bytes, TEST_BUILD_SENTINEL);
}

/** The gate: a real build's `what` carries neither the label nor the sentinel; a test build's carries both. */
export function testBuildMarkerProblems(what: string, bytes: Uint8Array, test: boolean): string[] {
  const label = contains(bytes, TEST_BUILD_LABEL);
  const sentinel = contains(bytes, TEST_BUILD_SENTINEL);
  if (test) {
    return [
      ...(label ? [] : [`${what} is a test build but doesn't carry the label ${TEST_BUILD_LABEL} (the define didn't reach it)`]),
      ...(sentinel ? [] : [`${what} is a test build but doesn't carry the test-only code ("${TEST_BUILD_SENTINEL}")`]),
    ];
  }
  return [
    ...(label ? [`${what} carries the test-build label ${TEST_BUILD_LABEL}: a real build never does`] : []),
    ...(sentinel ? [`${what} carries the test-only code ("${TEST_BUILD_SENTINEL}"): a real build's test branch must be compiled out`] : []),
  ];
}

interface AsarNode { files?: Record<string, AsarNode>; size?: number; offset?: string; unpacked?: boolean }

/** The packed files of an `app.asar` (Electron's format: a pickled JSON header, then the files' bytes), by path. The
 *  unpacked ones (in `app.asar.unpacked`) aren't in it. Throws on a file that isn't one. */
export function asarFiles(bytes: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 16 || view.getUint32(0, true) !== 4) throw new Error("not an asar archive");
  const headerSize = view.getUint32(4, true);
  const jsonLength = view.getUint32(12, true);
  if (16 + jsonLength > bytes.length || 8 + headerSize > bytes.length) throw new Error("an asar archive cut short");
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(16, 16 + jsonLength))) as AsarNode;
  const base = 8 + headerSize;
  const out = new Map<string, Uint8Array>();
  const walk = (node: AsarNode, at: string) => {
    for (const [name, child] of Object.entries(node.files ?? {})) {
      const path = at === "" ? name : `${at}/${name}`;
      if (child.files !== undefined) walk(child, path);
      else if (child.unpacked !== true && child.offset !== undefined && child.size !== undefined) {
        const start = base + Number(child.offset);
        if (start + child.size > bytes.length) throw new Error(`${path} runs past the asar archive's end`);
        out.set(path, bytes.subarray(start, start + child.size));
      }
    }
  };
  walk(header, "");
  return out;
}

/** The gate on an app's `app.asar`: the label is checked over every byte (only the define puts it there); the
 *  test-only code over the files that run, not the source maps (whose `sourcesContent` is the source, test branch
 *  included, in every build). */
export function asarMarkerProblems(what: string, bytes: Uint8Array, test: boolean): string[] {
  const files = asarFiles(bytes);
  const code = [...files].filter(([path]) => !path.endsWith(".map"));
  const label = contains(bytes, TEST_BUILD_LABEL);
  const sentinel = code.some(([, b]) => contains(b, TEST_BUILD_SENTINEL));
  if (test) {
    return [
      ...(label ? [] : [`${what} is a test build but doesn't carry the label ${TEST_BUILD_LABEL} (the define didn't reach it)`]),
      ...(sentinel ? [] : [`${what} is a test build but its code doesn't carry the test-only branch ("${TEST_BUILD_SENTINEL}")`]),
    ];
  }
  const testOnly = TEST_ONLY_APP_STRINGS.filter((t) => code.some(([, b]) => contains(b, t)));
  return [
    ...(label ? [`${what} carries the test-build label ${TEST_BUILD_LABEL}: a real build never does`] : []),
    ...(sentinel ? [`${what}'s code carries the test-only branch ("${TEST_BUILD_SENTINEL}"): a real build's must be compiled out`] : []),
    ...(contains(bytes, ACCEPTANCE_BUILD_LABEL) ? [`${what} carries the acceptance build's label ${ACCEPTANCE_BUILD_LABEL}: a real build never does`] : []),
    ...testOnly.map((t) => `${what}'s code reads ${t}: a real build's test-only path must be compiled out`),
  ];
}
