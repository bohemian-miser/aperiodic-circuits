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
import { polygonCentroid, signedArea } from './polygon';
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
}

/** Hard ceiling on ancestor levels, whatever the growth rate. */
const MAX_LEVELS = 80;

export function supportsInfinite(t: Tiling): boolean {
  return !!t.hierarchy;
}

/** Mean leaf area, weighted equally over prototiles (for sizing the zoom limit). */
export function meanTileArea(t: Tiling): number {
  const a = t.prototiles.map((p) => Math.abs(signedArea(p.pts)));
  return a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);
}

export class InfinitePlane {
  private readonly h: Hierarchy;
  private readonly bounds = new Map<string, Circle>();
  private readonly chain: Ancestor[];
  private readonly rnd: () => number;
  private readonly weight: Map<string, number>;

  constructor(
    private readonly tiling: Tiling,
    anchorType: string,
    seed = 1,
  ) {
    if (!tiling.hierarchy) throw new Error(`${tiling.name} has no hierarchy`);
    this.h = tiling.hierarchy;
    this.chain = [{ type: anchorType, level: 0, world: IDENT }];
    this.rnd = mulberry32(seed);
    this.weight = typeFrequencies(tiling, this.h);
  }

  /** Bounding circle of a (type, level) supertile in its own frame. */
  circle(type: string, level: number): Circle {
    const key = `${type}/${level}`;
    const hit = this.bounds.get(key);
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
    this.bounds.set(key, out);
    return out;
  }

  /** Add one ancestor above the current top. Returns false when nothing can hold it. */
  private grow(): boolean {
    const top = this.chain[this.chain.length - 1];
    const level = top.level + 1;
    const options: { type: string; rel: Affine; w: number }[] = [];
    for (const p of this.tiling.prototiles) {
      for (const k of this.h.children(p.id, level)) {
        if (k.type === top.type) options.push({ type: p.id, rel: k.xform, w: this.weight.get(p.id) ?? 1 });
      }
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
    this.chain.push({ type: pick.type, level, world: mul(top.world, inv(pick.rel)) });
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

  private walk(rect: Rect, cap: number): { instances: TileInstance[]; truncated: boolean } {
    const top = this.chain[this.chain.length - 1];
    const out: TileInstance[] = [];
    let truncated = false;
    const go = (type: string, level: number, world: Affine): void => {
      if (out.length >= cap) {
        truncated = true;
        return;
      }
      const circ = this.circle(type, level);
      const c = transPt(world, circ.c);
      if (c.x + circ.r < rect.minX || c.x - circ.r > rect.maxX || c.y + circ.r < rect.minY || c.y - circ.r > rect.maxY) return;
      if (level === 0) {
        out.push({ id: out.length, type, xform: world });
        return;
      }
      for (const k of this.h.children(type, level)) go(k.type, level - 1, mul(world, k.xform));
    };
    go(top.type, top.level, top.world);
    return { instances: out, truncated };
  }

  /** Every sample point of the view lies in some tile. */
  private fills(rect: Rect, instances: readonly TileInstance[]): boolean {
    const polys = instances.map((i) => prototile(this.tiling, i.type).pts.map((p) => transPt(i.xform, p)));
    const boxes = polys.map((pts) => {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const p of pts) {
        minX = Math.min(minX, p.x);
        maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y);
        maxY = Math.max(maxY, p.y);
      }
      return { minX, minY, maxX, maxY };
    });
    const N = 5;
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        // Nudge off the exact grid so samples don't land on shared edges.
        const x = rect.minX + ((i + 0.5137) / N) * (rect.maxX - rect.minX);
        const y = rect.minY + ((j + 0.4729) / N) * (rect.maxY - rect.minY);
        let inside = false;
        for (let k = 0; k < polys.length && !inside; k++) {
          const b = boxes[k];
          if (x < b.minX || x > b.maxX || y < b.minY || y > b.maxY) continue;
          inside = pointInPolygon(x, y, polys[k]);
        }
        if (!inside) return false;
      }
    }
    return true;
  }

  /** Leaves overlapping `rect`, ids 0..n-1. */
  query(rect: Rect, cap = MAX_INSTANCES): { instances: TileInstance[]; levels: number; truncated: boolean } {
    while (!this.circleCovers(rect) && this.chain.length < MAX_LEVELS && this.grow()) {
      /* extend upwards until the view could fit */
    }
    for (;;) {
      const r = this.walk(rect, cap);
      // Bounding circles overstate supertiles; grow until the view really is full.
      if (r.truncated || this.fills(rect, r.instances) || this.chain.length >= MAX_LEVELS || !this.grow()) {
        return { ...r, levels: this.chain[this.chain.length - 1].level };
      }
    }
  }
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

/** Long-run share of each type (Perron vector of the level-1 substitution counts). */
function typeFrequencies(t: Tiling, h: Hierarchy): Map<string, number> {
  const ids = t.prototiles.map((p) => p.id);
  const idx = new Map(ids.map((id, i) => [id, i]));
  let v = ids.map(() => 1 / ids.length);
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
    v = w.map((x) => x / sum);
  }
  // A type that never occurs still gets a little weight, so the chain can't dead-end on weights alone.
  return new Map(ids.map((id, i) => [id, Math.max(v[i], 1e-6)]));
}
