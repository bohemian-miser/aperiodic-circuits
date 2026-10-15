import { describe, expect, it } from 'vitest';
import { BUILTIN_TILINGS } from '../tilings';
import { hexTiling, spectreTiling } from '../tilings/spectre';
import { chairSpec } from '../tilings/chair';
import { penroseTiling } from '../tilings/penrose';
import {
  computeAdjacency,
  derivedRuleSet,
  joinWithNext,
  mergeConflictingClasses,
  ruleSetClasses,
  seamsFromLabels,
  setEdgeClass,
  splitBefore,
  validateRuleSet,
} from '../ruleset';
import { analyzeParity } from '../parity';
import { catalan, nonCrossingMatchings } from '../matchings';
import { computeCircuits } from '../circuits';
import { refineSpec, similarityTiling, instancePts } from '../tiling';
import { signedArea } from '../polygon';
import { decodeShare, encodeShare } from '../share';

const preset = (t: typeof hexTiling) => t.presets![0].build(t);

describe('matchings', () => {
  it('non-crossing matchings are counted by Catalan numbers', () => {
    for (let k = 0; k <= 6; k++) expect(nonCrossingMatchings(2 * k).length).toBe(catalan(k));
  });
});

describe('tilings', () => {
  it('every built-in patch is edge-to-edge (no edge shared by three tiles)', () => {
    for (const t of BUILTIN_TILINGS) {
      const adj = computeAdjacency(t, t.generate(t.defaultLevel, t.defaultRoot));
      expect(adj.anomalies, t.id).toBe(0);
    }
  });

  it('similarity children fill their parent exactly (by area)', () => {
    const t = similarityTiling(chairSpec);
    const parent = Math.abs(signedArea(t.prototiles[0].pts)) * 4; // one level = inflation^2 in area
    const area = t.generate(1, 'chair').reduce((s, i) => s + Math.abs(signedArea(instancePts(t, i))), 0);
    expect(area).toBeCloseTo(parent, 9);
  });

  it('the Mystic is one 20-edge prototile', () => {
    expect(spectreTiling.prototiles.find((p) => p.id === 'Gamma')!.pts.length).toBe(20);
  });
});

describe('rule sets', () => {
  it('the Spectre-project labels are consistent on both nine-type tilings', () => {
    for (const t of [hexTiling, spectreTiling]) {
      const adj = computeAdjacency(t, t.generate(4, 'Delta'));
      expect(validateRuleSet(t, preset(t), adj).ok, t.id).toBe(true);
    }
  });

  it('derived rule sets stay consistent on a bigger patch than they came from', () => {
    for (const t of BUILTIN_TILINGS) {
      const adj = computeAdjacency(t, t.generate(Math.min(t.maxLevel, t.deriveLevel + 1), t.defaultRoot));
      for (const mode of ['seams', 'edges'] as const) {
        expect(validateRuleSet(t, derivedRuleSet(t, mode), adj).ok, `${t.id} ${mode}`).toBe(true);
      }
    }
  });

  it('hexagon labels give the eight tail-free selections from the Spectre project', () => {
    const par = analyzeParity(hexTiling, preset(hexTiling));
    expect(par.selections.map((s) => s.join(''))).toEqual(['', '15', '128', '258', '01346', '03456', '023468', '01234568']);
  });

  it('labels parse into seams, wrapping round the end', () => {
    expect(seamsFromLabels(['4.2A', '4.3A', '2.0A', '4.0A', '4.1A'])).toEqual([
      { edges: [2], cls: 2 },
      { edges: [3, 4, 0, 1], cls: 4 },
    ]);
  });

  it('a split class shows up as conflicts, and merging fixes it', () => {
    const t = penroseTiling;
    let rs = derivedRuleSet(t);
    // Give the thin tile's first leg a class of its own.
    rs = setEdgeClass(rs, 'thin', 0, 9);
    const v = validateRuleSet(t, rs);
    expect(v.ok).toBe(false);
    expect(v.conflicts.every((c) => c.kind === 'class')).toBe(true);
    const fixed = mergeConflictingClasses(rs, v);
    expect(validateRuleSet(t, fixed).ok).toBe(true);
    expect(ruleSetClasses(fixed)).toEqual(ruleSetClasses(derivedRuleSet(t)));
  });

  it('join / split edit seams', () => {
    let rs = derivedRuleSet(hexTiling, 'edges');
    rs = joinWithNext(rs, 'Delta', 0, 6);
    expect(rs.seams.Delta[0].edges).toEqual([0, 1]);
    rs = splitBefore(rs, 'Delta', 1);
    expect(rs.seams.Delta.slice(0, 2).map((s) => s.edges)).toEqual([[0], [1]]);
    rs = setEdgeClass(rs, 'Delta', 5, null);
    expect(rs.seams.Delta.some((s) => s.edges.includes(5))).toBe(false);
  });
});

describe('refinement', () => {
  it('the refined chair has a slot per child and more classes than the plain one', () => {
    const spec = refineSpec(chairSpec);
    const t = similarityTiling(spec);
    expect(t.prototiles.length).toBe(4);
    const adj = computeAdjacency(t, t.generate(5, t.defaultRoot));
    expect(adj.anomalies).toBe(0);
    const rs = derivedRuleSet(t, 'edges');
    expect(ruleSetClasses(rs).length).toBeGreaterThan(1);
    expect(validateRuleSet(t, rs).ok).toBe(true);
  });
});

describe('circuits', () => {
  it('rule 15 on hexagons closes everything away from the boundary', () => {
    const t = hexTiling;
    const rs = preset(t);
    const r = computeCircuits({ tiling: t, ruleSet: rs, instances: t.generate(4, 'Delta'), selection: new Set([1, 5]), combo: {} });
    expect(r.oddTypes).toEqual([]);
    expect(r.tails).toBe(0);
    expect(r.circuits).toBeGreaterThan(0);
    // Every circuit of rule 15 has 3, 6 or 9 segments (CIRCUITS_15.md).
    for (const len of r.circuitLengths.keys()) expect([3, 6, 9]).toContain(len);
  });

  it('128-010100000 threads one arc through every tile of a Psi supertile (FASS_THEOREM.md)', () => {
    const t = hexTiling;
    for (const level of [2, 3, 4]) {
      const r = computeCircuits({
        tiling: t,
        ruleSet: preset(t),
        instances: t.generate(level, 'Psi'),
        selection: new Set([1, 2, 8]),
        combo: { Theta: 1, Xi: 1 },
      });
      expect(r.circuits, `level ${level}`).toBe(0);
      expect(r.paths.length, `level ${level}`).toBe(1);
      expect(r.paths[0].ends).toEqual(['boundary', 'boundary']);
    }
  });

  it('an odd selection leaves tails', () => {
    const t = hexTiling;
    const r = computeCircuits({ tiling: t, ruleSet: preset(t), instances: t.generate(3, 'Delta'), selection: new Set([1]), combo: {} });
    expect(r.oddTypes.length).toBeGreaterThan(0);
    expect(r.tails).toBeGreaterThan(0);
  });

  it('every chord belongs to exactly one path', () => {
    const t = spectreTiling;
    const r = computeCircuits({ tiling: t, ruleSet: preset(t), instances: t.generate(3, 'Delta'), selection: new Set([2, 5, 8]), combo: {} });
    const total = r.paths.reduce((s, p) => s + p.chords.length, 0);
    expect(total).toBe(r.chords.length);
    expect([...r.pathOfChord].every((p) => p >= 0)).toBe(true);
  });
});

describe('share strings', () => {
  it('round-trip', () => {
    const s = encodeShare([2, 5, 12], { Delta: 1, Theta: 0, Psi: 11 }, ['Delta', 'Theta', 'Psi']);
    expect(s).toBe('25c-10b');
    expect(decodeShare(s, ['Delta', 'Theta', 'Psi'])).toEqual({ selection: [2, 5, 12], combo: { Delta: 1, Theta: 0, Psi: 11 } });
  });
});
