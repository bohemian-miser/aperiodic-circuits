/**
 * The tails problem, generalised: which edge selections give every tile an
 * even number of crossings? Only parity matters, so it is the null space of
 * the types x classes incidence matrix over GF(2).
 */

import { ruleSetClasses, type RuleSet } from './ruleset';
import type { Tiling } from './tiling';

export interface ParityAnalysis {
  readonly classes: readonly number[];
  /**
   * Basis of the valid selections, each a sorted class list: as few edges as
   * the enumerated selections allow, so the groups read as small loops. Every
   * valid selection is a unique XOR of these.
   */
  readonly basis: readonly (readonly number[])[];
  /** 2^basis.length, including the empty selection. */
  readonly count: number;
  /** The valid selections themselves, up to a cap. */
  readonly selections: readonly (readonly number[])[];
  readonly truncated: boolean;
}

/** Crossings each type gets under a selection. */
export function crossingCounts(t: Tiling, rs: RuleSet, sel: ReadonlySet<number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of t.prototiles) out[p.id] = (rs.seams[p.id] ?? []).filter((s) => sel.has(s.cls)).length;
  return out;
}

export function oddTypes(t: Tiling, rs: RuleSet, sel: ReadonlySet<number>): string[] {
  const c = crossingCounts(t, rs, sel);
  return t.prototiles.filter((p) => c[p.id] % 2 === 1).map((p) => p.id);
}

export function analyzeParity(t: Tiling, rs: RuleSet, cap = 512): ParityAnalysis {
  const classes = ruleSetClasses(rs);
  const k = classes.length;
  // Rows: one per type, as bitmasks over class positions (BigInt for > 31 classes).
  const rows: bigint[] = t.prototiles.map((p) => {
    let m = 0n;
    for (const s of rs.seams[p.id] ?? []) m ^= 1n << BigInt(classes.indexOf(s.cls));
    return m;
  });
  // Reduced row echelon form.
  const pivots: number[] = [];
  let r = 0;
  for (let col = 0; col < k && r < rows.length; col++) {
    const bit = 1n << BigInt(col);
    const i = rows.findIndex((x, j) => j >= r && (x & bit) !== 0n);
    if (i < 0) continue;
    [rows[r], rows[i]] = [rows[i], rows[r]];
    for (let j = 0; j < rows.length; j++) if (j !== r && (rows[j] & bit) !== 0n) rows[j] ^= rows[r];
    pivots.push(col);
    r++;
  }
  // Null space: one vector per free column.
  const basisMasks: bigint[] = [];
  for (let f = 0; f < k; f++) {
    if (pivots.includes(f)) continue;
    const fb = 1n << BigInt(f);
    let v = fb;
    pivots.forEach((pc, pi) => {
      if ((rows[pi] & fb) !== 0n) v |= 1n << BigInt(pc);
    });
    basisMasks.push(v);
  }
  const toList = (m: bigint) => classes.filter((_, i) => (m & (1n << BigInt(i))) !== 0n);
  const count = 2 ** basisMasks.length;
  const selections: number[][] = [];
  const lim = Math.min(count, cap);
  for (let i = 0; i < lim; i++) {
    let m = 0n;
    for (let b = 0; b < basisMasks.length; b++) if (b < 30 && i & (1 << b)) m ^= basisMasks[b];
    selections.push(toList(m));
  }
  selections.sort((a, b) => a.length - b.length || a.join(',').localeCompare(b.join(',')));
  // Greedy over the lightest selections first gives a minimum-weight basis
  // (it's a matroid); the echelon vectors fill in whatever the cap cut off.
  const span = new XorSpan();
  const basis: number[][] = [];
  const toMask = (l: readonly number[]) => l.reduce((m, c) => m | (1n << BigInt(classes.indexOf(c))), 0n);
  for (const cand of [...selections.map(toMask), ...basisMasks]) {
    if (basis.length === basisMasks.length) break;
    if (span.add(cand)) basis.push(toList(cand));
  }
  return { classes, basis, count, selections, truncated: count > lim };
}

/** Incremental GF(2) span, remembering which inserted vectors make each row. */
class XorSpan {
  private readonly rows: { v: bigint; combo: bigint }[] = [];
  private n = 0;

  private reduce(v: bigint): { v: bigint; combo: bigint } {
    let combo = 0n;
    for (const r of this.rows) {
      if ((v ^ r.v) < v) {
        v ^= r.v;
        combo ^= r.combo;
      }
    }
    return { v, combo };
  }

  /** Adds v; false (and nothing added) if it is already in the span. */
  add(v: bigint): boolean {
    const r = this.reduce(v);
    if (r.v === 0n) return false;
    this.rows.push({ v: r.v, combo: r.combo ^ (1n << BigInt(this.n++)) });
    // Keep rows sorted by leading bit, highest first, so reduce() works in one pass.
    this.rows.sort((a, b) => (a.v > b.v ? -1 : a.v < b.v ? 1 : 0));
    return true;
  }

  /** Which inserted vectors XOR to v, or null if v is outside the span. */
  coords(v: bigint): bigint | null {
    const r = this.reduce(v);
    return r.v === 0n ? r.combo : null;
  }
}

/**
 * How a selection decomposes over the basis: one flag per basis group, or
 * null when the selection isn't tail-free (so it isn't in their span).
 */
export function basisCoords(par: ParityAnalysis, sel: ReadonlySet<number>): boolean[] | null {
  const toMask = (l: Iterable<number>) => {
    let m = 0n;
    for (const c of l) {
      const i = par.classes.indexOf(c);
      if (i >= 0) m |= 1n << BigInt(i);
    }
    return m;
  };
  const span = new XorSpan();
  for (const b of par.basis) span.add(toMask(b));
  if ([...sel].some((c) => !par.classes.includes(c))) return null;
  const combo = span.coords(toMask(sel));
  return combo === null ? null : par.basis.map((_, i) => (combo & (1n << BigInt(i))) !== 0n);
}
