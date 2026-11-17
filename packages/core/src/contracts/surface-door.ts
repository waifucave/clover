// Contract: SurfaceDoor (spec revision 19, §3.1 "Client kinds", §3.4 "Mount lists"; G1). Owner: lane RT, with lane HS
// for the host's half and lane RL for the release a copy carries.
//
// Which surface an `app` connection is, and what the engine mounts there. The hello's `surface` (absent: `code`) picks a
// mount list and grants no method. The program a connection belongs to (for its answer key and its press record) is its
// signed identity on macOS, never the hello's word; on Windows and Linux the surface stands in for it.
//
// What the contract promises:
// * `surface` on any role but `app` is refused (`not-app`); an `app` hello without one is `code`.
// * One live `host` per home: a second is refused (`second-host`) until the first connection closes.
// * Where a signed identity is known (macOS), a surface that isn't the identity's program is refused (`program-mismatch`).
// * Two live copies of one window program: the older release stops (`older-copy` for a newcomer that is older; a
//   newcomer that is newer is admitted and names the older connection in `stop`). Copies on one release both run.
// * Mounts: `SURFACE_MOUNTS`, except that while the background host isn't built (`legacy`) a `code` window mounts the
//   screen's points too (`LEGACY_CODE_MOUNTS`), as today's app does.
import type { MossRole, MountList, Program, Surface, SurfaceRefusal } from "@waifucave/moss-protocol";
import type { Unsubscribe } from "./common";

export interface SurfaceClient {
  connId: number;
  role: MossRole;
  /** The hello's word. */
  surface?: Surface;
  /** The connection's signed program, where the OS has one (macOS); undefined elsewhere. */
  signed?: Program;
  /** The client's release, when its hello named one. */
  release?: string;
}

export type SurfaceAdmission =
  | { ok: true; surface: Surface; program: Program; mount: MountList; stop: number[] }
  | { ok: false; refusal: SurfaceRefusal };

export interface LiveSurface {
  connId: number;
  surface: Surface;
  program: Program;
  release?: string;
}

export interface SurfaceDoor {
  /** An `app` hello (or any other role's, to refuse a `surface` on it). Non-`app` roles are admitted with no surface:
   *  `admit` answers `ok: false` only for a refusal. */
  admit(client: SurfaceClient): SurfaceAdmission | { ok: true; surface: undefined };
  /** The connection closed. */
  closed(connId: number): void;
  live(): LiveSurface[];
  /** The program a connection's answers and presses belong to. */
  programOf(connId: number): Program | undefined;
  watch(fn: (live: LiveSurface[]) => void): Unsubscribe;
}
