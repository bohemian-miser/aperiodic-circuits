/**
 * Infinite mode: the whole plane, grown around the camera on demand.
 *
 * The same idea as the Spectre project's un-rooted engine, made generic over
 * any tiling with a `hierarchy`: a leaf of the root type is anchored at the
 * origin with the identity transform, and its ancestors are chosen one level
 * at a time going UP, so the chain only ever extends and earlier tiles never
 * move. A viewport query extends the chain until its top supertile covers
 * the view, then walks down, skipping every supertile whose bounding circle
 * misses the view.
 *
 * Each ancestor step picks one of the (parent type, slot) pairs that can hold
 * the current supertile, at random from a seeded generator, weighted by how
 * common the parent type is (the Spectre project's scheme). A seed therefore
 * names one tiling of the whole plane. A fixed rule such as "the most central
 * slot" can trap the anchor on every supertile's boundary (the chair's inner
 * corner does exactly that), leaving half the plane uncovered for ever.
 */

import { IDENT, inv, mul, transPt, type Affine, type Pt } from './geom';
import { polygonCentroid, signedArea, unionBoundary } from './polygon';
import { MAX_INSTANCES, prototile, type Hierarchy, type TileInstance, type Tiling } from './tiling';

export interface Rect {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

interface Circle {
  readonly c: Pt;
  readonly r: number;
}

interface Ancestor {
  readonly type: string;
  readonly level: number;
  /** Its own frame -> world. */
  readonly world: Affine;
  /** Which of its children is the ancestor below it (-1 for the anchor). */
  readonly slot: number;
}

/** Hard ceiling on ancestor levels, whatever the growth rate. */
const MAX_LEVELS = 80;

/**
 * A supertile drawn whole, as the Spectre map does past its instance budget:
 * a level-`level` node of `type`, by the map from its own frame to the world.
 */
export interface SuperInstance {
  readonly type: string;
  readonly level: number;
  readonly xform: Affine;
}

/** A glyph's outline is worked out exactly from at most this many leaves… */
const GLYPH_LEAVES = 3000;
/** …and thinned to at most this many points (it is drawn a few pixels wide). */
const MAX_GLYPH_POINTS = 48;
/** Past the bounding circles, a query at a supertile cut grows the chain at most this many more times. */
const AGGREGATE_EXTRA_GROWS = 3;

export function supportsInfinite(t: Tiling): boolean {
  return !!t.hierarchy;
}

/** Mean leaf area, weighted equally over prototiles (for picking the supertile cut). */
export function meanTileArea(t: Tiling): number {
  const a = t.prototiles.map((p) => Math.abs(signedArea(p.pts)));
  return a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);
}

export class InfinitePlane {
  private readonly h: Hierarchy;
  /** Bounding circles by type, then level. */
  private readonly bounds = new Map<string, Circle[]>();
  private readonly chain: Ancestor[];
  private readonly rnd: () => number;
  private readonly weight: Map<string, number>;
  /** Long-run growth in tile count per level (the Perron eigenvalue). */
  private readonly growth: number;
  private readonly meanArea: number;

  constructor(
    private readonly tiling: Tiling,
    anchorType: string,
    seed = 1,
  ) {
    if (!tiling.hierarchy) throw new Error(`${tiling.name} has no hierarchy`);
    this.h = tiling.hierarchy;
    this.chain = [{ type: anchorType, level: 0, world: IDENT, slot: -1 }];
    this.rnd = mulberry32(seed);
    const f = typeFrequencies(tiling, this.h);
    this.weight = f.weight;
    this.growth = f.growth;
    this.meanArea = meanTileArea(tiling);
  }

  /** Bounding circle of a (type, level) supertile in its own frame. */
  circle(type: string, level: number): Circle {
    let byLevel = this.bounds.get(type);
    if (!byLevel) this.bounds.set(type, (byLevel = []));
    const hit = byLevel[level];
    if (hit) return hit;
    let out: Circle;
    if (level === 0) {
      const pts = prototile(this.tiling, type).pts;
      const c = polygonCentroid(pts);
      out = { c, r: Math.max(...pts.map((p) => Math.hypot(p.x - c.x, p.y - c.y))) };
    } else {
      const kids = this.h.children(type, level).map((k) => {
        const cc = this.circle(k.type, level - 1);
        return { c: transPt(k.xform, cc.c), r: cc.r };
      });
      if (!kids.length) out = { c: { x: 0, y: 0 }, r: 0 };
      else {
        const c = { x: kids.reduce((s, k) => s + k.c.x, 0) / kids.length, y: kids.reduce((s, k) => s + k.c.y, 0) / kids.length };
        out = { c, r: Math.max(...kids.map((k) => Math.hypot(k.c.x - c.x, k.c.y - c.y) + k.r)) };
      }
    }
    byLevel[level] = out;
    return out;
  }

  /** Add one ancestor above the current top. Returns false when nothing can hold it. */
  private grow(): boolean {
    const top = this.chain[this.chain.length - 1];
    const level = top.level + 1;
    const options: { type: string; rel: Affine; slot: number; w: number }[] = [];
    for (const p of this.tiling.prototiles) {
      this.h.children(p.id, level).forEach((k, slot) => {
        if (k.type === top.type) options.push({ type: p.id, rel: k.xform, slot, w: this.weight.get(p.id) ?? 1 });
      });
    }
    if (!options.length) return false;
    let x = this.rnd() * options.reduce((sum, o) => sum + o.w, 0);
    let pick = options[options.length - 1];
    for (const o of options) {
      x -= o.w;
      if (x < 0) {
        pick = o;
        break;
      }
    }
    // world(parent) · rel = world(top)  =>  world(parent) = world(top) · rel⁻¹
    this.chain.push({ type: pick.type, level, world: mul(top.world, inv(pick.rel)), slot: pick.slot });
    return true;
  }

  /** The top supertile's bounding circle contains the view (necessary, not sufficient). */
  private circleCovers(rect: Rect): boolean {
    const top = this.chain[this.chain.length - 1];
    const circ = this.circle(top.type, top.level);
    const c = transPt(top.world, circ.c);
    return [
      [rect.minX, rect.minY],
      [rect.maxX, rect.minY],
      [rect.minX, rect.maxY],
      [rect.maxX, rect.maxY],
    ].every(([x, y]) => Math.hypot(x - c.x, y - c.y) <= circ.r);
  }

  /** The nodes at level `cut` (leaves at 0) overlapping `rect`. */
  private walk(rect: Rect, cap: number, cut = 0): { nodes: SuperInstance[]; truncated: boolean } {
    const top = this.chain[this.chain.length - 1];
    const out: SuperInstance[] = [];
    let truncated = false;
    // Going down the chain itself, each ancestor's stored map is used rather
    // than the product down from the top: those were built up from the
    // anchor, so they stay as exact as the tiles round the anchor need,
    // however high a zoomed-out view has grown the chain. Multiplied down
    // from a tall top, they drift, and tiles fetched before and after no
    // longer meet.
    const go = (type: string, level: number, world: Affine, onChain: boolean): void => {
      if (out.length >= cap) {
        truncated = true;
        return;
      }
      const circ = this.circle(type, level);
      const c = transPt(world, circ.c);
      if (c.x + circ.r < rect.minX || c.x - circ.r > rect.maxX || c.y + circ.r < rect.minY || c.y - circ.r > rect.maxY) return;
      if (level <= cut) {
        out.push({ type, level, xform: world });
        return;
      }
      const slot = onChain ? this.chain[level].slot : -1;
      this.h.children(type, level).forEach((k, j) => {
        if (j === slot) go(k.type, level - 1, this.chain[level - 1].world, true);
        else go(k.type, level - 1, mul(world, k.xform), false);
      });
    };
    go(top.type, top.level, top.world, true);
    return { nodes: out, truncated };
  }

  /** Every sample point of the view lies in some tile (or supertile glyph). */
  private fills(rect: Rect, instances: readonly SuperInstance[]): boolean {
    // Leaves are placed rigidly, so a prototile's bounding circle carries
    // over: each tile only tests the samples inside its circle, and
    // transforms its polygon only when there is one.
    const N = 5;
    // Nudge off the exact grid so samples don't land on shared edges.
    const sx = (i: number) => rect.minX + ((i + 0.5137) / N) * (rect.maxX - rect.minX);
    const sy = (j: number) => rect.minY + ((j + 0.4729) / N) * (rect.maxY - rect.minY);
    const dx = (rect.maxX - rect.minX) / N;
    const dy = (rect.maxY - rect.minY) / N;
    const hit = new Uint8Array(N * N);
    let left = N * N;
    for (const inst of instances) {
      const b = inst.level ? this.circle(inst.type, inst.level) : this.leafCircle(inst.type);
      const c = transPt(inst.xform, b.c);
      const i0 = Math.max(0, Math.ceil((c.x - b.r - rect.minX) / dx - 0.5137));
      const i1 = Math.min(N - 1, Math.floor((c.x + b.r - rect.minX) / dx - 0.5137));
      const j0 = Math.max(0, Math.ceil((c.y - b.r - rect.minY) / dy - 0.4729));
      const j1 = Math.min(N - 1, Math.floor((c.y + b.r - rect.minY) / dy - 0.4729));
      let pts: Pt[] | null = null;
      for (let i = i0; i <= i1; i++) {
        for (let j = j0; j <= j1; j++) {
          if (hit[i * N + j]) continue;
          const x = sx(i);
          const y = sy(j);
          if ((x - c.x) ** 2 + (y - c.y) ** 2 > b.r * b.r) continue;
          pts ??= (inst.level ? this.glyph(inst.type, inst.level) : prototile(this.tiling, inst.type).pts).map((p) => transPt(inst.xform, p));
          if (pointInPolygon(x, y, pts)) {
            hit[i * N + j] = 1;
            if (--left === 0) return true;
          }
        }
      }
    }
    return left === 0;
  }

  private readonly leafCircles = new Map<string, Circle>();
  /** A prototile's own bounding circle (centre at its vertex mean). */
  private leafCircle(type: string): Circle {
    let b = this.leafCircles.get(type);
    if (!b) {
      const pts = prototile(this.tiling, type).pts;
      const c = { x: pts.reduce((s, p) => s + p.x, 0) / pts.length, y: pts.reduce((s, p) => s + p.y, 0) / pts.length };
      b = { c, r: Math.max(...pts.map((p) => Math.hypot(p.x - c.x, p.y - c.y))) * (1 + 1e-9) };
      this.leafCircles.set(type, b);
    }
    return b;
  }

  /**
   * Leaves overlapping `rect`, ids 0..n-1.
   *
   * With `lod`, a view that would hold more than `cap` leaves is cut higher
   * up instead, as the Spectre map's engine does: `supertiles` then holds the
   * level-`cutLevel` supertiles overlapping it (draw each as its
   * {@link glyph}), `instances` is empty, and there is no zoom-out limit.
   */
  query(
    rect: Rect,
    cap = MAX_INSTANCES,
    opts: { readonly lod?: boolean } = {},
  ): { instances: TileInstance[]; supertiles: SuperInstance[]; cutLevel: number; levels: number; truncated: boolean } {
    while (!this.circleCovers(rect) && this.chain.length < MAX_LEVELS && this.grow()) {
      /* extend upwards until the view could fit */
    }
    // Each level up divides the count by the growth rate.
    const est = ((rect.maxX - rect.minX) * (rect.maxY - rect.minY)) / Math.max(1e-12, this.meanArea);
    let cut = opts.lod && est > cap && this.growth > 1 ? Math.ceil(Math.log(est / cap) / Math.log(this.growth)) : 0;
    let extra = 0;
    for (;;) {
      const topLevel = this.chain[this.chain.length - 1].level;
      cut = Math.min(cut, topLevel);
      const r = this.walk(rect, cap, cut);
      // The estimate is only an estimate: over the cap, cut one level higher.
      if (r.truncated && opts.lod && cut < topLevel) {
        cut++;
        continue;
      }
      // Bounding circles overstate supertiles; grow until the view really is
      // full. Glyphs are only near enough, so a supertile cut stops trying soon.
      const done =
        r.truncated || (cut > 0 && extra++ >= AGGREGATE_EXTRA_GROWS) || this.fills(rect, r.nodes) || this.chain.length >= MAX_LEVELS || !this.grow();
      if (done) {
        const levels = this.chain[this.chain.length - 1].level;
        if (cut > 0) return { instances: [], supertiles: r.nodes, cutLevel: cut, levels, truncated: r.truncated };
        return { instances: r.nodes.map((n, id) => ({ id, type: n.type, xform: n.xform })), supertiles: [], cutLevel: 0, levels, truncated: r.truncated };
      }
    }
  }

  private readonly sums = new Map<string, { leaves: number; area: number }>();
  /** Leaves in a (type, level) supertile, and their total area. */
  private sum(type: string, level: number): { leaves: number; area: number } {
    const key = `${type}@${level}`;
    let n = this.sums.get(key);
    if (!n) {
      n = { leaves: 0, area: 0 };
      if (level === 0) n = { leaves: 1, area: Math.abs(signedArea(prototile(this.tiling, type).pts)) };
      else
        for (const k of this.h.children(type, level)) {
          const c = this.sum(k.type, level - 1);
          n.leaves += c.leaves;
          n.area += c.area;
        }
      this.sums.set(key, n);
    }
    return n;
  }

  /** Leaves in a (type, level) supertile. */
  leafCount(type: string, level: number): number {
    return this.sum(type, level).leaves;
  }

  /** Area of a (type, level) supertile (its leaves are rigid copies of the prototiles). */
  area(type: string, level: number): number {
    return this.sum(type, level).area;
  }

  private readonly glyphs = new Map<string, readonly Pt[]>();
  /**
   * The outline of a (type, level) supertile in its own frame, near enough
   * to fill it when it is drawn a few pixels across (the Spectre map's
   * supertile glyphs). Worked out exactly from the leaves up to a level of a
   * few thousand of them; above that, the same outline carried up by the map
   * that best takes the lower level's children onto this level's (the
   * outline converges level by level), or failing that the children's hull.
   * Always counter-clockwise.
   */
  glyph(type: string, level: number): readonly Pt[] {
    const key = `${type}@${level}`;
    const hit = this.glyphs.get(key);
    if (hit) return hit;
    let out: Pt[] | null = null;
    if (level === 0) out = [...prototile(this.tiling, type).pts];
    else if (this.leafCount(type, level) <= GLYPH_LEAVES) out = this.exactOutline(type, level);
    else {
      // The highest exact level of the same parity (a substitution can mirror every level).
      let base = level - 2;
      while (base > 1 && this.leafCount(type, base) > GLYPH_LEAVES) base -= 2;
      if (base >= 1) {
        const A = fitChildren(this.childCentres(type, base), this.childCentres(type, level));
        if (A) {
          const pts = this.glyph(type, base).map((p) => transPt(A, p));
          // A good fit scales the area as the supertile does; anything else is a bad match.
          const want = (this.area(type, level) / this.area(type, base)) * Math.abs(signedArea(this.glyph(type, base)));
          if (Math.abs(Math.abs(signedArea(pts)) / want - 1) < 0.1) out = pts;
        }
      }
    }
    out ??= hull(this.h.children(type, level).flatMap((k) => this.glyph(k.type, level - 1).map((p) => transPt(k.xform, p))));
    if (signedArea(out) < 0) out.reverse();
    this.glyphs.set(key, out);
    return out;
  }

  /** Where a supertile's children sit (their glyphs' centroids), by type. */
  private childCentres(type: string, level: number): { type: string; c: Pt }[] {
    return this.h.children(type, level).map((k) => ({ type: k.type, c: transPt(k.xform, polygonCentroid(this.glyph(k.type, level - 1))) }));
  }

  /** The decimated union of a supertile's leaves, or its leaves' hull where they don't union cleanly. */
  private exactOutline(type: string, level: number): Pt[] {
    const leaves: Pt[][] = [];
    const go = (t: string, lv: number, M: Affine): void => {
      if (lv === 0) {
        const pts = prototile(this.tiling, t).pts.map((p) => transPt(M, p));
        if (signedArea(pts) < 0) pts.reverse();
        leaves.push(pts);
        return;
      }
      for (const k of this.h.children(t, lv)) go(k.type, lv - 1, mul(M, k.xform));
    };
    go(type, level, IDENT);
    const total = this.area(type, level);
    try {
      const u = unionBoundary(leaves, leaves.map(() => IDENT)).pts;
      // A T-junction (one tile's edge along two of another's) leaves a loop that isn't the outline.
      if (u.length >= 3 && Math.abs(Math.abs(signedArea(u)) / total - 1) < 1e-3) return decimate(u, MAX_GLYPH_POINTS);
    } catch {
      /* fall through to the hull */
    }
    return hull(leaves.flat());
  }
}

/** Every k-th point, so at most `max` remain. */
function decimate(pts: readonly Pt[], max: number): Pt[] {
  if (pts.length <= max) return [...pts];
  const k = pts.length / max;
  const out: Pt[] = [];
  for (let i = 0; i < max; i++) out.push(pts[Math.floor(i * k)]);
  return out;
}

/** Convex hull, counter-clockwise (monotone chain). */
function hull(pts: readonly Pt[]): Pt[] {
  const p = [...pts].sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length < 3) return p;
  const cross = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lo: Pt[] = [];
  for (const q of p) {
    while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop();
    lo.push(q);
  }
  const hi: Pt[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (hi.length >= 2 && cross(hi[hi.length - 2], hi[hi.length - 1], q) <= 0) hi.pop();
    hi.push(q);
  }
  return lo.slice(0, -1).concat(hi.slice(0, -1));
}

/**
 * The affine map taking one level's children (by their centres) onto
 * another level's of the same type, by least squares, or null when they
 * don't correspond or don't pin a map down.
 */
function fitChildren(from: readonly { type: string; c: Pt }[], to: readonly { type: string; c: Pt }[]): Affine | null {
  if (from.length !== to.length || from.length < 3 || from.some((k, i) => k.type !== to[i].type)) return null;
  const n = from.length;
  const P = from.map((k) => k.c);
  const Q = to.map((k) => k.c);
  const mp = { x: P.reduce((s, p) => s + p.x, 0) / n, y: P.reduce((s, p) => s + p.y, 0) / n };
  const mq = { x: Q.reduce((s, p) => s + p.x, 0) / n, y: Q.reduce((s, p) => s + p.y, 0) / n };
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  let ux = 0;
  let uy = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < n; i++) {
    const x = P[i].x - mp.x;
    const y = P[i].y - mp.y;
    const qx = Q[i].x - mq.x;
    const qy = Q[i].y - mq.y;
    sxx += x * x;
    sxy += x * y;
    syy += y * y;
    ux += qx * x;
    uy += qx * y;
    vx += qy * x;
    vy += qy * y;
  }
  const det = sxx * syy - sxy * sxy;
  if (!(Math.abs(det) > 1e-9 * Math.max(1, sxx * syy))) return null;
  // [a b; d e] = [ux uy; vx vy] · S⁻¹
  const a = (ux * syy - uy * sxy) / det;
  const b = (uy * sxx - ux * sxy) / det;
  const d = (vx * syy - vy * sxy) / det;
  const e = (vy * sxx - vx * sxy) / det;
  return [a, b, mq.x - a * mp.x - b * mp.y, d, e, mq.y - d * mp.x - e * mp.y];
}

function pointInPolygon(x: number, y: number, pts: readonly Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i];
    const b = pts[j];
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Long-run share of each type (Perron vector of the level-1 substitution counts), and the growth per level. */
function typeFrequencies(t: Tiling, h: Hierarchy): { weight: Map<string, number>; growth: number } {
  const ids = t.prototiles.map((p) => p.id);
  const idx = new Map(ids.map((id, i) => [id, i]));
  let v = ids.map(() => 1 / ids.length);
  let growth = 1;
  for (let it = 0; it < 100; it++) {
    const w = ids.map(() => 0);
    ids.forEach((id, i) => {
      for (const k of h.children(id, 1)) {
        const j = idx.get(k.type);
        if (j !== undefined) w[j] += v[i];
      }
    });
    const sum = w.reduce((a, b) => a + b, 0);
    if (!sum) break;
    // v sums to 1, so the sum is the growth.
    growth = sum;
    v = w.map((x) => x / sum);
  }
  // A type that never occurs still gets a little weight, so the chain can't dead-end on weights alone.
  return { weight: new Map(ids.map((id, i) => [id, Math.max(v[i], 1e-6)])), growth };
}
