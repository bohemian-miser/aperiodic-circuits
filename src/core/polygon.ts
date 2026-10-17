import { transPt, type Affine, type Pt } from './geom';

/** Signed area (positive when counter-clockwise in a y-up frame). */
export function signedArea(pts: readonly Pt[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/** Area centroid of a simple polygon. */
export function polygonCentroid(pts: readonly Pt[]): Pt {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    const c = p.x * q.y - q.x * p.y;
    a += c;
    cx += (p.x + q.x) * c;
    cy += (p.y + q.y) * c;
  }
  if (Math.abs(a) < 1e-12) {
    const n = pts.length || 1;
    return { x: pts.reduce((s, p) => s + p.x, 0) / n, y: pts.reduce((s, p) => s + p.y, 0) / n };
  }
  return { x: cx / (3 * a), y: cy / (3 * a) };
}

/** Quantized point key used to match vertices produced by different transforms. */
export function qkey(p: Pt, q = 1e4): string {
  return `${Math.round(p.x * q)},${Math.round(p.y * q)}`;
}

/** Grid cells per axis a numeric point key holds before it falls back to a string. */
const NUM_SPAN = 2 ** 26;

/**
 * The same quantising as {@link qkey}, measured from `origin`, as a number
 * when it fits (it does for any patch within ~30,000 units of its origin at
 * q = 1e3). Map lookups on numbers are several times faster than on strings,
 * which matters on a patch of 100,000 tiles. Keys from different keyers don't
 * mix.
 */
export function pointKeyer(origin: Pt, q = 1e3): (x: number, y: number) => number | string {
  const ox = Math.round(origin.x);
  const oy = Math.round(origin.y);
  const lim = NUM_SPAN / 2;
  return (x, y) => {
    const ix = Math.round((x - ox) * q);
    const iy = Math.round((y - oy) * q);
    return ix > -lim && ix < lim && iy > -lim && iy < lim ? (ix + lim) * NUM_SPAN + (iy + lim) : `${ix},${iy}`;
  };
}

export interface UnionResult {
  readonly pts: readonly Pt[];
  /** For each boundary edge of the union: which input polygon and edge it came from. */
  readonly source: readonly { readonly poly: number; readonly edge: number }[];
}

/**
 * Outer boundary of a union of edge-to-edge polygons that share whole edges
 * (e.g. the two Spectres of the Mystic). Shared edges cancel; the rest chain
 * into one loop. All inputs must have the same orientation.
 */
export function unionBoundary(polys: readonly (readonly Pt[])[], xforms: readonly Affine[]): UnionResult {
  interface E {
    a: Pt;
    b: Pt;
    ka: string;
    kb: string;
    poly: number;
    edge: number;
  }
  const edges: E[] = [];
  polys.forEach((poly, pi) => {
    const w = poly.map((p) => transPt(xforms[pi], p));
    for (let i = 0; i < w.length; i++) {
      const a = w[i];
      const b = w[(i + 1) % w.length];
      edges.push({ a, b, ka: qkey(a), kb: qkey(b), poly: pi, edge: i });
    }
  });
  const fwd = new Set(edges.map((e) => `${e.ka}>${e.kb}`));
  const kept = edges.filter((e) => !fwd.has(`${e.kb}>${e.ka}`));
  const byStart = new Map<string, E>();
  for (const e of kept) byStart.set(e.ka, e);
  // Start from the first kept edge in input order so the result is deterministic.
  const out: Pt[] = [];
  const source: { poly: number; edge: number }[] = [];
  let cur = kept[0];
  for (let guard = 0; guard <= kept.length; guard++) {
    out.push(cur.a);
    source.push({ poly: cur.poly, edge: cur.edge });
    const next = byStart.get(cur.kb);
    if (!next || next === kept[0]) break;
    cur = next;
  }
  return { pts: out, source };
}
