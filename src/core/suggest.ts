/**
 * Automatic help with edge numberings.
 *
 * Every consistent labelling is a merge of the derived (finest) classes, so
 * suggestions are found by merging derived classes: greedily towards the
 * most tail-free selections, or at random for variety. Nothing here can
 * produce an inconsistent labelling.
 */

import { analyzeParity } from './parity';
import { deriveAdjacency, renumberClasses, ruleSetClasses, type Adjacency, type RuleSet, type Seam } from './ruleset';
import type { Tiling } from './tiling';

/** Pairs tried per greedy step; past this the pairs are sampled. */
const MAX_PAIRS = 120;

export interface Suggestion {
  readonly ruleSet: RuleSet;
  readonly classes: number;
  /** Number of tail-free edge selections (2^nullity). */
  readonly tailFree: number;
  readonly how: string;
}

/** dim of the GF(2) null space of the types × groups parity matrix. */
function nullity(rows: readonly bigint[], cols: number): number {
  const m = [...rows];
  let rank = 0;
  for (let c = 0; c < cols && rank < m.length; c++) {
    const bit = 1n << BigInt(c);
    const i = m.findIndex((x, j) => j >= rank && (x & bit) !== 0n);
    if (i < 0) continue;
    [m[rank], m[i]] = [m[i], m[rank]];
    for (let j = 0; j < m.length; j++) if (j !== rank && (m[j] & bit) !== 0n) m[j] ^= m[rank];
    rank++;
  }
  return cols - rank;
}

/** Parity rows for a grouping of base classes (group[c] = group index). */
function parityRows(t: Tiling, base: RuleSet, group: readonly number[], classIndex: Map<number, number>): bigint[] {
  return t.prototiles.map((p) => {
    let m = 0n;
    for (const s of base.seams[p.id] ?? []) m ^= 1n << BigInt(group[classIndex.get(s.cls)!]);
    return m;
  });
}

function applyGrouping(t: Tiling, base: RuleSet, group: readonly number[], classIndex: Map<number, number>, name: string, how: string): RuleSet {
  const seams: Record<string, Seam[]> = {};
  for (const [k, list] of Object.entries(base.seams)) seams[k] = list.map((s) => ({ ...s, cls: group[classIndex.get(s.cls)!] }));
  return renumberClasses({ ...base, id: 'draft', name, seams, classNames: undefined, notes: how }, t.prototiles.map((p) => p.id));
}

function compact(group: number[]): number[] {
  const map = new Map<number, number>();
  return group.map((g) => {
    if (!map.has(g)) map.set(g, map.size);
    return map.get(g)!;
  });
}

/**
 * Greedy merging: at each step merge the pair of classes that leaves the
 * most tail-free selections (ties: keep classes balanced). Returns one
 * suggestion per class count, from `base`'s count down to 2.
 */
export function greedySuggestions(t: Tiling, base: RuleSet, minClasses = 2): Suggestion[] {
  const classes = ruleSetClasses(base);
  const classIndex = new Map(classes.map((c, i) => [c, i]));
  let group = classes.map((_, i) => i);
  const out: Suggestion[] = [];
  const size = (g: number[]) => {
    const n = new Map<number, number>();
    for (const p of t.prototiles) for (const s of base.seams[p.id] ?? []) n.set(g[classIndex.get(s.cls)!], (n.get(g[classIndex.get(s.cls)!]) ?? 0) + 1);
    return n;
  };
  let k = classes.length;
  while (k > minClasses) {
    let best: { g: number[]; nul: number; bal: number } | null = null;
    const sizes = size(group);
    // All pairs while that's cheap; a random sample of them once it isn't.
    const pairs: [number, number][] = [];
    for (let a = 0; a < k; a++) for (let b = a + 1; b < k; b++) pairs.push([a, b]);
    const sample = pairs.length <= MAX_PAIRS ? pairs : pairs.sort(() => Math.random() - 0.5).slice(0, MAX_PAIRS);
    for (const [a, b] of sample) {
      {
        const g = compact(group.map((x) => (x === b ? a : x)));
        const nul = nullity(parityRows(t, base, g, classIndex), k - 1);
        const bal = -((sizes.get(a) ?? 0) + (sizes.get(b) ?? 0));
        if (!best || nul > best.nul || (nul === best.nul && bal > best.bal)) best = { g, nul, bal };
      }
    }
    if (!best) break;
    group = best.g;
    k--;
    out.push({
      ruleSet: applyGrouping(t, base, group, classIndex, `Suggested: ${k} classes`, `Greedy merge of ${base.name} down to ${k} classes, keeping as many tail-free selections as possible.`),
      classes: k,
      tailFree: 2 ** best.nul,
      how: 'greedy',
    });
  }
  return out;
}

/** Random merges of the derived classes into `k` classes. */
export function randomSuggestion(t: Tiling, base: RuleSet, k: number, rnd: () => number = Math.random): Suggestion {
  const classes = ruleSetClasses(base);
  const classIndex = new Map(classes.map((c, i) => [c, i]));
  const kk = Math.max(1, Math.min(k, classes.length));
  // Every group gets at least one class, the rest land anywhere.
  const order = classes.map((_, i) => i).sort(() => rnd() - 0.5);
  const group = new Array<number>(classes.length);
  order.forEach((ci, j) => (group[ci] = j < kk ? j : Math.floor(rnd() * kk)));
  const g = compact(group);
  const rs = applyGrouping(t, base, g, classIndex, `Random: ${kk} classes`, `Random merge of ${base.name} into ${kk} classes.`);
  return { ruleSet: rs, classes: kk, tailFree: analyzeParity(t, rs, 1).count, how: 'random' };
}

export interface NeighbourReport {
  /** Per type, per edge: how many different (neighbour type, neighbour edge) contexts it meets. */
  readonly contexts: Readonly<Record<string, readonly number[]>>;
  readonly determined: number;
  readonly total: number;
}

/**
 * Does each tile edge always meet the same neighbour edge? When every edge
 * does (as in the Spectre's nine types), the types carry their own edge
 * matching rules and labels can be read straight off the substitution.
 */
export function neighbourReport(t: Tiling, adj: Adjacency = deriveAdjacency(t)): NeighbourReport {
  const sets = new Map<string, Set<string>[]>();
  for (const p of t.prototiles) sets.set(p.id, p.pts.map(() => new Set()));
  for (const inst of adj.instances) {
    adj.neighbour[inst.id].forEach((nb, e) => {
      if (!nb) return;
      sets.get(inst.type)![e].add(`${adj.instances[nb.inst].type}/${nb.edge}`);
    });
  }
  const contexts: Record<string, number[]> = {};
  let determined = 0;
  let total = 0;
  for (const [type, list] of sets) {
    contexts[type] = list.map((s) => s.size);
    for (const s of list) {
      if (s.size === 0) continue;
      total++;
      if (s.size === 1) determined++;
    }
  }
  return { contexts, determined, total };
}
