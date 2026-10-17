/**
 * Animating a change of pairing. Every chord is split at its middle into two
 * halves, each a quadratic of its own from one crossing point to the middle.
 * When a tile's pairing changes, each crossing keeps its point on the seam
 * and its half swings over from the old partner's middle to the new one's,
 * so the lines visibly rewire instead of jumping.
 */

import { lerpPt, type Pt } from './geom';

export interface Bezier {
  readonly a: Pt;
  readonly b: Pt;
  readonly c: Pt;
}

/** One half of a chord on the move: anchored at `e`, control and middle lerp from 0 to 1. */
export interface MovingHalf {
  /** Index of the chord in the new list (for its colour). */
  readonly chord: number;
  /** The chord this half swings away from in the old list, or -1. */
  readonly from: number;
  readonly e: Pt;
  readonly q0: Pt;
  readonly m0: Pt;
  readonly q1: Pt;
  readonly m1: Pt;
}

export interface ChordMorph {
  /** New chords that were there before too, unchanged. */
  readonly still: readonly number[];
  /** Where each of `still` was in the old list. */
  readonly stillFrom: readonly number[];
  readonly moving: readonly MovingHalf[];
}

export const MORPH_MS = 450;

const EPS2 = 1e-12;

function same(p: Pt, q: Pt): boolean {
  return (p.x - q.x) ** 2 + (p.y - q.y) ** 2 < EPS2;
}

/** The half of chord `ch` from its end `e`: control point and middle. */
function halfOf(ch: Bezier, e: Pt): { q: Pt; m: Pt } {
  return { q: lerpPt(e, ch.c, 0.5), m: lerpPt(lerpPt(ch.a, ch.c, 0.5), lerpPt(ch.c, ch.b, 0.5), 0.5) };
}

/**
 * How to get from `from` to `to`: both lists must hold the same tiles' chords
 * in the same order (`group` names a chord's tile), as a change of pairing
 * alone leaves them. Null when they don't line up.
 */
export function morphChords<T extends Bezier>(from: readonly T[], to: readonly T[], group: (ch: T) => unknown = () => 0): ChordMorph | null {
  if (from.length !== to.length) return null;
  const still: number[] = [];
  const stillFrom: number[] = [];
  const moving: MovingHalf[] = [];
  let s = 0;
  while (s < to.length) {
    const g = group(to[s]);
    let t = s + 1;
    while (t < to.length && group(to[t]) === g) t++;
    for (let k = s; k < t; k++) if (group(from[k]) !== g) return null;
    for (let k = s; k < t; k++) {
      const ch = to[k];
      let was = -1;
      for (let j = s; j < t && was < 0; j++) {
        const o = from[j];
        if ((same(o.a, ch.a) && same(o.b, ch.b)) || (same(o.a, ch.b) && same(o.b, ch.a))) was = j;
      }
      if (was >= 0) {
        still.push(k);
        stillFrom.push(was);
        continue;
      }
      for (const e of [ch.a, ch.b]) {
        const now = halfOf(ch, e);
        let old = -1;
        for (let j = s; j < t && old < 0; j++) if (same(from[j].a, e) || same(from[j].b, e)) old = j;
        const before = old >= 0 ? halfOf(from[old], e) : now;
        moving.push({ chord: k, from: old, e, q0: before.q, m0: before.m, q1: now.q, m1: now.m });
      }
    }
    s = t;
  }
  return { still, stillFrom, moving };
}

/** A moving half at time `u` in [0, 1]. */
export function halfAt(h: MovingHalf, u: number): { e: Pt; q: Pt; m: Pt } {
  return { e: h.e, q: lerpPt(h.q0, h.q1, u), m: lerpPt(h.m0, h.m1, u) };
}

/** Eased progress of a morph started at `start` (ms), clamped to [0, 1]. */
export function morphProgress(start: number, now: number): number {
  const t = Math.max(0, Math.min(1, (now - start) / MORPH_MS));
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}
