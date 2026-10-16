import { describe, expect, it } from 'vitest';
import { CHAIN_PRESETS, chainTiling, checkChain, refineChainSpec, spectreChainSpec, type ChainSpec } from '../chain';
import { computeAdjacency, derivedRuleSet, validateRuleSet } from '../ruleset';
import { hexTiling, spectreTiling } from '../tilings/spectre';
import { tilingFromSpec, validateTilingSpec } from '../tilings';
import { InfinitePlane } from '../infinite';

describe('chain substitutions', () => {
  it('the lab presets fit to level 3 for every type', () => {
    for (const p of CHAIN_PRESETS) {
      expect(validateTilingSpec(p), p.id).toEqual([]);
      expect(checkChain(p, 3).firstBad, p.id).toBeNull();
    }
  });

  it('the Spectre presets are exactly the built-in tilings', () => {
    for (const [preset, builtin] of [
      [CHAIN_PRESETS[0], hexTiling],
      [CHAIN_PRESETS[1], spectreTiling],
    ] as const) {
      const a = chainTiling(preset).generate(3, 'Psi');
      const b = builtin.generate(3, 'Psi');
      expect(a.length).toBe(b.length);
      a.forEach((x, i) => {
        expect(x.type).toBe(b[i].type);
        x.xform.forEach((v, k) => expect(v).toBeCloseTo(b[i].xform[k], 9));
      });
    }
  });

  it('breaking the chain is caught', () => {
    const hex = spectreChainSpec('hex');
    const broken: ChainSpec[] = [
      { ...hex, steps: hex.steps.map((s, i) => (i === 3 ? { ...s, flip: true } : s)) },
      { ...hex, mirror: false },
      { ...hex, superQuad: [[6, 2], [5, 1], [3, 2], [1, 1]] },
      { ...hex, steps: [...hex.steps, { turn: 60, from: 3, to: 1 }] },
    ];
    for (const s of broken) {
      const bad = checkChain(s, 3).firstBad;
      expect(bad).not.toBeNull();
      expect(bad!).toBeLessThanOrEqual(2);
    }
  });

  it('children that overlap without any edges crossing are still caught', () => {
    // Flipping slot 4 of the hexagon chain slides it half over slot 3 at level 1.
    const hex = spectreChainSpec('hex');
    const s = { ...hex, steps: hex.steps.map((st, i) => (i === 3 ? { ...st, flip: true } : st)) };
    const lv1 = checkChain(s, 1).perType.Delta[0];
    expect(lv1.overlaps).toBeGreaterThan(0);
  });

  it('lab chains hand off: edge-to-edge, consistent derived numbering, infinite mode', () => {
    for (const p of [CHAIN_PRESETS[2], refineChainSpec(CHAIN_PRESETS[2])]) {
      const t = tilingFromSpec({ ...p, id: `${p.id}-x` });
      const adj = computeAdjacency(t, t.generate(3, t.defaultRoot));
      expect(adj.anomalies, p.id).toBe(0);
      expect(validateRuleSet(t, derivedRuleSet(t), adj).ok, p.id).toBe(true);
      const q = new InfinitePlane(t, t.defaultRoot).query({ minX: -20, minY: -20, maxX: 20, maxY: 20 });
      expect(computeAdjacency(t, q.instances).anomalies, p.id).toBe(0);
    }
  });
});
