/**
 * The tails problem, generalised: which edge selections give every tile an
 * even number of crossings? Only parity matters, so it is the null space of
 * the types x classes incidence matrix over GF(2).
 */

import { ruleSetClasses, type RuleSet } from './ruleset';
import type { Tiling } from './tiling';

export interface ParityAnalysis {
  readonly classes: readonly number[];
  /** Basis of the valid selections, each a sorted class list. */
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
  return { classes, basis: basisMasks.map(toList), count, selections, truncated: count > lim };
}
