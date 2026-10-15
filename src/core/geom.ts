/**
 * Affine geometry. Same conventions as the Spectre project's `geom.ts`:
 * a row-major 2x3 matrix `[a b c / d e f]` maps
 *   x' = a*x + b*y + c
 *   y' = d*x + e*y + f
 */

export interface Pt {
  readonly x: number;
  readonly y: number;
}

export type Affine = readonly [number, number, number, number, number, number];

export const IDENT: Affine = [1, 0, 0, 0, 1, 0];
export const REFLECT_X: Affine = [-1, 0, 0, 0, 1, 0];

export function pt(x: number, y: number): Pt {
  return { x, y };
}

export function mul(A: Affine, B: Affine): Affine {
  return [
    A[0] * B[0] + A[1] * B[3],
    A[0] * B[1] + A[1] * B[4],
    A[0] * B[2] + A[1] * B[5] + A[2],
    A[3] * B[0] + A[4] * B[3],
    A[3] * B[1] + A[4] * B[4],
    A[3] * B[2] + A[4] * B[5] + A[5],
  ];
}

export function inv(T: Affine): Affine {
  const d = T[0] * T[4] - T[1] * T[3];
  return [
    T[4] / d,
    -T[1] / d,
    (T[1] * T[5] - T[2] * T[4]) / d,
    -T[3] / d,
    T[0] / d,
    (T[2] * T[3] - T[0] * T[5]) / d,
  ];
}

export function trot(ang: number): Affine {
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  return [c, -s, 0, s, c, 0];
}

export function ttrans(tx: number, ty: number): Affine {
  return [1, 0, tx, 0, 1, ty];
}

export function tscale(s: number): Affine {
  return [s, 0, 0, 0, s, 0];
}

export function transPt(M: Affine, P: Pt): Pt {
  return { x: M[0] * P.x + M[1] * P.y + M[2], y: M[3] * P.x + M[4] * P.y + M[5] };
}

export function det(M: Affine): number {
  return M[0] * M[4] - M[1] * M[3];
}

export function radians(deg: number): number {
  return (deg * Math.PI) / 180;
}

export function lerpPt(a: Pt, b: Pt, t: number): Pt {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

export function dist(a: Pt, b: Pt): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/**
 * The similarity (possibly mirroring) that sends `a0 -> a1` and `b0 -> b1`.
 * With `flip` the map reflects, so orientation is reversed.
 */
export function similarityFrom(a0: Pt, b0: Pt, a1: Pt, b1: Pt, flip = false): Affine {
  // Work with complex numbers: z -> m*z + t (or m*conj(z) + t when flipping).
  const ux = b0.x - a0.x;
  const uy = flip ? -(b0.y - a0.y) : b0.y - a0.y;
  const vx = b1.x - a1.x;
  const vy = b1.y - a1.y;
  const den = ux * ux + uy * uy;
  const mr = (vx * ux + vy * uy) / den;
  const mi = (vy * ux - vx * uy) / den;
  // Linear part acting on (x, s*y) where s = flip ? -1 : 1.
  const s = flip ? -1 : 1;
  const a = mr;
  const b = -mi * s;
  const d = mi;
  const e = mr * s;
  const tx = a1.x - (a * a0.x + b * a0.y);
  const ty = a1.y - (d * a0.x + e * a0.y);
  return [a, b, tx, d, e, ty];
}

/** Canvas `setTransform(a, b, c, d, e, f)` order for a row-major Affine. */
export function toCanvas(M: Affine): [number, number, number, number, number, number] {
  return [M[0], M[3], M[1], M[4], M[2], M[5]];
}
