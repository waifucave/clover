// MOSS protocol area: one release (spec revision 19, §3.1 "One release for everything", "Where the copies are found",
// "The engine and the host, precisely"; ruling D, items 117 and 120). Owner: lane RL (install and one release). Shapes and
// refusal reasons, pinned by lane SP; nothing here is served yet.
//
// * The engine, its bundled tree, the background host and both apps run one release. The hello names the client's
//   release (`release`); the engine compares it with its own (`releaseStanding`):
//   - `same`: the connection is served as today;
//   - `behind`: refused (`MOSS_ERR.RELEASE_REFUSED`, data `ReleaseRefusal`): the app updates itself before it connects;
//   - `ahead`: served for the release door only (`RELEASE_DOOR_METHODS`): the newer app brings its engine
//     (`release.bring`), which waits until nothing is mid-work, stops the host, swaps the engine, the tree and the host,
//     and starts them again; the older app already open hears `release_changed` and updates itself.
//   A hello without `release` (today's app, the CLI, a test client) is not judged: the first build enforces it for the
//   two apps and the host only.
// * Each app records its bundle path and release under the home at every start (`AppInstallRecord`, one file per program
//   in `<home>/apps/`); the engine drops a record whose path no longer exists. The host and engine copies are found there.
// * The engine installs itself into `<home>/bin/` under one lock (`ENGINE_INSTALL_LOCK`), comparing build versions: the
//   newer copy wins, the loser just connects.
import { z } from "zod";
import { utf16 } from "./strings";
import { Ok, SemverVersion, Timestamp } from "./common";
import { coreEvent, defineEvent, defineMethod } from "./rpc";
import { Program } from "./surfaces";

/** A release as the apps, the engine and the host carry it: the `VERSION` file's semver. */
export const Release = SemverVersion;

/** A client's release against the engine's. */
export const RELEASE_STANDINGS = ["same", "behind", "ahead"] as const;
export const ReleaseStanding = z.enum(RELEASE_STANDINGS);
export type ReleaseStanding = z.infer<typeof ReleaseStanding>;

function parts(v: string): [number, number, number, string | undefined] | undefined {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4]] : undefined;
}

/** Semver order of two releases (build metadata ignored; a prerelease sorts before its release, prereleases compare by semver's identifiers): negative when `a` is older. Throws on text that isn't a release. */
export function compareReleases(a: string, b: string): number {
  const x = parts(a);
  const y = parts(b);
  if (!x || !y) throw new Error(`not a release: ${!x ? a : b}`);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (x[i] as number) - (y[i] as number);
  if (x[3] === y[3]) return 0;
  if (x[3] === undefined) return 1;
  if (y[3] === undefined) return -1;
  // Semver's order for prereleases: dot-separated identifiers, numeric ones by value (rc.9 before rc.10), a numeric one
  // before a text one, and a shorter list before a longer one it begins.
  const xs = x[3].split("."), ys = y[3].split(".");
  for (let i = 0; i < Math.max(xs.length, ys.length); i++) {
    const p = xs[i], q = ys[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) < Number(q) ? -1 : 1;
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

/** Where a client's release stands against the engine's: the range is one release wide (item 117). */
export function releaseStanding(engine: string, client: string): ReleaseStanding {
  const c = compareReleases(client, engine);
  return c === 0 ? "same" : c < 0 ? "behind" : "ahead";
}

/** `MOSS_ERR.RELEASE_REFUSED`'s data: the client is behind and must update to `needs` (the engine's release). */
export const ReleaseRefusal = z.object({ standing: z.literal("behind"), engine: Release, client: Release, needs: Release });
export type ReleaseRefusal = z.infer<typeof ReleaseRefusal>;

/** The hello's answer about the release, when the client named one: `same`, or `ahead` (the release door only). */
export const HelloRelease = z.object({ standing: z.enum(["same", "ahead"]), engine: Release });
export type HelloRelease = z.infer<typeof HelloRelease>;

/** What a connection whose client is `ahead` may call: the release door, its events and nothing else. */
export const RELEASE_DOOR_METHODS = ["release.status", "release.bring", "events.subscribe", "events.unsubscribe"] as const;

/** One app's record under the home (`<home>/apps/<program>.json`), written by the app at every start. The engine drops one
 *  whose `bundlePath` no longer exists, and starts the host from the newest app that carries it. */
export const AppInstallRecord = z.object({
  record: z.literal(1),
  program: Program,
  /** The app bundle (macOS), install folder (Windows) or AppImage/package path (Linux) it runs from. */
  bundlePath: utf16(4096, 1),
  release: Release,
  /** The build's own version, which the install lock compares when two copies carry one release. */
  build: utf16(64).optional(),
  /** The engine and the host it carries (both apps carry both, §3.1). */
  carries: z.object({ engine: z.boolean(), host: z.boolean() }),
  seenAt: Timestamp,
});
export type AppInstallRecord = z.infer<typeof AppInstallRecord>;

/** The folder of the apps' records, under the home. */
export const APP_RECORDS_DIR = "apps";
/** The engine's install lock, under the home: held while a copy installs itself into `<home>/bin/` (§3.1). */
export const ENGINE_INSTALL_LOCK = "bin/.install.lock";

/** The engine's own state of the release, for every connection that subscribed to `release`. */
export const ReleaseState = z.enum([
  /** Every live client is on the engine's release. */
  "current",
  /** A newer app asked to bring its engine; the engine waits until it is between turns and no agent runs. */
  "waiting",
  /** It is stopping the host and itself to swap in the newer engine, tree and host. */
  "switching",
]);
export type ReleaseState = z.infer<typeof ReleaseState>;

export const ReleaseChangedEvent = coreEvent("release_changed", {
  state: ReleaseState,
  engine: Release,
  /** The release a newer app brings, while waiting or switching. */
  incoming: Release.optional(),
  /** What it waits for: turns running, agents running. */
  waitingFor: z.object({ turns: z.number().int().nonnegative(), agents: z.number().int().nonnegative() }).optional(),
});

export const RELEASE_METHODS = {
  releaseStatus: defineMethod({
    name: "release.status", owner: "RL", roles: ["app", "cli"],
    params: z.object({}),
    result: z.object({
      engine: z.object({ release: Release, build: utf16(64).optional(), path: utf16(4096) }),
      apps: z.array(AppInstallRecord).max(3),
      state: ReleaseState,
      incoming: Release.optional(),
    }),
    doc: "The engine's release, the apps recorded under the home and whether a newer engine waits to come in (§3.1).",
  }),
  releaseBring: defineMethod({
    /** From a newer app (its hello `ahead`): the engine waits until nothing is mid-work, then stops the host and swaps in
     *  the engine, the tree and the host from `bundlePath`; `now` is the person's "switch now" while it waits. */
    name: "release.bring", owner: "RL", roles: ["app"], userOnly: true,
    params: z.object({ release: Release, bundlePath: utf16(4096, 1), now: z.boolean().optional() }),
    result: z.object({ state: z.enum(["waiting", "switching"]) }),
    doc: "A newer app brings its engine: the engine waits for work to finish (or switches now) and swaps itself, its tree and the host.",
  }),
  releaseRecord: defineMethod({
    /** An app's start: its record under the home, written by the engine for it (the app may also write the file
     *  itself before any engine runs). */
    name: "release.record", owner: "RL", roles: ["app"],
    params: AppInstallRecord.omit({ record: true, seenAt: true }),
    result: Ok,
    doc: "Records the calling app's bundle path and release under the home (§3.1 \"Where the copies are found\").",
  }),
} as const;

export const RELEASE_EVENTS = {
  releaseChanged: defineEvent({
    type: "release_changed", owner: "RL", roles: ["app", "cli"], schema: ReleaseChangedEvent,
    fixture: { type: "release_changed", ts: 1781270000000, state: "waiting", engine: "1.111.1", incoming: "1.111.2", waitingFor: { turns: 1, agents: 0 } },
    doc: "The engine's release state: current, waiting for work to finish before a newer engine comes in, or switching.",
  }),
} as const;
