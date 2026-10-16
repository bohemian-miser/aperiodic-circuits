import { describe, expect, it } from 'vitest';
import { hexTiling } from '../tilings/spectre';
import { SPECTRE_TYPES } from '../chain';
import { SPECTRE_HEX_SIDES, SidesSystem, gluesOf, refineSidesSpec, slotFromXform, type SidesSpec } from '../sides';
import { mul, transPt, type Affine } from '../geom';
import { computeAdjacency, derivedRuleSet, validateRuleSet } from '../ruleset';
import { tilingFromSpec } from '../tilings';
import { InfinitePlane } from '../infinite';

/** Leaves of the built-in hexagons with no per-level mirror correction. */
function builtinLeaves(type: string, level: number): { type: string; x: Affine }[] {
  const out: { type: string; x: Affine }[] = [];
  const go = (t: string, l: number, M: Affine) => {
    if (l === 0) return void out.push({ type: t, x: M });
    for (const k of hexTiling.hierarchy!.children(t, l)) go(k.type, l - 1, mul(M, k.xform));
  };
  go(type, level, [1, 0, 0, 0, 1, 0]);
  return out;
}

describe('side-glued substitutions', () => {
  it('the grid picture is the built-in level-1 supertile', () => {
    const kids = hexTiling.hierarchy!.children('Delta', 1);
    const origin = transPt(kids[0].xform, { x: 0.5, y: Math.sqrt(3) / 2 });
    expect(kids.map((k) => slotFromXform(k.xform, origin))).toEqual(SPECTRE_HEX_SIDES.slots);
  });

  it('the glued sides read off level 1 are the FASS gluing table G', () => {
    // FASS_THEOREM.md §2: the same 13 pairs for every type; Gamma lacks the two through slot 2.
    const G = [[0,0,7,1],[0,5,1,1],[1,0,7,2],[1,3,2,0],[1,4,3,0],[1,5,4,0],[2,5,3,1],[3,5,4,1],[4,3,5,0],[4,4,6,0],[4,5,7,3],[5,5,6,1],[6,5,7,4]];
    for (const t of SPECTRE_TYPES) {
      const got = gluesOf(SPECTRE_HEX_SIDES, t).map((g) => [g.a, g.ea, g.b, g.eb]);
      expect(got, t).toEqual(t === 'Gamma' ? G.filter(([a, , b]) => a !== 2 && b !== 2) : G);
    }
  });

  it('gluing sides rebuilds the Spectre hexagons tile for tile, levels 1 to 5', () => {
    const sys = new SidesSystem(SPECTRE_HEX_SIDES);
    expect(sys.check(5)).toEqual([]);
    for (const lv of [1, 2, 3, 4, 5]) {
      for (const t of SPECTRE_TYPES) {
        const a = sys.leaves(t, lv);
        const b = builtinLeaves(t, lv);
        expect(a.length, `${t} ${lv}`).toBe(b.length);
        // Same tiles in the same order, up to one shift of the whole supertile.
        const dx = a[0].xform[2] - b[0].x[2];
        const dy = a[0].xform[5] - b[0].x[5];
        let off = 0;
        a.forEach((l, i) => {
          const y = b[i];
          const same =
            l.type === y.type &&
            [0, 1, 3, 4].every((k) => Math.abs(l.xform[k] - y.x[k]) < 1e-9) &&
            Math.abs(l.xform[2] - y.x[2] - dx) < 1e-6 &&
            Math.abs(l.xform[5] - y.x[5] - dy) < 1e-6;
          if (!same) off++;
        });
        expect(off, `${t} level ${lv}`).toBe(0);
      }
    }
  });

  it('wrong corners are caught, not drawn', () => {
    const bad: SidesSpec = { ...SPECTRE_HEX_SIDES, corners: { ...SPECTRE_HEX_SIDES.corners, Delta: [[7, 0], [5, 4], [5, 2], [3, 3], [2, 2], [0, 3]] } };
    expect(new SidesSystem(bad).check(3).length).toBeGreaterThan(0);
  });

  it('hands off like any tiling: edge-to-edge, consistent numbering, infinite mode, refinement', () => {
    for (const s of [SPECTRE_HEX_SIDES, refineSidesSpec(SPECTRE_HEX_SIDES)]) {
      const t = tilingFromSpec({ ...s, id: `${s.id}-t` });
      const adj = computeAdjacency(t, t.generate(3, t.defaultRoot));
      expect(adj.anomalies).toBe(0);
      expect(validateRuleSet(t, derivedRuleSet(t), adj).ok).toBe(true);
      const q = new InfinitePlane(t, t.defaultRoot).query({ minX: -20, minY: -20, maxX: 20, maxY: 20 });
      expect(computeAdjacency(t, q.instances).anomalies).toBe(0);
    }
  });
});
