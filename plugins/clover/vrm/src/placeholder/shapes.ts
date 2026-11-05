// Simple solids for the placeholder avatar: ellipsoids, tapered tubes along any axis with rounded ends, and
// flat decals laid on a sphere (the face's eyes, mouth, brows and blush). Each returns positions, normals and
// triangle indices, counter-clockwise from outside. Pure and deterministic.

export type Vec3 = readonly [number, number, number];

export interface Shape {
  positions: number[];
  normals: number[];
  indices: number[];
}

export const empty = (): Shape => ({ positions: [], normals: [], indices: [] });

export function merge(...shapes: Shape[]): Shape {
  const out = empty();
  for (const s of shapes) {
    const base = out.positions.length / 3;
    out.positions.push(...s.positions);
    out.normals.push(...s.normals);
    for (const i of s.indices) out.indices.push(base + i);
  }
  return out;
}

/** Every point moved by `offset` (normals unchanged): a part placed relative to its bone. */
export function translate(shape: Shape, offset: Vec3): Shape {
  return { ...shape, positions: shape.positions.map((v, i) => v - offset[i % 3]!) };
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
export const norm = (a: Vec3): Vec3 => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** An ellipsoid at `center` with `radii`; `keep` may drop triangles, judged by their centroid relative to the centre. */
export function ellipsoid(center: Vec3, radii: Vec3, rings = 18, segments = 28, keep?: (local: Vec3) => boolean): Shape {
  const s = empty();
  for (let r = 0; r <= rings; r++) {
    const phi = (Math.PI * r) / rings;
    for (let g = 0; g <= segments; g++) {
      const theta = (2 * Math.PI * g) / segments;
      // theta = 0 faces +Z, the model's front; it turns toward +X, the model's left.
      const unit: Vec3 = [Math.sin(phi) * Math.sin(theta), Math.cos(phi), Math.sin(phi) * Math.cos(theta)];
      s.positions.push(center[0] + unit[0] * radii[0], center[1] + unit[1] * radii[1], center[2] + unit[2] * radii[2]);
      s.normals.push(...norm([unit[0] / radii[0], unit[1] / radii[1], unit[2] / radii[2]]));
    }
  }
  const row = segments + 1;
  for (let r = 0; r < rings; r++) {
    for (let g = 0; g < segments; g++) {
      const a = r * row + g;
      const b = a + row;
      for (const tri of [
        [a, b, a + 1],
        [a + 1, b, b + 1],
      ]) {
        if (keep) {
          const c = [0, 0, 0];
          for (const i of tri) for (let k = 0; k < 3; k++) c[k]! += s.positions[i * 3 + k]! / 3;
          if (!keep([c[0]! - center[0], c[1]! - center[1], c[2]! - center[2]])) continue;
        }
        s.indices.push(...tri);
      }
    }
  }
  return s;
}

/**
 * A tapered tube from `from` to `to`, radius `r0` then `r1`, its ends rounded by spheres. `depth` squashes
 * a vertical tube front to back (a body is shallower than it is wide).
 */
export function tube(from: Vec3, to: Vec3, r0: number, r1: number, segments = 22, depth = 1, caps: "round" | "flat" = "round"): Shape {
  const axis = sub(to, from);
  const length = len(axis);
  const dir = norm(axis);
  const helper: Vec3 = Math.abs(dir[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  // A right-handed frame (u, v, dir); for a vertical tube v is the model's depth.
  const u = norm(cross(helper, dir));
  const v = norm(cross(dir, u));
  const vertical = Math.abs(dir[1]) > 0.9;
  const sv = vertical ? depth : 1;
  const body = empty();
  const rings = Math.max(2, Math.round(length / 0.02));
  for (let i = 0; i <= rings; i++) {
    const t = i / rings;
    const radius = r0 + (r1 - r0) * t;
    const c: Vec3 = [from[0] + axis[0] * t, from[1] + axis[1] * t, from[2] + axis[2] * t];
    for (let g = 0; g <= segments; g++) {
      const a = (2 * Math.PI * g) / segments;
      const cu = Math.cos(a);
      const cv = Math.sin(a) * sv;
      body.positions.push(c[0] + (u[0] * cu + v[0] * cv) * radius, c[1] + (u[1] * cu + v[1] * cv) * radius, c[2] + (u[2] * cu + v[2] * cv) * radius);
      const slope = (r0 - r1) / Math.max(length, 1e-6);
      const nu = Math.cos(a);
      const nv = Math.sin(a) / sv;
      body.normals.push(...norm([u[0] * nu + v[0] * nv + dir[0] * slope, u[1] * nu + v[1] * nv + dir[1] * slope, u[2] * nu + v[2] * nv + dir[2] * slope]));
    }
  }
  const row = segments + 1;
  for (let r = 0; r < rings; r++) {
    for (let g = 0; g < segments; g++) {
      const a = r * row + g;
      const b = a + row;
      body.indices.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  if (caps === "flat") return merge(body, disc(from, r0, -1), disc(to, r1, 1));
  const cap = (at: Vec3, radius: number) => (vertical ? ellipsoid(at, [radius, radius * 0.7, radius * sv], 10, segments) : ellipsoid(at, [radius, radius, radius], 10, segments));
  return merge(body, cap(from, r0), cap(to, r1));

  /** A flat end: a fan facing out along the axis (`side` -1 at the start, 1 at the end). */
  function disc(at: Vec3, radius: number, side: number): Shape {
    const d = empty();
    const n: Vec3 = [dir[0] * side, dir[1] * side, dir[2] * side];
    d.positions.push(...at);
    d.normals.push(...n);
    for (let g = 0; g < segments; g++) {
      const a = (2 * Math.PI * g) / segments;
      const cu = Math.cos(a);
      const cv = Math.sin(a) * sv;
      d.positions.push(at[0] + (u[0] * cu + v[0] * cv) * radius, at[1] + (u[1] * cu + v[1] * cv) * radius, at[2] + (u[2] * cu + v[2] * cv) * radius);
      d.normals.push(...n);
    }
    for (let g = 1; g <= segments; g++) {
      const next = g === segments ? 1 : g + 1;
      // Counter-clockwise seen from outside: the end faces along the axis, the start against it.
      if (side > 0) d.indices.push(0, g, next);
      else d.indices.push(0, next, g);
    }
    return d;
  }
}

/** The sphere the face's decals sit on. */
export interface Surface {
  center: Vec3;
  radius: number;
}

/** A point drawn on the face's front view (x, y), laid on the sphere `lift` above its skin. */
export function onSurface(surface: Surface, x: number, y: number, lift: number): Vec3 {
  const dx = x - surface.center[0];
  const dy = y - surface.center[1];
  const dz = Math.sqrt(Math.max(surface.radius * surface.radius - dx * dx - dy * dy, 0));
  const n = norm([dx, dy, dz]);
  const r = surface.radius + lift;
  return [surface.center[0] + n[0] * r, surface.center[1] + n[1] * r, surface.center[2] + n[2] * r];
}

/** A flat shape in the front view, a fan around its first point, laid on the sphere. */
export interface Decal {
  /** The centre, then the outline counter-clockwise. */
  points: [number, number][];
  lift: number;
}

/** An ellipse at (cx, cy) with half-sizes (rx, ry), as a decal's points. */
export function ellipse(cx: number, cy: number, rx: number, ry: number, steps = 24): [number, number][] {
  const out: [number, number][] = [[cx, cy]];
  for (let i = 0; i < steps; i++) {
    const t = (2 * Math.PI * i) / steps;
    out.push([cx + Math.cos(t) * rx, cy + Math.sin(t) * ry]);
  }
  return out;
}

export function decalShape(surface: Surface, decal: Decal): Shape {
  const s = empty();
  for (const [x, y] of decal.points) {
    const p = onSurface(surface, x, y, decal.lift);
    s.positions.push(...p);
    s.normals.push(...norm(sub(p, surface.center)));
  }
  const n = decal.points.length - 1;
  for (let i = 1; i <= n; i++) s.indices.push(0, i, i === n ? 1 : i + 1);
  return s;
}

/** The deltas that move a decal's points to `moved` (the same count), both laid on the sphere. */
export function decalDelta(surface: Surface, base: Decal, moved: readonly (readonly [number, number])[]): number[] {
  const out: number[] = [];
  base.points.forEach(([x, y], i) => {
    const a = onSurface(surface, x, y, base.lift);
    const [mx, my] = moved[i]!;
    const b = onSurface(surface, mx, my, base.lift);
    out.push(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  });
  return out;
}
