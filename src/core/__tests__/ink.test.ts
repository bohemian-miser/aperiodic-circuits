import { describe, expect, it } from 'vitest';
import { InfinitePlane } from '../infinite';
import { computeAdjacency } from '../ruleset';
import { computeCircuits } from '../circuits';
import { CircuitInk } from '../ink';
import { analyzeParity } from '../parity';
import { defaultRuleSet } from '../../store';
import { getTiling } from '../tilings';
import { circuitLengthColor } from '../../colors';

describe('circuit ink', () => {
  it('keeps a circuit coloured when a regrown patch only holds part of it', () => {
    const t = getTiling('hex')!;
    const rs = defaultRuleSet(t);
    const selection = new Set(analyzeParity(t, rs, 64).selections.find((s) => s.length > 0)!);
    const plane = new InfinitePlane(t, t.defaultRoot);
    const trace = (r: { minX: number; minY: number; maxX: number; maxY: number }) => {
      const { instances } = plane.query(r);
      return computeCircuits({ tiling: t, ruleSet: rs, instances, selection, combo: {}, adjacency: computeAdjacency(t, instances) });
    };
    const big = trace({ minX: -20, minY: -20, maxX: 20, maxY: 20 });
    const ink = new CircuitInk();
    ink.remember(big);
    expect(ink.size).toBeGreaterThan(0);
    const lengthAt = new Map<string, number>();
    big.paths.forEach((p) => p.closed && p.chords.forEach((i) => lengthAt.set(`${big.chords[i].c.x.toFixed(3)},${big.chords[i].c.y.toFixed(3)}`, p.chords.length)));

    // A window off to one side: circuits cut by its edge trace as open lines.
    const part = trace({ minX: 8, minY: -4, maxX: 28, maxY: 4 });
    let recovered = 0;
    part.chords.forEach((ch, i) => {
      if (part.paths[part.pathOfChord[i]].closed) return;
      const want = lengthAt.get(`${ch.c.x.toFixed(3)},${ch.c.y.toFixed(3)}`);
      if (want === undefined) return;
      expect(ink.length(ch)).toBe(want);
      recovered++;
    });
    expect(recovered).toBeGreaterThan(0);
  });

  it('ranks the first patch in length order and holds every rank after', () => {
    const ink = new CircuitInk();
    const patch = (lengths: number[]) => ({ circuitLengths: new Map(lengths.map((l) => [l, 1])), paths: [], chords: [] }) as never;
    ink.remember(patch([9, 3, 6]));
    expect([3, 6, 9].map((l) => ink.rank(l))).toEqual([0, 1, 2]);
    // A view with only some of them, and a new one: nothing moves.
    ink.remember(patch([12, 6]));
    expect([3, 6, 9, 12].map((l) => ink.rank(l))).toEqual([0, 1, 2, 3]);
  });

  it('a circuit seen again is not kept twice', () => {
    const ink = new CircuitInk();
    const chords = [0, 1, 2].map((k) => ({ c: { x: k, y: 0 } }));
    ink.keep(chords, 3);
    const v = ink.version;
    ink.keep([chords[2], chords[0], chords[1]], 3);
    expect(ink.version).toBe(v);
    expect(ink.size).toBe(3);
    expect(ink.length({ c: { x: 1, y: 0 } })).toBe(3);
  });

  it('colours a length the same however many others are on screen', () => {
    expect(circuitLengthColor(6)).toBe(circuitLengthColor(6));
    expect(circuitLengthColor(6)).not.toBe(circuitLengthColor(9));
    expect(circuitLengthColor(6)).toMatch(/^hsl\(/);
  });
});
