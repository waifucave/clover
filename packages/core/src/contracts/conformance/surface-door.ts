// The SurfaceDoor conformance suite (spec revision 19, G1). `runSurfaceDoorConformance(make)` registers every case against
// the implementation `make` builds; `tests/surface-door.test.ts` runs it against FakeSurfaceDoor, and lane RT runs it
// against the engine's door. What it pins: `code` by default, `surface` for `app` only, one live host, the signed
// program over the hello's word, the older copy stopping, and the mount lists.
import { describe, expect, test } from "bun:test";
import { LEGACY_CODE_MOUNTS, SURFACE_MOUNTS } from "@waifucave/moss-protocol";
import type { FakeSurfaceDoor } from "../fakes/surface-door";

export type SurfaceDoorHarness = Pick<FakeSurfaceDoor, keyof FakeSurfaceDoor>;
export type SurfaceDoorFactory = (...args: ConstructorParameters<typeof FakeSurfaceDoor>) => SurfaceDoorHarness;

export function runSurfaceDoorConformance(make: SurfaceDoorFactory): void {
  describe("SurfaceDoor", () => {
    test("an app hello without a surface is MOSS Code's window; a surface on another role is refused", () => {
      const door = make();
      expect(door.admit({ connId: 1, role: "app" })).toMatchObject({ ok: true, surface: "code", program: "code", stop: [] });
      expect(door.admit({ connId: 2, role: "cli" })).toEqual({ ok: true, surface: undefined });
      expect(door.admit({ connId: 3, role: "layer", surface: "host" })).toEqual({ ok: false, refusal: { reason: "not-app", surface: "host" } });
      expect(door.live().map((l) => l.connId)).toEqual([1]);
    });

    test("one live host per home: a second is refused until the first closes", () => {
      const door = make();
      expect(door.admit({ connId: 1, role: "app", surface: "host" })).toMatchObject({ ok: true, surface: "host" });
      expect(door.admit({ connId: 2, role: "app", surface: "host" })).toEqual({ ok: false, refusal: { reason: "second-host", surface: "host" } });
      // Windows of both apps may be live beside it.
      expect(door.admit({ connId: 3, role: "app", surface: "moss" })).toMatchObject({ ok: true });
      expect(door.admit({ connId: 4, role: "app", surface: "code" })).toMatchObject({ ok: true });
      door.closed(1);
      expect(door.admit({ connId: 5, role: "app", surface: "host" })).toMatchObject({ ok: true, surface: "host" });
    });

    test("the program is the signed identity where there is one: a surface that isn't it is refused", () => {
      const door = make();
      expect(door.admit({ connId: 1, role: "app", surface: "host", signed: "moss" })).toEqual({ ok: false, refusal: { reason: "program-mismatch", surface: "host" } });
      expect(door.admit({ connId: 2, role: "app", signed: "moss" })).toEqual({ ok: false, refusal: { reason: "program-mismatch", surface: "code" } });
      expect(door.admit({ connId: 3, role: "app", surface: "moss", signed: "moss" })).toMatchObject({ ok: true, program: "moss" });
      // No signature (Windows, Linux): the surface stands in.
      expect(door.admit({ connId: 4, role: "app", surface: "host" })).toMatchObject({ ok: true, program: "host" });
      expect(door.programOf(3)).toBe("moss");
      expect(door.programOf(4)).toBe("host");
      expect(door.programOf(99)).toBeUndefined();
    });

    test("an older second copy of a window program stops: a newer newcomer names it, an older newcomer is refused", () => {
      const door = make();
      expect(door.admit({ connId: 1, role: "app", surface: "moss", release: "1.111.1" })).toMatchObject({ ok: true, stop: [] });
      expect(door.admit({ connId: 2, role: "app", surface: "moss", release: "1.111.0" })).toEqual({ ok: false, refusal: { reason: "older-copy", surface: "moss" } });
      expect(door.admit({ connId: 3, role: "app", surface: "moss", release: "1.111.2" })).toMatchObject({ ok: true, stop: [1] });
      // The engine told it to stop and it went; another copy on the same release runs beside the newer one.
      door.closed(1);
      expect(door.admit({ connId: 4, role: "app", surface: "moss", release: "1.111.2" })).toMatchObject({ ok: true, stop: [] });
    });

    test("mounts: the host the screen's points and the browser's pages, MOSS nothing from plugins, MOSS Code its window", () => {
      const door = make({ legacy: false });
      expect(door.admit({ connId: 1, role: "app", surface: "host" })).toMatchObject({ mount: SURFACE_MOUNTS.host });
      expect(door.admit({ connId: 2, role: "app", surface: "moss" })).toMatchObject({ mount: { surface: "moss", points: [], places: [], browserPages: false, drawsCards: true } });
      expect(door.admit({ connId: 3, role: "app" })).toMatchObject({ mount: { surface: "code", points: ["themes", "locales", "app.root"], places: ["window"], browserPages: false } });
      // Before the host is built, a code window still mounts the screen's points itself.
      expect(make().admit({ connId: 1, role: "app" })).toMatchObject({ mount: LEGACY_CODE_MOUNTS });
    });

    test("watchers hear the live surfaces change", () => {
      const door = make();
      const seen: number[] = [];
      door.watch((live) => seen.push(live.length));
      door.admit({ connId: 1, role: "app" });
      door.admit({ connId: 2, role: "app", surface: "host" });
      door.closed(1);
      door.closed(1);
      expect(seen).toEqual([1, 2, 1]);
    });
  });
}
