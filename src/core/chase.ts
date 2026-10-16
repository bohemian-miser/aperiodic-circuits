/**
 * Chasing one line across the infinite plane, tile by tile.
 *
 * Ported in spirit from the Spectre project's strand walk: the chords inside a
 * tile are purely local, and consecutive chords meet at a crossing point on
 * the seam the two tiles share, so "where does this line go next?" only needs
 * the tiles round the current head. As in Spectre's walk feeder, the walker
 * asks the plane for a patch of tiles centred on the head (a "feed"), indexes
 * their chord ends, and steps through it by lookup, taking the chord that
 * leaves the head from the tile we didn't come from. When the head nears the
 * edge of the feed it asks for the next one, bigger each time the walk drinks
 * a whole feed (up to a ceiling), so a fast chase costs few plane queries.
 * Nothing here depends on what is on screen, so the walk can run anywhere.
 *
 * The trail is append-only (up to its hold, which drops the oldest chords),
 * and keeps the cumulative arc length per point, which is what the follow
 * camera rides.
 */

import type { Affine, Pt } from './geom';
import { transPt } from './geom';
import { localChords, type LocalChord } from './circuits';
import type { InfinitePlane, Rect } from './infinite';
import type { RuleSet } from './ruleset';
import type { Tiling } from './tiling';
import type { TrailArcView } from './followCamera';

export type ChaseStatus = 'running' | 'closed' | 'tail';

/** A chord in world coordinates: ends a and b, Bézier control c. */
export interface WorldChord {
  readonly a: Pt;
  readonly b: Pt;
  readonly c: Pt;
}

/** Chord ends this close are the same crossing point. */
const SNAP = 1e-4;
/** Feed half-extent bounds, in tile diameters (tuned on a long walk: smaller is slower, bigger no faster). */
const FEED_MIN = 3;
const FEED_MAX = 12;
const FEED_GROW = 1.5;
/** Tile-grid cells per axis stay well under this (keys are ix * KEY + iy). */
const KEY = 4096;
/** With no hold, the trail still drops its oldest chords past this many. */
export const MAX_TRAIL = 1_000_000;

export class StrandChase implements TrailArcView {
  /** Trail points (chord ends in walk order), 2 doubles each. */
  xy: Float64Array = new Float64Array(2048);
  /** Cumulative arc length at each point. */
  arc: Float64Array = new Float64Array(1024);
  /** Points held (chords held + 1). */
  count = 0;
  /** Control points of the held chords, 2 doubles each; chord i runs from point i to i+1. */
  ctl: Float64Array = new Float64Array(2048);
  /** Chords walked so far, including any dropped by the hold. */
  steps = 0;
  /** Chords dropped off the back of the trail (the absolute index of held chord 0). */
  dropped = 0;
  status: ChaseStatus = 'running';

  private readonly local = new Map<string, LocalChord[]>();
  /** The largest tile diameter: how far inside a feed the head must stay. */
  private readonly reach: number;
  private feedRect: Rect | null = null;
  /** The feed's tiles, bucketed on a grid of `reach`-sized cells by centre. */
  private feedTiles: { type: string; xform: Affine }[] = [];
  private feedCells = new Map<number, number[]>();
  private feedHalf: number;
  /** Prototile centres, for bucketing. */
  private readonly centre = new Map<string, Pt>();
  private readonly start: Pt;
  private head: Pt;
  /** The tile the head's chord lies in, so the next step leaves through the other one. */
  private from: Affine;

  constructor(
    private readonly plane: InfinitePlane,
    tiling: Tiling,
    ruleSet: RuleSet,
    selection: ReadonlySet<number>,
    combo: Readonly<Record<string, number>>,
    first: WorldChord,
    firstTile: Affine,
    public hold = 0,
  ) {
    for (const p of tiling.prototiles) local(this.local, tiling, ruleSet, p.id, selection, combo[p.id] ?? 0);
    let reach = 0;
    for (const p of tiling.prototiles) for (const a of p.pts) for (const b of p.pts) reach = Math.max(reach, Math.hypot(a.x - b.x, a.y - b.y));
    this.reach = reach || 1;
    for (const p of tiling.prototiles) {
      let x = 0;
      let y = 0;
      for (const q of p.pts) {
        x += q.x;
        y += q.y;
      }
      this.centre.set(p.id, { x: x / p.pts.length, y: y / p.pts.length });
    }
    this.feedHalf = FEED_MIN * this.reach;
    this.start = first.a;
    this.head = first.a;
    this.from = firstTile;
    this.push(first.a, null);
    this.push(first.b, first.c);
    this.steps = 1;
    if (near(first.b, this.start)) this.status = 'closed';
  }

  /** Where the line has got to. */
  get headPt(): Pt {
    return this.head;
  }

  /**
   * Keep feeds small (a paced chase only sips) or let them grow with the
   * walk's appetite (full speed).
   */
  sipping = false;

  /** Walk one more chord. False once the line has closed or hit a tail. */
  step(): boolean {
    if (this.status !== 'running') return false;
    const h = this.head;
    const f = this.feedRect;
    const m = 1.5 * this.reach;
    let fresh = false;
    if (!f || h.x < f.minX + m || h.x > f.maxX - m || h.y < f.minY + m || h.y > f.maxY - m) {
      // Drank the whole feed: the next one is bigger, unless we're only sipping.
      if (f) this.feedHalf = this.sipping ? FEED_MIN * this.reach : Math.min(FEED_MAX * this.reach, this.feedHalf * FEED_GROW);
      this.feed(h);
      fresh = true;
    }
    let e = this.next(h);
    if (!e && !fresh) {
      this.feed(h);
      e = this.next(h);
    }
    if (!e) {
      this.status = 'tail';
      return false;
    }
    this.push(e.other, e.c);
    this.from = e.tile;
    this.steps++;
    if (near(e.other, this.start)) this.status = 'closed';
    return this.status === 'running';
  }

  /** The chord leaving `h` from a tile other than the one we came from. */
  private next(h: Pt): { other: Pt; c: Pt; tile: Affine } | undefined {
    const f = this.feedRect!;
    const ix = Math.floor((h.x - f.minX) / this.reach);
    const iy = Math.floor((h.y - f.minY) / this.reach);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const ti of this.feedCells.get((ix + dx) * KEY + iy + dy) ?? []) {
          const tile = this.feedTiles[ti];
          if (sameXform(tile.xform, this.from)) continue;
          for (const ch of this.local.get(tile.type) ?? []) {
            const a = transPt(tile.xform, ch.a);
            const fwd = near(a, h);
            const b = transPt(tile.xform, ch.b);
            if (!fwd && !near(b, h)) continue;
            return { other: fwd ? b : a, c: transPt(tile.xform, ch.c), tile: tile.xform };
          }
        }
      }
    }
    return undefined;
  }

  /** Fetch the tiles of a patch centred on `h`, bucketed by where they sit. */
  private feed(h: Pt): void {
    const r = this.feedHalf;
    const rect = { minX: h.x - r, minY: h.y - r, maxX: h.x + r, maxY: h.y + r };
    const { instances } = this.plane.query(rect, 200_000);
    const cells = new Map<number, number[]>();
    instances.forEach((inst, i) => {
      // A tile's crossing points are within `reach` of its centre, so the
      // 3x3 cells round the head always hold every tile that could own one.
      const c = transPt(inst.xform, this.centre.get(inst.type)!);
      const k = Math.floor((c.x - rect.minX) / this.reach) * KEY + Math.floor((c.y - rect.minY) / this.reach);
      const l = cells.get(k);
      if (l) l.push(i);
      else cells.set(k, [i]);
    });
    this.feedRect = rect;
    this.feedTiles = instances;
    this.feedCells = cells;
  }

  /** Trail chord i (0 = oldest held) as world points. */
  chord(i: number): WorldChord {
    return {
      a: { x: this.xy[2 * i], y: this.xy[2 * i + 1] },
      b: { x: this.xy[2 * i + 2], y: this.xy[2 * i + 3] },
      c: { x: this.ctl[2 * i], y: this.ctl[2 * i + 1] },
    };
  }

  /** Chords held. */
  get chords(): number {
    return Math.max(0, this.count - 1);
  }

  private push(p: Pt, c: Pt | null): void {
    if (this.count + 1 > this.arc.length) {
      this.xy = grow(this.xy, this.xy.length * 2);
      this.arc = grow(this.arc, this.arc.length * 2);
      this.ctl = grow(this.ctl, this.ctl.length * 2);
    }
    const n = this.count;
    this.xy[2 * n] = p.x;
    this.xy[2 * n + 1] = p.y;
    this.arc[n] = n === 0 ? 0 : this.arc[n - 1] + Math.hypot(p.x - this.xy[2 * n - 2], p.y - this.xy[2 * n - 1]);
    if (c) {
      this.ctl[2 * n - 2] = c.x;
      this.ctl[2 * n - 1] = c.y;
    }
    this.count++;
    this.head = p;
    const keep = this.hold > 0 ? this.hold : MAX_TRAIL;
    // Trim in batches so a long chase isn't copying its whole trail every step.
    if (this.chords > keep + Math.max(16, keep >> 3)) this.trim(keep);
  }

  private trim(keep: number): void {
    const drop = this.chords - keep;
    this.xy.copyWithin(0, 2 * drop, 2 * this.count);
    this.arc.copyWithin(0, drop, this.count);
    this.ctl.copyWithin(0, 2 * drop, 2 * (this.count - 1));
    this.count -= drop;
    this.dropped += drop;
  }
}

function local(out: Map<string, LocalChord[]>, t: Tiling, rs: RuleSet, type: string, sel: ReadonlySet<number>, combo: number): void {
  const L = localChords(t, rs, type, sel, combo);
  out.set(type, L.odd ? [] : L.chords);
}

function near(a: Pt, b: Pt): boolean {
  return Math.abs(a.x - b.x) < SNAP && Math.abs(a.y - b.y) < SNAP;
}

function sameXform(a: Affine, b: Affine): boolean {
  for (let i = 0; i < 6; i++) if (Math.abs(a[i] - b[i]) > 1e-6) return false;
  return true;
}

function grow(a: Float64Array, n: number): Float64Array {
  const b = new Float64Array(n);
  b.set(a);
  return b;
}
