// The hello's release check (spec §3.1 "One release for everything"; item 117; reviewer's addition 1). RL's. Pure: the
// engine's hello (`ipc/moss.ts`) asks `judgeHello` once the caller is known, and `doorMessage` for a call on a connection
// that was only given the release door.
//
//   * An `app` hello (MOSS, MOSS Code, the host) is always judged once enforcement is on, so an old app that sends no
//     `release` counts as behind: it would otherwise skip the rule. Any other role is judged only when it names a release
//     (the CLI and a test client are not apps).
//   * same: served as today, and the result says so. behind: refused with `ReleaseRefusal` (what it needs). ahead: served
//     the release door only (`RELEASE_DOOR_METHODS`) until its engine is in.
import { DEFAULT_SURFACE, MOSS_ERR, SURFACE_MOUNTS, type HelloRelease, type MossRole, type Program, type ReleaseRefusal } from "@waifucave/moss-protocol";
import type { SurfaceAdmission } from "../contracts/surface-door";
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

/** The refusal a behind client is given. An app that named no release is "an older app", never the placeholder. */
export function refusalMessage(r: ReleaseRefusal): string {
  return `this MOSS is on release ${r.engine} and ${r.client === NO_RELEASE ? "an older app" : `the app is on ${r.client}`}: update the app to ${r.needs}`;
}

/**
 * The admission of a connection that holds the release door only (an app AHEAD of the engine). It is NOT put in the surface
 * door's live set: an inert app must not hold the one host slot, count as the island's drawer (the router would place cards on
 * a window that can't draw them), be compared with the live copies of its program (it would make the working older copy
 * quit before the engine is switched), or report presence. The program is still the signed identity where there is one, and a
 * surface that isn't it is still refused, so `release.bring` and `release.record` key on a program the OS vouched for.
 */
export function inertAdmission(client: { role: MossRole; surface?: string | undefined; signed?: Program | undefined }): SurfaceAdmission | { ok: true; surface: undefined } {
  if (client.role !== "app") {
    if (client.surface !== undefined) return { ok: false, refusal: { reason: "not-app", surface: client.surface as never } };
    return { ok: true, surface: undefined };
  }
  const surface = (client.surface ?? DEFAULT_SURFACE) as Program;
  if (client.signed !== undefined && client.signed !== surface) return { ok: false, refusal: { reason: "program-mismatch", surface } };
  return { ok: true, surface, program: client.signed ?? surface, mount: SURFACE_MOUNTS[surface], stop: [] };
}

/** A call on a connection that has the release door only. */
export function doorMessage(method: string, engine: string): string {
  return `this app is newer than the engine (release ${engine}): ${method} waits until the engine is brought in (release.bring)`;
}

export const DOOR_REFUSED_CODE = MOSS_ERR.ROLE_REFUSED;
