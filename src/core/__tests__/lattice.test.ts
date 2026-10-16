import { describe, expect, it } from 'vitest';
import { cellKey, checkSpec, expansionOptions, latticeTiling, refineLatticeSpec, substitutionStats, type LatticeChild, type LatticeSpec } from '../lattice';
import { LATTICE_PRESETS } from '../latticePresets';
import { computeAdjacency, derivedRuleSet, ruleSetClasses, validateRuleSet } from '../ruleset';
import { analyzeParity } from '../parity';
import { greedySuggestions, neighbourReport, randomSuggestion } from '../suggest';
import { tilingFromSpec, validateTilingSpec } from '../tilings';

const flower = LATTICE_PRESETS.find((p) => p.id === 'lab-flower')!;

describe('lattice substitutions', () => {
  it('every preset fits to level 4, is primitive, and grows by its slot count', () => {
    for (const p of LATTICE_PRESETS) {
      expect(checkSpec(p, 4).firstBad, p.id).toBeNull();
      const st = substitutionStats(p);
      expect(st.primitive, p.id).toBe(true);
      expect(st.growth, p.id).toBeCloseTo(p.cells.length, 6);
    }
  });

  it('finds the Gosper expansion for the seven-hex flower', () => {
    const opts = expansionOptions('hex', flower.cells);
    const best = opts[0];
    expect(best.residues).toBe(true);
    expect(best.similarity).toBe(true);
    expect(Math.abs(best.matrix[0] * best.matrix[3] - best.matrix[1] * best.matrix[2])).toBe(7);
    expect(best.turn).toBeCloseTo(19.1, 1);
  });

  it('slots that clash mod the expansion fail the check', () => {
    // (0,0) and (1,1) are the same residue mod 1+i, so copies collide or leave gaps.
    const s: LatticeSpec = { ...flower, grid: 'square', cells: [[0, 0], [1, 1]], matrix: [1, 1, -1, 1], rules: {} };
    expect(checkSpec(s, 4).firstBad).not.toBeNull();
  });

  it('flipping one child of the flower breaks it at level 3 (the Gosper shape is chiral)', () => {
    const flipped: LatticeSpec = {
      ...flower,
      rules: { ...flower.rules, A: { ...flower.rules.A, [cellKey(flower.cells[1])]: { type: 'A', rot: 0, flip: true } } },
    };
    expect(checkSpec(flipped, 4).firstBad).toBe(3);
  });

  it('turning one child of the square quartet breaks it at level 2', () => {
    const sq = LATTICE_PRESETS.find((p) => p.id === 'lab-square4')!;
    const turned: LatticeSpec = { ...sq, rules: { ...sq.rules, A: { ...sq.rules.A, [cellKey(sq.cells[1])]: { type: 'A', rot: 1, flip: false } } } };
    const chk = checkSpec(turned, 4);
    expect(chk.firstBad).toBe(2);
    expect(chk.perType.A[1].overlaps + chk.perType.A[1].holes).toBeGreaterThan(0);
  });

  it('turning every child the same way is fine (it commutes with the expansion)', () => {
    const rules: Record<string, Record<string, LatticeChild>> = {};
    for (const t of flower.types) {
      rules[t.id] = {};
      for (const c of flower.cells) rules[t.id][cellKey(c)] = { type: t.id, rot: 2, flip: false };
    }
    expect(checkSpec({ ...flower, rules }, 4).firstBad).toBeNull();
  });

  it('lab tilings are edge-to-edge and their derived numbering is consistent', () => {
    for (const p of LATTICE_PRESETS) {
      expect(validateTilingSpec(p), p.id).toEqual([]);
      const t = tilingFromSpec(p);
      const adj = computeAdjacency(t, t.generate(t.deriveLevel + 1, t.defaultRoot));
      expect(adj.anomalies, p.id).toBe(0);
      expect(validateRuleSet(t, derivedRuleSet(t), adj).ok, p.id).toBe(true);
    }
  });

  it('refining by slot gives the edges more to remember', () => {
    const plain = latticeTiling(flower);
    const fine = latticeTiling(refineLatticeSpec(flower));
    expect(fine.prototiles.length).toBe(21);
    expect(neighbourReport(plain).determined).toBe(0);
    expect(neighbourReport(fine).determined).toBeGreaterThan(0);
    expect(ruleSetClasses(derivedRuleSet(fine)).length).toBeGreaterThan(ruleSetClasses(derivedRuleSet(plain)).length);
  });
});

describe('edge-numbering suggestions', () => {
  const t = latticeTiling(refineLatticeSpec(flower));
  const base = derivedRuleSet(t);
  const adj = computeAdjacency(t, t.generate(t.deriveLevel + 1, t.defaultRoot));

  it('greedy suggestions are consistent and count their tail-free selections right', () => {
    const list = greedySuggestions(t, base);
    expect(list.length).toBe(ruleSetClasses(base).length - 2);
    for (const s of list.filter((x) => x.classes <= 8)) {
      expect(ruleSetClasses(s.ruleSet).length).toBe(s.classes);
      expect(validateRuleSet(t, s.ruleSet, adj).ok).toBe(true);
      expect(analyzeParity(t, s.ruleSet).count).toBe(s.tailFree);
      expect(s.tailFree).toBeGreaterThan(1);
    }
  });

  it('random merges are consistent too', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (const k of [2, 5, 9]) {
      const s = randomSuggestion(t, base, k, rnd);
      expect(ruleSetClasses(s.ruleSet).length).toBe(k);
      expect(validateRuleSet(t, s.ruleSet, adj).ok).toBe(true);
    }
  });
});
