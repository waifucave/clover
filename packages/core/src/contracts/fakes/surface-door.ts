// FakeSurfaceDoor: the surface rules in memory. `legacy` (default true) is today's engine, before the background host:
// a `code` window mounts the screen's points too.
import { compareReleases, DEFAULT_SURFACE, LEGACY_CODE_MOUNTS, SURFACE_MOUNTS, type MountList, type Surface } from "@waifucave/moss-protocol";
import { Listeners, type Unsubscribe } from "../common";
import type { LiveSurface, SurfaceAdmission, SurfaceClient, SurfaceDoor } from "../surface-door";

export class FakeSurfaceDoor implements SurfaceDoor {
  readonly #live = new Map<number, LiveSurface>();
  readonly #listeners = new Listeners<LiveSurface[]>();
  readonly #legacy: boolean;

  constructor(opts: { legacy?: boolean } = {}) {
    this.#legacy = opts.legacy ?? true;
  }

  #mount(surface: Surface): MountList {
    return surface === "code" && this.#legacy ? LEGACY_CODE_MOUNTS : SURFACE_MOUNTS[surface];
  }

  admit(client: SurfaceClient): SurfaceAdmission | { ok: true; surface: undefined } {
    if (client.role !== "app") {
      if (client.surface !== undefined) return { ok: false, refusal: { reason: "not-app", surface: client.surface } };
      return { ok: true, surface: undefined };
    }
    const surface = client.surface ?? DEFAULT_SURFACE;
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
    this.#live.set(client.connId, { connId: client.connId, surface, program, ...(client.release !== undefined ? { release: client.release } : {}) });
    this.#listeners.emit(this.live());
    return { ok: true, surface, program, mount: this.#mount(surface), stop };
  }

  closed(connId: number): void {
    if (this.#live.delete(connId)) this.#listeners.emit(this.live());
  }

  live(): LiveSurface[] {
    return [...this.#live.values()].map((l) => ({ ...l }));
  }

  programOf(connId: number) {
    return this.#live.get(connId)?.program;
  }

  watch(fn: (live: LiveSurface[]) => void): Unsubscribe {
    return this.#listeners.add(fn);
  }
}
