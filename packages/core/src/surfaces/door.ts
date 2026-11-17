// The engine's surface door (spec revision 19, §3.1 "Client kinds", §3.4 "Mount lists"; G1; contract
// `contracts/surface-door.ts`). Lane RT. `ipc/moss.ts` asks it at every hello and tells it every close.
//
// * `surface` is the `app` role's alone (`not-app`); an `app` hello without one is `code`, today's app.
// * The program is the connection's SIGNED identity where the OS has one (macOS, `platform/peer-signature.ts`'s
//   `appPeerProgram`): a surface that isn't it is refused (`program-mismatch`). Where there is none (Windows, Linux) the
//   surface stands in, with the caller check (§3.1).
// * One live `host` per home (`second-host`), until its connection closes.
// * Two live copies of one window program on different releases: the older stops. An older newcomer is refused
//   (`older-copy`); a newer one is admitted and the older connections are named in `stop` (the server tells them to go).
// * Mounts: `SURFACE_MOUNTS`, except that until the background host is built (`legacy`, lane HS) a `code` window mounts
//   the screen's points too (`LEGACY_CODE_MOUNTS`), since today's app runs the island itself.
// The surface grants no method: all three are the `app` role for the allow lists, the caller check and an answer key.
import { compareReleases, DEFAULT_SURFACE, LEGACY_CODE_MOUNTS, SURFACE_MOUNTS, type MountList, type Surface } from "@waifucave/moss-protocol";
import { Listeners, type Unsubscribe } from "../contracts/common";
import type { LiveSurface, SurfaceAdmission, SurfaceClient, SurfaceDoor } from "../contracts/surface-door";

interface Held extends LiveSurface {
  mount: MountList;
}

export class EngineSurfaceDoor implements SurfaceDoor {
  readonly #live = new Map<number, Held>();
  readonly #listeners = new Listeners<LiveSurface[]>();
  readonly #legacy: boolean | (() => boolean);
  // lane HS: a host the engine gave up on leaves no island: a legacy window then mounts all but the screen's surfaces.
  readonly #noIsland: () => boolean;
  #noIslandCode: MountList | undefined;

  /** `legacy` (default true): today's engine, before the background host, where a `code` window mounts the screen too.
   *  Lane HS: it may be asked at each hello (`() => boolean`): legacy while no background host owns the screen. */
  constructor(opts: { legacy?: boolean | (() => boolean); noIsland?: () => boolean } = {}) {
    this.#legacy = opts.legacy ?? true;
    this.#noIsland = opts.noIsland ?? (() => false);
  }

  #mount(surface: Surface): MountList {
    // lane HS: start
    const legacy = typeof this.#legacy === "function" ? this.#legacy() : this.#legacy;
    if (surface === "code" && legacy && this.#noIsland()) {
      this.#noIslandCode ??= { ...LEGACY_CODE_MOUNTS, points: LEGACY_CODE_MOUNTS.points.filter((p) => p !== "app.surface") };
      return this.#noIslandCode;
    }
    // lane HS: end
    return surface === "code" && legacy ? LEGACY_CODE_MOUNTS : SURFACE_MOUNTS[surface];
  }

  admit(client: SurfaceClient): SurfaceAdmission | { ok: true; surface: undefined } {
    if (client.role !== "app") {
      if (client.surface !== undefined) return { ok: false, refusal: { reason: "not-app", surface: client.surface } };
      return { ok: true, surface: undefined };
    }
    const surface = client.surface ?? DEFAULT_SURFACE;
    // The signed identity decides the program; the hello's word must agree with it.
    if (client.signed !== undefined && client.signed !== surface) return { ok: false, refusal: { reason: "program-mismatch", surface } };
    const same = [...this.#live.values()].filter((l) => l.surface === surface);
    if (surface === "host" && same.length > 0) return { ok: false, refusal: { reason: "second-host", surface } };
    const stop: number[] = [];
    if (client.release !== undefined) {
      for (const l of same) {
        if (l.release === undefined) continue;
        const c = compareReleases(client.release, l.release);
        if (c < 0) return { ok: false, refusal: { reason: "older-copy", surface } };
        if (c > 0) stop.push(l.connId);
      }
    }
    const program = client.signed ?? surface;
    const mount = this.#mount(surface);
    this.#live.set(client.connId, { connId: client.connId, surface, program, mount, ...(client.release !== undefined ? { release: client.release } : {}) });
    this.#listeners.emit(this.live());
    return { ok: true, surface, program, mount, stop };
  }

  closed(connId: number): void {
    if (this.#live.delete(connId)) this.#listeners.emit(this.live());
  }

  live(): LiveSurface[] {
    return [...this.#live.values()].map(({ mount: _mount, ...l }) => ({ ...l }));
  }

  programOf(connId: number) {
    return this.#live.get(connId)?.program;
  }

  surfaceOf(connId: number): Surface | undefined {
    return this.#live.get(connId)?.surface;
  }

  /** Whether some live connection draws the island: it mounts the screen's surfaces (`app.surface`) and draws the cards
   *  the router places there. The host does; until it is built, today's `code` window does (`LEGACY_CODE_MOUNTS`). */
  islandLive(): boolean {
    for (const l of this.#live.values()) if (l.mount.drawsCards && l.mount.points.includes("app.surface")) return true;
    return false;
  }

  /** Whether this connection is one that draws the island (`islandLive`'s rule, for one connection). */
  islandDrawer(connId: number): boolean {
    const l = this.#live.get(connId);
    return l !== undefined && l.mount.drawsCards && l.mount.points.includes("app.surface");
  }

  // lane HS: start
  /** The background host's state changed (lane HS): each live `code` window's mount follows it, as the window itself
   *  re-mounts on `host_changed`, so `islandLive` and `islandDrawer` say who draws the island now. Heard only on a change. */
  remount(): void {
    let changed = false;
    for (const l of this.#live.values()) {
      if (l.surface !== "code") continue;
      const m = this.#mount("code");
      if (m !== l.mount) { l.mount = m; changed = true; }
    }
    if (changed) this.#listeners.emit(this.live());
  }
  // lane HS: end

  watch(fn: (live: LiveSurface[]) => void): Unsubscribe {
    return this.#listeners.add(fn);
  }
}
