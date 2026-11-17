// Contract: ReleaseHome (spec revision 19, §3.1 "One release for everything", "Where the copies are found"; ruling D,
// items 117 and 120). Owner: lane RL (install and one release).
//
// The engine, its bundled tree, the background host and both apps run one release. This contract holds the engine's
// side of that: judging a hello's release, the apps' records under the home, and installing a copy of the engine into
// `<home>/bin/` under one lock.
//
// What the contract promises:
// * `judge`: a hello with no release isn't judged (`served`); the same release is served; an older one is refused with
//   the release it needs (`ReleaseRefusal`); a newer one is served through the release door only (`RELEASE_DOOR_METHODS`).
// * `record` keeps one record per program, the latest; `apps` drops a record whose bundle no longer exists; `hostSource`
//   is the newest app that carries the host (a release tie goes to the later record).
// * `install` runs under the install lock, one at a time: a copy replaces the installed engine only with a newer
//   release, or the same release and a newer build; otherwise it doesn't install and just connects (`installed: false`).
import type { AppInstallRecord, ReleaseRefusal } from "@waifucave/moss-protocol";

export type ReleaseJudgment =
  | { kind: "served"; standing?: "same" }
  | { kind: "door"; standing: "ahead"; engine: string }
  | { kind: "refused"; refusal: ReleaseRefusal };

export interface EngineCopy {
  release: string;
  /** The build's own version, compared on a release tie. */
  build?: string;
  /** Where the copy comes from (the app bundle that carries it). */
  from: string;
}

export interface ReleaseHome {
  /** The running engine's release. */
  readonly engine: string;
  judge(client: string | undefined): ReleaseJudgment;
  /** Whether a connection with the release door only may call `method`. */
  doorAllows(method: string): boolean;
  record(app: Omit<AppInstallRecord, "record" | "seenAt">): AppInstallRecord;
  apps(): AppInstallRecord[];
  hostSource(): AppInstallRecord | undefined;
  install(copy: EngineCopy): Promise<{ installed: boolean; current: EngineCopy }>;
  installed(): EngineCopy | undefined;
}
