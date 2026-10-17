import { describe, expect, it } from 'vitest';
import { BUILTIN_TILINGS } from '../tilings';
import { InfinitePlane } from '../infinite';
import { computeAdjacency } from '../ruleset';
import { computeCircuits, layChords } from '../circuits';
import { hexTiling } from '../tilings/spectre';
import { latticeTiling } from '../lattice';
import { LATTICE_PRESETS } from '../latticePresets';
import { pointKeyer, qkey } from '../polygon';
import { transPt } from '../geom';
import { prototile } from '../tiling';

const all = [...BUILTIN_TILINGS, ...LATTICE_PRESETS.map(latticeTiling)];

describe('infinite mode', () => {
  it('every tiling fills a window around the anchor, edge-to-edge', () => {
    for (const t of all) {
      const plane = new InfinitePlane(t, t.defaultRoot);
      const rect = { minX: -12, minY: -12, maxX: 12, maxY: 12 };
      const { instances } = plane.query(rect);
      expect(instances.length, t.id).toBeGreaterThan(20);
      expect(computeAdjacency(t, instances).anomalies, t.id).toBe(0);
      // The anchor itself is there, at the origin.
      expect(instances.some((i) => i.xform.every((v, k) => Math.abs(v - [1, 0, 0, 0, 1, 0][k]) < 1e-9)), t.id).toBe(true);
    }
  });

  it('tiles stay put as the view moves away and the chain grows', () => {
    for (const t of all) {
      const plane = new InfinitePlane(t, t.defaultRoot);
      const small = { minX: -4, minY: -4, maxX: 4, maxY: 4 };
      const key = (i: { type: string; xform: readonly number[] }) => `${i.type}@${qkey(transPt(i.xform as never, prototile(t, i.type).pts[0]))}`;
      const before = plane.query(small).instances.map(key);
      plane.query({ minX: 400, minY: 400, maxX: 420, maxY: 420 });
      const after = new Set(plane.query(small).instances.map(key));
      // Nothing moves: every tile seen before is still exactly where it was.
      for (const k of before) expect(after.has(k), `${t.id} ${k}`).toBe(true);
    }
  });

  it('every seed covers a big window without running out of levels', () => {
    for (const t of all) {
      for (let seed = 1; seed <= 6; seed++) {
        const q = new InfinitePlane(t, t.defaultRoot, seed).query({ minX: -60, minY: -45, maxX: 60, maxY: 45 }, 200_000);
        expect(q.truncated, `${t.id} seed ${seed}`).toBe(false);
        expect(q.levels, `${t.id} seed ${seed}`).toBeLessThan(40);
      }
    }
  });

  it('the window is covered with no gaps near its middle', () => {
    for (const t of all) {
      const plane = new InfinitePlane(t, t.defaultRoot);
      const { instances } = plane.query({ minX: 200, minY: -60, maxX: 230, maxY: -30 });
      const adj = computeAdjacency(t, instances);
      // A tile near the centre has a neighbour on every edge.
      const centre = { x: 215, y: -45 };
      const nearest = instances.reduce((b, i) => {
        const d = Math.hypot(i.xform[2] - centre.x, i.xform[5] - centre.y);
        return d < b.d ? { i, d } : b;
      }, { i: instances[0], d: Infinity }).i;
      expect(adj.neighbour[nearest.id].every((n) => n !== null), t.id).toBe(true);
    }
  });

  it('128-010100000 on infinite hexagons: no circuits, only lines leaving the window', () => {
    const plane = new InfinitePlane(hexTiling, 'Psi');
    const instances = plane.query({ minX: -40, minY: -40, maxX: 40, maxY: 40 }).instances;
    const rs = hexTiling.presets![0].build(hexTiling);
    const r = computeCircuits({ tiling: hexTiling, ruleSet: rs, instances, selection: new Set([1, 2, 8]), combo: { Theta: 1, Xi: 1 } });
    expect(r.circuits).toBe(0);
    expect(r.tails).toBe(0);
    expect(r.openLines).toBeGreaterThan(0);
  });

  it('a patch too big to trace still lays every chord, untraced', () => {
    const plane = new InfinitePlane(hexTiling, 'Psi');
    const instances = plane.query({ minX: -30, minY: -30, maxX: 30, maxY: 30 }).instances;
    const rs = hexTiling.presets![0].build(hexTiling);
    const input = { tiling: hexTiling, ruleSet: rs, instances, selection: new Set([1, 5]), combo: {} };
    const full = computeCircuits(input);
    const laid = layChords(input);
    expect(full.traced).toBe(true);
    expect(laid.traced).toBe(false);
    expect(laid.paths).toHaveLength(0);
    expect(laid.chords).toEqual(full.chords);
  });

  it('point keys agree far from the origin and fall back to strings past their range', () => {
    const key = pointKeyer({ x: 1e5, y: -1e5 });
    expect(key(1e5 + 0.1234, -1e5 + 2)).toBe(key(1e5 + 0.12341, -1e5 + 2.00001));
    expect(typeof key(1e5 + 1, -1e5)).toBe('number');
    expect(typeof key(1e5 + 1e5, -1e5)).toBe('string');
    expect(key(1e5 + 1e5, -1e5)).toBe(key(1e5 + 1e5 + 1e-5, -1e5));
  });
});
