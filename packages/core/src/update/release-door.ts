// The hello's release check (spec §3.1 "One release for everything"; item 117; reviewer's addition 1). RL's. Pure: the
// engine's hello (`ipc/moss.ts`) asks `judgeHello` once the caller is known, and `doorMessage` for a call on a connection
// that was only given the release door.
//
//   * An `app` hello (MOSS, MOSS Code, the host) is always judged once enforcement is on, so an old app that sends no
//     `release` counts as behind: it would otherwise skip the rule. Any other role is judged only when it names a release
//     (the CLI and a test client are not apps).
//   * same: served as today, and the result says so. behind: refused with `ReleaseRefusal` (what it needs). ahead: served
//     the release door only (`RELEASE_DOOR_METHODS`) until its engine is in.
import { MOSS_ERR, type HelloRelease, type MossRole, type ReleaseRefusal } from "@waifucave/moss-protocol";
import type { ReleaseHome } from "../contracts/release-home";

/** What an app that names no release is taken to run: older than any release. */
export const NO_RELEASE = "0.0.0";

export type HelloVerdict =
  | { kind: "unjudged" }
  | { kind: "served"; release: HelloRelease }
  | { kind: "door"; release: HelloRelease }
  | { kind: "refused"; refusal: ReleaseRefusal };

export function judgeHello(home: ReleaseHome, hello: { role: MossRole; release?: string | undefined }, enforce: boolean): HelloVerdict {
  if (!enforce) return { kind: "unjudged" };
  if (hello.release === undefined && hello.role !== "app") return { kind: "unjudged" };
  const j = home.judge(hello.release ?? NO_RELEASE);
  if (j.kind === "refused") return { kind: "refused", refusal: j.refusal };
  if (j.kind === "door") return { kind: "door", release: { standing: "ahead", engine: j.engine } };
  return { kind: "served", release: { standing: "same", engine: home.engine } };
}

/** The refusal a behind client is given. */
export function refusalMessage(r: ReleaseRefusal): string {
  return `this MOSS is on release ${r.engine} and the app is on ${r.client}: update the app to ${r.needs}`;
}

/** A call on a connection that has the release door only. */
export function doorMessage(method: string, engine: string): string {
  return `this app is newer than the engine (release ${engine}): ${method} waits until the engine is brought in (release.bring)`;
}

export const DOOR_REFUSED_CODE = MOSS_ERR.ROLE_REFUSED;
