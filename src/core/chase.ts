/**
 * Chasing one line across the infinite plane, tile by tile.
 *
 * Ported in spirit from the Spectre project's strand walk: the chords inside a
 * tile are purely local, and consecutive chords meet at a crossing point on
 * the seam the two tiles share, so "where does this line go next?" only needs
 * the tiles round the current head. Each step asks the plane for the tiles at
 * the head and takes the chord leaving it from the tile we didn't come from.
 * Nothing here depends on what is on screen, so the walk can run anywhere.
 *
 * The trail is append-only (up to its hold, which drops the oldest chords),
 * and keeps the cumulative arc length per point, which is what the follow
 * camera rides.
 */

import type { Affine, Pt } from './geom';
import { transPt } from './geom';
import { localChords, type LocalChord } from './circuits';
import type { InfinitePlane } from './infinite';
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

  /** Walk one more chord. False once the line has closed or hit a tail. */
  step(): boolean {
    if (this.status !== 'running') return false;
    const h = this.head;
    const { instances } = this.plane.query({ minX: h.x - 1e-3, minY: h.y - 1e-3, maxX: h.x + 1e-3, maxY: h.y + 1e-3 }, 64);
    for (const inst of instances) {
      if (sameXform(inst.xform, this.from)) continue;
      for (const ch of this.local.get(inst.type) ?? []) {
        const a = transPt(inst.xform, ch.a);
        const b = transPt(inst.xform, ch.b);
        const fwd = near(a, h);
        if (!fwd && !near(b, h)) continue;
        const end = fwd ? b : a;
        this.push(end, transPt(inst.xform, ch.c));
        this.from = inst.xform;
        this.steps++;
        if (near(end, this.start)) this.status = 'closed';
        return this.status === 'running';
      }
    }
    this.status = 'tail';
    return false;
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
